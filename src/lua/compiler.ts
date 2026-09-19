/**
 * ReVeil Lua → ReVeil bytecode compiler.
 *
 * The VM is a stack machine: slots 1..slotTop hold the live locals and anything
 * above them is a temporary. The compiler tracks the exact stack height at
 * compile time, which is why the runtime executes without bounds bookkeeping.
 *
 * Jumps use symbolic labels that are resolved into relative word offsets once a
 * function has been fully compiled.
 */

import { ReVeilError } from "../core/errors";
import type { ReVeilRandom } from "../core/rng";
import type {
  AssignmentTarget,
  Block,
  CallExpression,
  Chunk,
  Expression,
  FunctionExpression,
  Statement,
  TableField,
} from "./ast";
import { OP, OP_ARITY, type Instruction, type OpName, type Program, type Proto } from "./bytecode";
import type { FnScope, ResolveResult } from "./resolve";

export interface CompileStats {
  protos: number;
  instructions: number;
  /** The program needs the runtime's presized-table helper. */
  presize: boolean;
}

export interface CompileOptions {
  /** When false, `goto`/labels raise a clear error instead of compiling. */
  allowGoto?: boolean;
}

interface LocalInfo {
  slot: number;
  cell: boolean;
}

interface LoopContext {
  breakLabel: number;
  continueLabel: number;
  /** Stack height the runtime must be at when arriving at either label. */
  breakSp: number;
  continueSp: number;
}

interface PendingJump {
  instruction: number;
  operandIndex: number;
  label: number;
  /** Stack height the jump expects at the target (sanity check). */
  sp: number;
  /** Set for named goto/label jumps, which are validated strictly. */
  name?: string;
}

export function compileChunk(
  chunk: Chunk,
  resolve: ResolveResult,
  rng: ReVeilRandom,
  options: CompileOptions = {},
): { program: Program; stats: CompileStats } {
  const program = new ProgramCompiler(resolve, rng, options);
  const entry = program.compileEntry(chunk);
  const stats = program.stats();
  return { program: program.toProgram(entry), stats };
}

class ProgramCompiler {
  /** Set when a table constructor needs an exactly sized array part. */
  usesPresize = false;
  readonly protos: Proto[] = [];
  readonly strings: string[] = [];
  readonly numbers: number[] = [];
  private readonly stringMap = new Map<string, number>();

  constructor(
    readonly resolve: ResolveResult,
    private readonly rng: ReVeilRandom,
    private readonly options: CompileOptions,
  ) {}

  internNumber(value: number): number {
    const index = this.numbers.length + 1;
    this.numbers.push(value);
    return index;
  }

  intern(value: string): number {
    const existing = this.stringMap.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.strings.length + 1;
    this.strings.push(value);
    this.stringMap.set(value, index);
    return index;
  }

  newProto(name: string, params: number, vararg: boolean): Proto {
    const proto: Proto = {
      params,
      vararg,
      updesc: [],
      code: [],
      maxSlots: Math.max(params + 4, 8),
      name,
    };
    this.protos.push(proto);
    return proto;
  }

  protoIndex(proto: Proto): number {
    return this.protos.indexOf(proto) + 1;
  }

  scopeFor(node: object): FnScope | undefined {
    return this.resolve.scopes.get(node);
  }

  isCaptured(name: string): boolean {
    return this.resolve.captured.has(name);
  }

  compileEntry(chunk: Chunk): number {
    const compiler = new FnCompiler(this, null, this.resolve.rootScope, "main", [], true, this.options);
    compiler.compileStatements(chunk.block);
    compiler.finishProto();
    return this.protoIndex(compiler.proto);
  }

  stats(): CompileStats {
    return {
      protos: this.protos.length,
      instructions: this.protos.reduce((total, proto) => total + proto.code.length, 0),
      presize: this.usesPresize,
    };
  }

  toProgram(entry: number): Program {
    return { protos: this.protos, strings: this.strings, numbers: this.numbers, entry };
  }

  random(): ReVeilRandom {
    return this.rng;
  }
}

class FnCompiler {
  readonly proto: Proto;
  private readonly locals = new Map<string, LocalInfo>();
  private readonly upvalues = new Map<string, number>();
  private slotTop = 0;
  private sp = 0;
  private readonly scopeStack: Array<{ slotTop: number; names: string[] }> = [];
  private readonly loops: LoopContext[] = [];
  private readonly labels = new Map<string, number>();
  private readonly labelSp = new Map<number, number>();
  private readonly pending: PendingJump[] = [];
  private labelCounter = 0;

  constructor(
    private readonly program: ProgramCompiler,
    private readonly parent: FnCompiler | null,
    private readonly scope: FnScope,
    name: string,
    params: string[],
    vararg: boolean,
    private readonly options: CompileOptions,
  ) {
    this.proto = program.newProto(name, params.length, vararg);
    this.slotTop = params.length;
    this.sp = params.length;
    params.forEach((param, index) => {
      const info = this.declareAt(param, index + 1);
      if (info.cell) {
        // The VM hands parameters over as plain values: box them for closures.
        this.emit(OP.CELLSET, info.slot, info.slot);
      }
    });
    this.pushScope();
  }

  // ------------------------------------------------------------- primitives

  private emit(op: OpName, ...operands: number[]): number {
    this.proto.code.push([op, ...operands] as Instruction);
    return this.proto.code.length - 1;
  }

  private newLabel(): number {
    this.labelCounter += 1;
    return this.labelCounter;
  }

  /**
   * Marks the current position as a jump target. Jumps never rely on the
   * target restoring the stack: their own SETTOP (emitted when the heights
   * differ) is the single source of truth, which keeps every path converging.
   */
  private place(label: number): void {
    this.labels.set(label.toString(), this.proto.code.length);
    this.labelSp.set(label, this.sp);
  }

  /**
   * Emits a jump. `targetSp` is the compile-time stack height expected at the
   * target and is used to validate control flow during finalisation.
   */
  private jump(op: OpName, label: number, targetSp = this.sp, name?: string): number {
    if (targetSp !== this.sp) {
      // Leaving a scope (break/continue/loop back edge): the runtime stack must
      // shrink to the height the target expects before the jump happens.
      this.emit(OP.SETTOP, targetSp);
      this.sp = targetSp;
    }
    const instruction = this.emit(op, 0);
    this.pending.push({ instruction, operandIndex: 1, label, sp: targetSp, name });
    return instruction;
  }

  private push(count = 1): void {
    this.sp += count;
    if (this.sp + 4 > this.proto.maxSlots) {
      this.proto.maxSlots = this.sp + 8;
    }
  }

  private pop(count = 1): void {
    this.sp -= count;
    if (this.sp < this.slotTop) {
      throw new ReVeilError("internal compiler error: Lua stack underflow", "LUA_COMPILER");
    }
  }

  finishProto(): void {
    const last = this.proto.code[this.proto.code.length - 1];
    if (!last || last[0] !== OP.RET) {
      this.emit(OP.RET, 0, 0);
    }
    this.resolvePending();
  }

  private resolvePending(): void {
    const words: number[] = new Array(this.proto.code.length);
    let word = 1;
    for (let index = 0; index < this.proto.code.length; index += 1) {
      words[index] = word;
      word += 1 + OP_ARITY[this.proto.code[index][0]];
    }
    for (const jump of this.pending) {
      const key = jump.label.toString();
      const target = this.labels.get(key);
      if (target === undefined) {
        throw new ReVeilError("Lua syntax error: jump to an undefined label", "LUA_SYNTAX");
      }
      const expectedSp = this.labelSp.get(jump.label);
      if (jump.name !== undefined && expectedSp !== undefined && expectedSp !== jump.sp) {
        throw new ReVeilError(
          "goto/label crossing a local scope boundary is not supported by the ReVeil VM",
          "LUA_COMPILER",
        );
      }
      const instruction = this.proto.code[jump.instruction];
      const from = words[jump.instruction] + 1 + jump.operandIndex;
      instruction[jump.operandIndex] = words[target] - from;
    }
    this.pending.length = 0;
  }

  // ----------------------------------------------------------------- scopes

  private pushScope(): void {
    this.scopeStack.push({ slotTop: this.slotTop, names: [] });
  }

  private popScope(): void {
    const frame = this.scopeStack.pop();
    if (!frame) {
      throw new ReVeilError("internal compiler error: scope stack underflow", "LUA_COMPILER");
    }
    for (const name of frame.names) {
      this.locals.delete(name);
    }
    this.slotTop = frame.slotTop;
    this.sp = Math.max(this.sp, this.slotTop);
    this.sp = this.slotTop;
  }

  /** Allocates a fresh local slot on top of the stack. */
  private allocateLocal(name: string): LocalInfo {
    this.slotTop += 1;
    this.sp = this.slotTop;
    const info: LocalInfo = { slot: this.slotTop, cell: this.program.isCaptured(name) };
    this.locals.set(name, info);
    const frame = this.scopeStack[this.scopeStack.length - 1];
    if (frame) {
      frame.names.push(name);
    }
    return info;
  }

  /** Maps an existing slot (parameters, loop variables) onto a name. */
  private declareAt(name: string, slot: number): LocalInfo {
    const info: LocalInfo = { slot, cell: this.program.isCaptured(name) };
    this.locals.set(name, info);
    const frame = this.scopeStack[this.scopeStack.length - 1];
    if (frame) {
      frame.names.push(name);
    }
    return info;
  }

  private lookup(name: string):
    | { kind: "local"; info: LocalInfo }
    | { kind: "upvalue"; index: number }
    | { kind: "env" }
    | { kind: "global" } {
    if (name === "_ENV") {
      return { kind: "env" };
    }
    const local = this.locals.get(name);
    if (local) {
      return { kind: "local", info: local };
    }
    const upvalue = this.upvalues.get(name);
    if (upvalue !== undefined) {
      return { kind: "upvalue", index: upvalue };
    }
    return { kind: "global" };
  }

  registerUpvalue(name: string, index: number): void {
    this.upvalues.set(name, index);
  }

  // ------------------------------------------------------------ expressions

  /** Pushes exactly one value. */
  compileExpr(expression: Expression): void {
    switch (expression.type) {
      case "Identifier": {
        const resolved = this.lookup(expression.name);
        if (resolved.kind === "local") {
          this.emit(resolved.info.cell ? OP.LOADC : OP.LOADL, resolved.info.slot);
        } else if (resolved.kind === "upvalue") {
          this.emit(OP.LOADU, resolved.index);
        } else if (resolved.kind === "env") {
          this.emit(OP.LOADENV);
        } else {
          this.emit(OP.LOADG, this.program.intern(expression.name));
        }
        this.push();
        return;
      }
      case "NumberLiteral": {
        const value = normalizeNumber(expression.value);
        if (expression.isFloat && Number.isInteger(value)) {
          // 1e3 / 1.0 must stay a float at runtime.
          this.emit(OP.LOADF, this.program.internNumber(value));
        } else {
          this.emit(OP.LOADK, value);
        }
        this.push();
        return;
      }
      case "StringLiteral": {
        this.emit(OP.LOADSTR, this.program.intern(expression.value));
        this.push();
        return;
      }
      case "BooleanLiteral": {
        this.emit(OP.LOADBOOL, expression.value ? 1 : 0);
        this.push();
        return;
      }
      case "NilLiteral": {
        this.emit(OP.LOADNIL);
        this.push();
        return;
      }
      case "VarargLiteral": {
        this.requireVararg();
        this.emit(OP.VARARG, this.sp + 1, 1);
        this.push();
        return;
      }
      case "TableConstructor":
        this.compileTableConstructor(expression.fields);
        return;
      case "BinaryExpression": {
        if (expression.operator === "and" || expression.operator === "or") {
          const done = this.newLabel();
          this.compileExpr(expression.left);
          this.jump(expression.operator === "and" ? OP.JFK : OP.JTK, done);
          this.emit(OP.POP);
          this.pop();
          this.compileExpr(expression.right);
          this.place(done);
          return;
        }
        this.compileExpr(expression.left);
        this.compileExpr(expression.right);
        this.emit(binaryOpcode(expression.operator));
        this.pop();
        return;
      }
      case "UnaryExpression": {
        this.compileExpr(expression.argument);
        this.emit(unaryOpcode(expression.operator));
        return;
      }
      case "MemberExpression": {
        this.compileExpr(expression.base);
        if (expression.computed) {
          this.compileExpr(expression.indexer as Expression);
          this.emit(OP.GETI);
          this.pop();
        } else {
          this.emit(OP.GETS, this.program.intern(expression.key));
        }
        return;
      }
      case "CallExpression": {
        this.compileCall(expression, 1);
        return;
      }
      case "FunctionExpression": {
        this.compileClosure(expression);
        return;
      }
      case "IfExpression": {
        const done = this.newLabel();
        for (const clause of expression.clauses) {
          this.compileExpr(clause.condition);
          const skip = this.newLabel();
          this.pop();
          this.jump(OP.JF, skip);
          this.compileExpr(clause.value);
          this.jump(OP.JMP, done);
          this.place(skip);
        }
        this.compileExpr(expression.elseValue);
        this.place(done);
        return;
      }
      case "InterpolatedString": {
        const parts = expression.parts;
        if (parts.length === 0) {
          this.emit(OP.LOADSTR, this.program.intern(""));
          this.push();
          return;
        }
        parts.forEach((part, index) => {
          if (part.kind === "text") {
            this.emit(OP.LOADSTR, this.program.intern(part.value));
            this.push();
            return;
          }
          this.compileExpr(part.expression);
          if (index < parts.length - 1) {
            // Interpolation converts every value to a string (Luau semantics).
            this.emit(OP.LOADSTR, this.program.intern(""));
            this.push();
            this.emit(OP.CONCAT);
            this.pop();
          }
        });
        for (let index = 1; index < parts.length; index += 1) {
          this.emit(OP.CONCAT);
          this.pop();
        }
        return;
      }
      default:
        throw new ReVeilError(`unsupported expression '${(expression as { type: string }).type}'`, "LUA_COMPILER");
    }
  }

  /** Pushes `want` values (`-1` = every result of a call / `...`). */
  compileExprMulti(expression: Expression, want: number): void {
    if (want === 1) {
      this.compileExpr(expression);
      return;
    }
    // Only a bare call or `...` expands to several values. `(f())` is exactly one.
    const expands = expression.parenthesized !== true;
    if (expands && expression.type === "CallExpression") {
      this.compileCall(expression, want);
      return;
    }
    if (expands && expression.type === "VarargLiteral") {
      this.requireVararg();
      const base = this.sp + 1;
      this.emit(OP.VARARG, base, want);
      // want < 0 pushes an unbounded number of values: the call sites treat it
      // like a call result and only rely on the stack pointer being sane.
      this.sp = want < 0 ? base : base + want - 1;
      return;
    }
    this.compileExpr(expression);
    if (want > 1) {
      for (let index = 1; index < want; index += 1) {
        this.emit(OP.LOADNIL);
        this.push();
      }
    }
  }

  private requireVararg(): void {
    if (!this.proto.vararg) {
      throw new ReVeilError("cannot use '...' outside a vararg function", "LUA_COMPILER");
    }
  }

  private compileTableConstructor(fields: TableField[]): void {
    // A constructor that contains explicit holes gets its array part sized up
    // front, exactly like Lua's SETLIST does, so `#table` picks the same border.
    const arrayFields = fields.filter((field) => field.kind === "array");
    const lastField = fields[fields.length - 1];
    const trailingMulti =
      lastField !== undefined &&
      lastField.kind === "array" &&
      lastField.value.parenthesized !== true &&
      (lastField.value.type === "CallExpression" || lastField.value.type === "VarargLiteral");
    const holey =
      !trailingMulti && arrayFields.some((field) => field.kind === "array" && field.value.type === "NilLiteral");
    if (trailingMulti || holey) {
      this.program.usesPresize = true;
    }

    if (holey) {
      this.emit(OP.NEWA, arrayFields.length);
    } else {
      this.emit(OP.NEWT);
    }
    this.push();
    const tableSlot = this.sp;
    let arrayIndex = 1;

    fields.forEach((field, index) => {
      const isLast = index === fields.length - 1;
      switch (field.kind) {
        case "array": {
          if (isLast) {
            this.compileExprMulti(field.value, -1);
            this.emit(OP.APPENDMAT, tableSlot, arrayIndex);
            this.sp = tableSlot;
          } else {
            this.compileExpr(field.value);
            this.emit(OP.APPENDAT, tableSlot, arrayIndex);
            this.pop();
            arrayIndex += 1;
          }
          return;
        }
        case "record": {
          this.compileExpr(field.value);
          this.emit(OP.SETSAT, tableSlot, this.program.intern(field.key));
          this.pop();
          return;
        }
        case "computed": {
          this.compileExpr(field.key);
          this.compileExpr(field.value);
          this.emit(OP.SETIAT, tableSlot);
          this.pop(2);
          return;
        }
        default:
          return;
      }
    });

    if (this.sp !== tableSlot) {
      throw new ReVeilError("internal compiler error: table constructor imbalance", "LUA_COMPILER");
    }
  }

  private compileCall(expression: CallExpression, nres: number): void {
    const base = this.sp + 1;
    this.compileExpr(expression.base);
    if (expression.method) {
      this.emit(OP.SELF, this.program.intern(expression.method));
      this.push();
    }
    expression.args.forEach((arg, index) => {
      const isLast = index === expression.args.length - 1;
      this.compileExprMulti(arg, isLast ? -1 : 1);
    });
    this.emit(OP.CALL, base, nres);
    this.sp = base - 1;
    this.push(nres === -1 ? 1 : nres);
  }

  /** Compiles the nested function and returns its (finished) scope + proto. */
  private compileClosurePrototype(expression: FunctionExpression): { scope: FnScope; proto: Proto; upvals: string[] } {
    const childScope = this.program.scopeFor(expression);
    if (!childScope) {
      throw new ReVeilError("internal compiler error: function scope missing", "LUA_COMPILER");
    }
    const child = new FnCompiler(
      this.program,
      this,
      childScope,
      expression.name ?? "fn",
      expression.params,
      expression.vararg,
      this.options,
    );
    childScope.upvals.forEach((name, index) => child.registerUpvalue(name, index + 1));
    child.compileStatements(expression.body);
    child.finishProto();
    return { scope: childScope, proto: child.proto, upvals: childScope.upvals };
  }

  /** Translates a child scope's upvalue names into capture descriptors. */
  private buildUpvalueDescriptors(names: string[]): number[] {
    const descriptors: number[] = [];
    for (const name of names) {
      const local = this.locals.get(name);
      if (local) {
        if (!local.cell) {
          throw new ReVeilError(`internal compiler error: captured local '${name}' is not a cell`, "LUA_COMPILER");
        }
        descriptors.push(local.slot);
        continue;
      }
      const upvalue = this.upvalues.get(name);
      if (upvalue === undefined) {
        throw new ReVeilError(`internal compiler error: unresolved upvalue '${name}'`, "LUA_COMPILER");
      }
      descriptors.push(-upvalue);
    }
    return descriptors;
  }

  private compileClosure(expression: FunctionExpression): void {
    const child = this.compileClosurePrototype(expression);
    child.proto.updesc = this.buildUpvalueDescriptors(child.upvals);
    this.emit(OP.CLOSURE, this.program.protoIndex(child.proto));
    this.push();
  }

  // ------------------------------------------------------------- statements

  compileStatements(block: Block): void {
    this.pushScope();
    for (const statement of block.statements) {
      this.compileStatement(statement);
      // Statement boundaries always run at `slotTop`: any temporary a
      // statement left behind is dropped so the runtime stack pointer and the
      // compiler's view stay in lockstep.
      if (this.sp !== this.slotTop) {
        this.emit(OP.SETTOP, this.slotTop);
        this.sp = this.slotTop;
      }
    }
    // Leaving the block releases its locals: drop the runtime stack pointer too.
    const outerHeight = this.scopeStack[this.scopeStack.length - 1].slotTop;
    this.emit(OP.SETTOP, outerHeight);
    this.popScope();
  }

  /** Materialises `count` hidden slots (loop control slots, loop variables). */
  private reserveSlots(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.emit(OP.LOADNIL);
      this.slotTop += 1;
      this.sp = this.slotTop;
    }
  }

  private compileStatement(statement: Statement): void {
    switch (statement.type) {
      case "LocalStatement":
        this.compileLocalDeclaration(statement.names, statement.exprs);
        return;
      case "AssignmentStatement":
        this.compileAssignment(statement.targets, statement.exprs);
        return;
      case "CompoundAssignmentStatement":
        this.compileCompoundAssignment(statement);
        return;
      case "CallStatement":
        this.compileCall(statement.call, 0);
        return;
      case "FunctionDeclaration":
        this.compileFunctionDeclaration(statement);
        return;
      case "DoStatement":
        this.compileStatements(statement.body);
        return;
      case "IfStatement": {
        const done = this.newLabel();
        for (const clause of statement.clauses) {
          this.compileExpr(clause.condition);
          const skip = this.newLabel();
          this.pop();
          this.jump(OP.JF, skip);
          this.compileStatements(clause.body);
          this.jump(OP.JMP, done);
          this.place(skip);
        }
        if (statement.elseBody) {
          this.compileStatements(statement.elseBody);
        }
        this.place(done);
        return;
      }
      case "WhileStatement": {
        const start = this.newLabel();
        const done = this.newLabel();
        const height = this.slotTop;
        const loop: LoopContext = { breakLabel: done, continueLabel: start, breakSp: height, continueSp: height };
        this.place(start);
        this.compileExpr(statement.condition);
        this.pop();
        this.jump(OP.JF, done);
        this.loops.push(loop);
        this.compileStatements(statement.body);
        this.loops.pop();
        this.jump(OP.JMP, start);
        this.place(done);
        return;
      }
      case "RepeatStatement": {
        const start = this.newLabel();
        const conditionLabel = this.newLabel();
        const done = this.newLabel();
        const outerHeight = this.slotTop;
        this.place(start);
        // Locals declared in the body stay visible to the until-condition.
        this.pushScope();
        const bodyHeight = this.slotTop;
        const loop: LoopContext = {
          breakLabel: done,
          continueLabel: conditionLabel,
          breakSp: outerHeight,
          continueSp: bodyHeight,
        };
        this.loops.push(loop);
        for (const inner of statement.body.statements) {
          this.compileStatement(inner);
          if (this.sp !== this.slotTop) {
            this.emit(OP.SETTOP, this.slotTop);
            this.sp = this.slotTop;
          }
        }
        this.place(conditionLabel);
        this.compileExpr(statement.condition);
        this.pop();
        // `until` loops again while the condition is false. The conditional
        // jump must run at the body height (it consumes the value), so the
        // scope restore happens on the explicit paths below.
        const again = this.newLabel();
        this.jump(OP.JF, again);
        this.jump(OP.JMP, done, outerHeight);
        // The `again` label is reached with the body's locals still live.
        this.sp = bodyHeight;
        this.place(again);
        this.popScope();
        this.loops.pop();
        this.jump(OP.JMP, start, outerHeight);
        this.place(done);
        return;
      }
      case "NumericForStatement":
        this.compileNumericFor(statement);
        return;
      case "GenericForStatement":
        this.compileGenericFor(statement);
        return;
      case "ReturnStatement": {
        const args = statement.args;
        if (args.length === 0) {
          this.emit(OP.RET, 0, 0);
          return;
        }
        const base = this.sp + 1;
        const last = args[args.length - 1];
        const lastIsMulti =
          last.parenthesized !== true && (last.type === "CallExpression" || last.type === "VarargLiteral");
        args.forEach((arg, index) => {
          const isLast = index === args.length - 1;
          this.compileExprMulti(arg, isLast && lastIsMulti ? -1 : 1);
        });
        this.emit(OP.RET, base, lastIsMulti ? -1 : args.length);
        this.sp = this.slotTop;
        return;
      }
      case "BreakStatement": {
        const loop = this.currentLoop("break");
        this.jump(OP.JMP, loop.breakLabel, loop.breakSp);
        return;
      }
      case "ContinueStatement": {
        const loop = this.currentLoop("continue");
        this.jump(OP.JMP, loop.continueLabel, loop.continueSp);
        return;
      }
      case "GotoStatement": {
        if (this.options.allowGoto === false) {
          throw new ReVeilError("'goto' is not supported by this preset", "LUA_COMPILER");
        }
        const label = this.labelId(statement.label);
        this.jump(OP.JMP, label, this.sp, statement.label);
        return;
      }
      case "LabelStatement": {
        this.place(this.labelId(statement.label));
        return;
      }
      default:
        throw new ReVeilError("unsupported statement in Lua compiler", "LUA_COMPILER");
    }
  }

  private labelId(name: string): number {
    const existing = this.labels.get(`n:${name}`);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.newLabel();
    this.labels.set(`n:${name}`, id);
    return id;
  }

  private currentLoop(action: string): LoopContext {
    const loop = this.loops[this.loops.length - 1];
    if (!loop) {
      throw new ReVeilError(`'${action}' used outside of a loop`, "LUA_COMPILER");
    }
    return loop;
  }

  private compileFunctionDeclaration(statement: Extract<Statement, { type: "FunctionDeclaration" }>): void {
    const func = statement.func;
    if (statement.isLocal && statement.target.type === "Identifier") {
      const name = statement.target.name;
      // Reserve the slot first so the function can reference itself.
      const info: LocalInfo = { slot: this.slotTop + 1, cell: this.program.isCaptured(name) };
      this.slotTop = info.slot;
      this.emit(OP.SETTOP, info.slot);
      this.sp = info.slot;
      this.locals.set(name, info);
      const frame = this.scopeStack[this.scopeStack.length - 1];
      if (frame) {
        frame.names.push(name);
      }
      if (info.cell) {
        this.emit(OP.CELLNEW, info.slot);
      }
      const child = this.compileClosurePrototype(func);
      child.proto.updesc = this.buildUpvalueDescriptors(child.upvals);
      this.emit(OP.MAKEF, info.slot, this.program.protoIndex(child.proto), info.cell ? 1 : 0);
      return;
    }
    if (statement.target.type === "MemberExpression") {
      const target = statement.target;
      this.compileExpr(target.base);
      const baseSlot = this.sp;
      let keySlot = 0;
      if (target.computed) {
        this.compileExpr(target.indexer as Expression);
        keySlot = this.sp;
      }
      this.compileExpr(func);
      if (target.computed) {
        this.emit(OP.LOADL, baseSlot);
        this.push();
        this.emit(OP.LOADL, keySlot);
        this.push();
        this.emit(OP.SETI);
        this.pop(3);
      } else {
        this.emit(OP.SETS, this.program.intern(target.key));
        this.pop(2);
      }
      return;
    }
    this.compileExpr(func);
    this.emit(OP.STOREG, this.program.intern(statement.target.name));
    this.pop();
  }

  private compileLocalDeclaration(names: string[], exprs: Expression[]): void {
    const base = this.sp + 1;
    if (exprs.length > 0) {
      exprs.forEach((expression, index) => {
        const isLast = index === exprs.length - 1;
        if (isLast) {
          const remaining = Math.max(names.length - index, 1);
          this.compileExprMulti(expression, remaining);
        } else if (index < names.length) {
          this.compileExpr(expression);
        } else {
          this.compileExpr(expression);
          this.emit(OP.POP);
          this.pop();
        }
      });
    }

    // Normalise the value stack to exactly `names.length` slots.
    const produced = this.sp - (base - 1);
    for (let extra = produced; extra > names.length; extra -= 1) {
      this.emit(OP.POP);
      this.pop();
    }
    for (let missing = produced; missing < names.length; missing += 1) {
      this.emit(OP.LOADNIL);
      this.push();
    }

    for (const name of names) {
      const info = this.allocateLocal(name);
      if (info.cell) {
        this.emit(OP.CELLSET, info.slot, info.slot);
      }
    }
    this.sp = this.slotTop;
  }

  private compileAssignment(targets: AssignmentTarget[], exprs: Expression[]): void {
    const base = this.sp + 1;
    exprs.forEach((expression, index) => {
      const isLast = index === exprs.length - 1;
      if (isLast) {
        this.compileExprMulti(expression, Math.max(targets.length - index, 1));
      } else if (index < targets.length) {
        this.compileExpr(expression);
      } else {
        this.compileExpr(expression);
        this.emit(OP.POP);
        this.pop();
      }
    });

    const produced = this.sp - (base - 1);
    for (let extra = produced; extra > targets.length; extra -= 1) {
      this.emit(OP.POP);
      this.pop();
    }
    const available = this.sp - (base - 1);

    targets.forEach((target, index) => {
      const hasValue = index < available;
      const pushValue = (): void => {
        if (hasValue) {
          this.emit(OP.LOADL, base + index);
        } else {
          this.emit(OP.LOADNIL);
        }
        this.push();
      };

      if (target.type === "Identifier") {
        const resolved = this.lookup(target.name);
        pushValue();
        if (resolved.kind === "local") {
          this.emit(resolved.info.cell ? OP.STOREC : OP.STOREL, resolved.info.slot);
        } else if (resolved.kind === "upvalue") {
          this.emit(OP.STOREU, resolved.index);
        } else if (resolved.kind === "env") {
          throw new ReVeilError("cannot assign to _ENV", "LUA_COMPILER");
        } else {
          this.emit(OP.STOREG, this.program.intern(target.name));
        }
        this.pop();
        return;
      }

      this.compileExpr(target.base);
      const baseSlot = this.sp;
      let keySlot = 0;
      if (target.computed) {
        this.compileExpr(target.indexer as Expression);
        keySlot = this.sp;
      }
      pushValue();
      if (target.computed) {
        this.emit(OP.SETI);
        this.pop(3);
      } else {
        this.emit(OP.SETS, this.program.intern(target.key));
        this.pop(2);
      }
      void baseSlot;
      void keySlot;
    });
    // Values the expressions pushed before the targets are still on the stack:
    // the statement boundary drops them so both views of the stack agree.
  }

  private compileCompoundAssignment(statement: Extract<Statement, { type: "CompoundAssignmentStatement" }>): void {
    const { target, value, operator } = statement;
    const combine = (): void => {
      this.emit(operator === ".." ? OP.CONCAT : binaryOpcode(operator));
      this.pop();
    };

    if (target.type === "Identifier") {
      const resolved = this.lookup(target.name);
      if (resolved.kind === "local") {
        this.emit(resolved.info.cell ? OP.LOADC : OP.LOADL, resolved.info.slot);
        this.push();
      } else if (resolved.kind === "upvalue") {
        this.emit(OP.LOADU, resolved.index);
        this.push();
      } else if (resolved.kind === "env") {
        throw new ReVeilError("cannot assign to _ENV", "LUA_COMPILER");
      } else {
        this.emit(OP.LOADG, this.program.intern(target.name));
        this.push();
      }
      this.compileExpr(value);
      combine();
      if (resolved.kind === "local") {
        this.emit(resolved.info.cell ? OP.STOREC : OP.STOREL, resolved.info.slot);
      } else if (resolved.kind === "upvalue") {
        this.emit(OP.STOREU, resolved.index);
      } else {
        this.emit(OP.STOREG, this.program.intern(target.name));
      }
      this.pop();
      return;
    }

    this.compileExpr(target.base);
    const baseSlot = this.sp;
    let keySlot = 0;
    if (target.computed) {
      this.compileExpr(target.indexer as Expression);
      keySlot = this.sp;
      this.emit(OP.LOADL, baseSlot);
      this.push();
      this.emit(OP.LOADL, keySlot);
      this.push();
      this.emit(OP.GETI);
      this.pop();
    } else {
      this.emit(OP.LOADL, baseSlot);
      this.push();
      this.emit(OP.GETS, this.program.intern(target.key));
    }
    this.compileExpr(value);
    combine();
    if (target.computed) {
      this.emit(OP.SETI);
      this.pop(3);
    } else {
      this.emit(OP.SETS, this.program.intern(target.key));
      this.pop(2);
    }
  }

  private compileNumericFor(statement: Extract<Statement, { type: "NumericForStatement" }>): void {
    const outerHeight = this.slotTop;
    this.pushScope();
    this.slotTop = this.sp;
    // Three hidden control slots live below the loop variable.
    const control = this.slotTop + 1;
    this.reserveSlots(3);
    this.compileExpr(statement.start);
    this.emit(OP.STOREL, control);
    this.pop();
    this.sp = this.slotTop;
    this.compileExpr(statement.limit);
    this.emit(OP.STOREL, control + 1);
    this.pop();
    this.sp = this.slotTop;
    if (statement.step) {
      this.compileExpr(statement.step);
    } else {
      this.emit(OP.LOADK, 1);
      this.push();
    }
    this.emit(OP.STOREL, control + 2);
    this.pop();
    this.sp = this.slotTop;

    const loopVar = this.slotTop + 1;
    this.reserveSlots(1);
    const info = this.declareAt(statement.variable, loopVar);
    let cellSlot = 0;
    if (info.cell) {
      // Closures created inside the body must see a fresh loop variable.
      cellSlot = this.slotTop + 1;
      this.reserveSlots(1);
      this.locals.set(statement.variable, { slot: cellSlot, cell: true });
    }
    const loopHeight = this.slotTop;

    const bodyStart = this.newLabel();
    const loopTest = this.newLabel();
    const done = this.newLabel();
    // FORPREP prepares the control slots and hands over to the FORLOOP test.
    const prep = this.emit(OP.FORPREP, loopVar, control, control + 1, control + 2, 0);
    this.pending.push({ instruction: prep, operandIndex: 5, label: loopTest, sp: loopHeight });

    this.place(bodyStart);
    if (cellSlot !== 0) {
      this.emit(OP.CELLSET, cellSlot, loopVar);
    }
    const loop: LoopContext = { breakLabel: done, continueLabel: loopTest, breakSp: outerHeight, continueSp: loopHeight };
    this.loops.push(loop);
    this.compileStatements(statement.body);
    this.loops.pop();

    this.jump(OP.JMP, loopTest, loopHeight);
    this.place(loopTest);
    const loopInstr = this.emit(OP.FORLOOP, loopVar, control, control + 1, control + 2, 0);
    this.pending.push({ instruction: loopInstr, operandIndex: 5, label: bodyStart, sp: loopHeight });

    this.popScope();
    // Jump targets land *before* the restore so every exit path runs it.
    this.place(done);
    this.emit(OP.SETTOP, outerHeight);
  }

  private compileGenericFor(statement: Extract<Statement, { type: "GenericForStatement" }>): void {
    const outerHeight = this.slotTop;
    this.pushScope();
    this.slotTop = this.sp;
    // The iterator expression produces the classic (fn, state, control) triple
    // directly in the slots it will live in.
    const triple = this.slotTop + 1;

    const exprs = statement.exprs;
    if (exprs.length === 0) {
      throw new ReVeilError("generic for requires an iterator expression", "LUA_COMPILER");
    }
    exprs.forEach((expression, index) => {
      const isLast = index === exprs.length - 1;
      // `for k, v in iter, state, control do` is plain Lua; only a lone
      // expression is Luau's generalised iteration and gets the `pairs` wrap.
      const target = exprs.length === 1 ? genericForIterator(expression) : expression;
      if (isLast) {
        this.compileExprMulti(target, 3);
      } else {
        this.compileExpr(target);
      }
    });
    while (this.sp - (triple - 1) > 3) {
      this.emit(OP.POP);
      this.pop();
    }
    while (this.sp - (triple - 1) < 3) {
      this.emit(OP.LOADNIL);
      this.push();
    }
    this.slotTop = triple + 2;
    this.sp = this.slotTop;

    const varsBase = this.slotTop + 1;
    const varSlots: number[] = [];
    for (const variable of statement.variables) {
      this.reserveSlots(1);
      varSlots.push(this.slotTop);
      this.declareAt(variable, this.slotTop);
    }
    // Captured variables get their own cell, refreshed on every iteration.
    const cellSlots: number[] = [];
    statement.variables.forEach((variable, index) => {
      const info = this.locals.get(variable);
      if (!info || !info.cell) {
        cellSlots.push(0);
        return;
      }
      this.reserveSlots(1);
      cellSlots.push(this.slotTop);
      this.locals.set(variable, { slot: this.slotTop, cell: true });
      void index;
    });
    this.sp = this.slotTop;
    const loopHeight = this.slotTop;

    const loopStart = this.newLabel();
    const done = this.newLabel();
    this.place(loopStart);
    const tf = this.emit(OP.TF, triple, varsBase, statement.variables.length, 0);
    // The iterator is exhausted: leave the loop (the exit SETTOP runs first).
    this.pending.push({ instruction: tf, operandIndex: 4, label: done, sp: outerHeight });

    statement.variables.forEach((variable, index) => {
      void variable;
      const cellSlot = cellSlots[index];
      if (cellSlot !== 0) {
        this.emit(OP.CELLSET, cellSlot, varSlots[index]);
      }
    });

    const loop: LoopContext = {
      breakLabel: done,
      continueLabel: loopStart,
      breakSp: outerHeight,
      continueSp: loopHeight,
    };
    this.loops.push(loop);
    this.compileStatements(statement.body);
    this.loops.pop();
    this.jump(OP.JMP, loopStart, loopHeight);

    this.popScope();
    this.place(done);
    this.emit(OP.SETTOP, outerHeight);
  }

}

/** Luau allows `for k, v in t do` — desugar it to `pairs(t)`. */
function genericForIterator(expression: Expression): Expression {
  // A call (or `...`) already evaluates to the iterator triple; anything else
  // is a table the caller wants iterated (Luau's generalised iteration).
  if (expression.type === "CallExpression" || expression.type === "VarargLiteral") {
    return expression;
  }
  if (expression.parenthesized) {
    return expression;
  }
  return {
    type: "CallExpression",
    base: { type: "Identifier", name: "pairs", line: expression.line, column: expression.column },
    method: null,
    args: [expression],
    line: expression.line,
    column: expression.column,
  };
}

function unaryOpcode(operator: string): OpName {
  switch (operator) {
    case "-": return OP.UNM;
    case "not": return OP.NOTOP;
    case "#": return OP.LEN;
    case "~": return OP.BNOT;
    default:
      throw new ReVeilError(`unsupported unary operator '${operator}'`, "LUA_COMPILER");
  }
}

function binaryOpcode(operator: string): OpName {
  switch (operator) {
    case "+": return OP.ADD;
    case "-": return OP.SUB;
    case "*": return OP.MUL;
    case "/": return OP.DIV;
    case "//": return OP.IDIV;
    case "%": return OP.MOD;
    case "^": return OP.POW;
    case "..": return OP.CONCAT;
    case "&": return OP.BAND;
    case "|": return OP.BOR;
    case "~": return OP.BXOR;
    case "<<": return OP.SHL;
    case ">>": return OP.SHR;
    case "==": return OP.EQ;
    case "~=": return OP.NE;
    case "<": return OP.LT;
    case "<=": return OP.LE;
    case ">": return OP.GT;
    case ">=": return OP.GE;
    default:
      throw new ReVeilError(`unsupported binary operator '${operator}'`, "LUA_COMPILER");
  }
}

function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
