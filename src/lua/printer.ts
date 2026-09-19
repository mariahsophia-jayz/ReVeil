/**
 * Lua source printer.
 *
 * Turns a ReVeil AST back into Lua source text. The printer is used by the
 * source-mode pipeline (and by tests) and is deliberately conservative: every
 * string is escaped into pure ASCII, numbers keep their float-ness and the
 * operator precedence of Lua 5.1–5.4 / Luau is respected.
 */

import type {
  AssignmentTarget,
  Block,
  CallExpression,
  Chunk,
  Expression,
  FunctionExpression,
  MemberExpression,
  Statement,
  TableField,
} from "./ast";
import { ReVeilError } from "../core/errors";

export interface PrintOptions {
  /** Emit Luau-only syntax (`continue`, if-expressions, interpolation). */
  luau?: boolean;
  indent?: string;
  /** Collapse the output onto as few lines as possible. */
  minify?: boolean;
  /** Prefix the chunk with a ReVeil banner comment. */
  banner?: boolean;
  /** Text appended to the banner. */
  watermark?: string;
  /** Preset name used in the banner. */
  preset?: string;
}

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  "<": 3, ">": 3, "<=": 3, ">=": 3, "~=": 3, "==": 3,
  "|": 4,
  "~": 5,
  "&": 6,
  "<<": 7, ">>": 7,
  "..": 8,
  "+": 9, "-": 9,
  "*": 10, "/": 10, "//": 10, "%": 10,
  "^": 12,
};

const UNARY_PRECEDENCE = 11;

export function printChunk(chunk: Chunk, options: PrintOptions = {}): string {
  const printer = new LuaPrinter(options);
  let body = printer.printBlock(chunk.block, 0);
  if (options.minify) {
    body = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" ");
  } else if (body !== "" && !body.endsWith("\n")) {
    body += "\n";
  }
  const banner = options.banner === false ? "" : bannerComment(options);
  return banner + body;
}

function bannerComment(options: PrintOptions): string {
  const preset = options.preset ? ` preset=${options.preset}` : "";
  const watermark = options.watermark ? ` ${options.watermark}` : "";
  return `--[[ ReVeil | protected Lua${preset}${watermark} ]]\n`;
}

/**
 * Escapes a byte string into a double quoted Lua literal made of ASCII only.
 * Strings in the pipeline follow the "one char = one byte" convention (chars
 * above 0xff are encoded as their UTF-8 byte sequence first).
 */
export function printString(value: string): string {
  const bytes = toByteString(value);
  let out = '"';
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes.charCodeAt(index);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code >= 32 && code <= 126) out += bytes[index];
    else out += `\\${String(code).padStart(3, "0")}`;
  }
  return `${out}"`;
}

/** Encodes a JS string into ReVeil's byte-string representation. */
export function toByteString(value: string): string {
  if (!/[\u0080-\uffff]/.test(value)) {
    return value;
  }
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code <= 0xff) {
      out += character;
      continue;
    }
    const encoded = Buffer.from(character, "utf8").toString("latin1");
    out += encoded;
  }
  return out;
}

/** Inverse of `toByteString`: decodes the UTF-8 byte sequence back to text. */
export function fromByteString(value: string): string {
  return Buffer.from(value, "latin1").toString("utf8");
}

function printNumber(value: number, isFloat: boolean): string {
  if (Number.isNaN(value)) return "(0/0)";
  if (value === Infinity) return "(1/0)";
  if (value === -Infinity) return "(-1/0)";
  const text = String(value);
  if (isFloat && Number.isInteger(value) && !/[eE]/.test(text)) return `${text}.0`;
  return text;
}

class LuaPrinter {
  private readonly indent: string;
  private readonly luau: boolean;

  constructor(options: PrintOptions) {
    this.indent = options.indent ?? "  ";
    this.luau = options.luau === true;
  }

  printBlock(block: Block, depth: number): string {
    const lines: string[] = [];
    for (const statement of block.statements) {
      lines.push(this.printStatement(statement, depth));
    }
    return lines.join("\n");
  }

  private pad(depth: number): string {
    return this.indent.repeat(depth);
  }

  private printStatement(statement: Statement, depth: number): string {
    const prefix = this.pad(depth);
    switch (statement.type) {
      case "LocalStatement": {
        const names = statement.names.join(", ");
        if (statement.exprs.length === 0) {
          return `${prefix}local ${names}`;
        }
        return `${prefix}local ${names} = ${this.printExpressions(statement.exprs)}`;
      }
      case "AssignmentStatement": {
        const targets = statement.targets.map((target) => this.printTarget(target, depth)).join(", ");
        return `${prefix}${targets} = ${this.printExpressions(statement.exprs)}`;
      }
      case "CompoundAssignmentStatement": {
        // Lowered to the portable form so the output stays Lua 5.1 friendly.
        const target = this.printTarget(statement.target, depth);
        return `${prefix}${target} = ${target} ${statement.operator} ${this.printExpr(statement.value, depth, 0)}`;
      }
      case "CallStatement":
        return `${prefix}${this.printCall(statement.call, depth)}`;
      case "FunctionDeclaration": {
        const name = statement.isLocal ? "local function" : "function";
        return `${prefix}${name} ${this.printTarget(statement.target, depth)}${this.printFunctionSuffix(statement.func, depth)}`;
      }
      case "DoStatement":
        return `${prefix}do\n${this.printBlock(statement.body, depth + 1)}\n${prefix}end`;
      case "WhileStatement":
        return `${prefix}while ${this.printExpr(statement.condition, depth, 0)} do\n${this.printBlock(statement.body, depth + 1)}\n${prefix}end`;
      case "RepeatStatement":
        return `${prefix}repeat\n${this.printBlock(statement.body, depth + 1)}\n${prefix}until ${this.printExpr(statement.condition, depth, 0)}`;
      case "IfStatement": {
        const lines: string[] = [];
        statement.clauses.forEach((clause, index) => {
          const keyword = index === 0 ? "if" : "elseif";
          lines.push(`${prefix}${keyword} ${this.printExpr(clause.condition, depth, 0)} then`);
          lines.push(this.printBlock(clause.body, depth + 1));
        });
        if (statement.elseBody) {
          lines.push(`${prefix}else`);
          lines.push(this.printBlock(statement.elseBody, depth + 1));
        }
        lines.push(`${prefix}end`);
        return lines.join("\n");
      }
      case "NumericForStatement": {
        const step = statement.step ? `, ${this.printExpr(statement.step, depth, 0)}` : "";
        return `${prefix}for ${statement.variable} = ${this.printExpr(statement.start, depth, 0)}, ${this.printExpr(statement.limit, depth, 0)}${step} do\n${this.printBlock(statement.body, depth + 1)}\n${prefix}end`;
      }
      case "GenericForStatement":
        return `${prefix}for ${statement.variables.join(", ")} in ${this.printExpressions(statement.exprs)} do\n${this.printBlock(statement.body, depth + 1)}\n${prefix}end`;
      case "ReturnStatement":
        return statement.args.length === 0 ? `${prefix}return` : `${prefix}return ${this.printExpressions(statement.args)}`;
      case "BreakStatement":
        return `${prefix}break`;
      case "ContinueStatement":
        if (!this.luau) {
          throw new ReVeilError(
            "Luau `continue` cannot be printed as portable Lua — use the virtual machine preset or the luau target",
            "LUA_PRINT",
          );
        }
        return `${prefix}continue`;
      case "GotoStatement":
        return `${prefix}goto ${statement.label}`;
      case "LabelStatement":
        return `${prefix}::${statement.label}::`;
      default:
        throw new ReVeilError("unsupported statement in Lua printer", "LUA_PRINT");
    }
  }

  private printExpressions(expressions: Expression[]): string {
    return expressions.map((expression) => this.printExpr(expression, 0, 0)).join(", ");
  }

  private printTarget(target: AssignmentTarget, depth: number): string {
    if (target.type === "Identifier") {
      return target.name;
    }
    return this.printMember(target, depth);
  }

  private printFunctionSuffix(func: FunctionExpression, depth: number): string {
    const params = [...func.params];
    if (func.vararg) {
      params.push("...");
    }
    const body = this.printBlock(func.body, depth + 1);
    const prelude = `${params.join(", ")})`;
    void prelude;
    return `(${params.join(", ")})\n${body}\n${this.pad(depth)}end`;
  }

  private printCall(call: CallExpression, depth: number): string {
    const base = this.printExpr(call.base, depth, 11);
    const args = call.args.map((argument) => this.printExpr(argument, depth, 0)).join(", ");
    if (call.method) {
      return `${base}:${call.method}(${args})`;
    }
    return `${base}(${args})`;
  }

  private printMember(member: MemberExpression, depth: number): string {
    const base = this.printExpr(member.base, depth, 11);
    if (member.computed) {
      return `${base}[${this.printExpr(member.indexer as Expression, depth, 0)}]`;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(member.key)) {
      return `${base}.${member.key}`;
    }
    return `${base}[${printString(member.key)}]`;
  }

  printExpr(expression: Expression, depth: number, minPrecedence: number): string {
    let text = this.printExprRaw(expression, depth);
    // Parentheses are semantic in Lua: they stop multi-value expansion.
    if (expression.parenthesized === true) {
      text = `(${text})`;
    }
    const precedence = this.precedenceOf(expression);
    if (precedence < minPrecedence) {
      return `(${text})`;
    }
    return text;
  }

  private precedenceOf(expression: Expression): number {
    if (expression.type === "BinaryExpression") {
      return PRECEDENCE[expression.operator] ?? 0;
    }
    if (expression.type === "UnaryExpression") {
      return UNARY_PRECEDENCE;
    }
    if (expression.type === "IfExpression") {
      return 0;
    }
    return 100;
  }

  private printExprRaw(expression: Expression, depth: number): string {
    switch (expression.type) {
      case "Identifier":
        return expression.name;
      case "NumberLiteral":
        return printNumber(expression.value, expression.isFloat === true);
      case "StringLiteral":
        return printString(expression.value);
      case "BooleanLiteral":
        return expression.value ? "true" : "false";
      case "NilLiteral":
        return "nil";
      case "VarargLiteral":
        return "...";
      case "TableConstructor":
        return this.printTable(expression.fields, depth);
      case "BinaryExpression": {
        // `and` / `or` are right associative in Lua.
        const precedence = PRECEDENCE[expression.operator] ?? 0;
        const left = this.printExpr(expression.left, depth, precedence);
        const right = this.printExpr(expression.right, depth, expression.operator === ".." ? precedence : precedence + 1);
        return `${left} ${expression.operator} ${right}`;
      }
      case "UnaryExpression":
        return `${expression.operator === "not" ? "not " : expression.operator}${this.printExpr(expression.argument, depth, UNARY_PRECEDENCE)}`;
      case "FunctionExpression":
        return `function${this.printFunctionSuffix(expression, depth)}`;
      case "CallExpression":
        return this.printCall(expression, depth);
      case "MemberExpression":
        return this.printMember(expression, depth);
      case "IfExpression": {
        if (!this.luau) {
          throw new ReVeilError(
            "Luau if-expressions cannot be printed as portable Lua — use the virtual machine preset or the luau target",
            "LUA_PRINT",
          );
        }
        const clauses = expression.clauses
          .map((clause) => `${this.printExpr(clause.condition, depth, 0)} then ${this.printExpr(clause.value, depth, 0)}`)
          .join(" elseif ");
        return `if ${clauses} else ${this.printExpr(expression.elseValue, depth, 0)}`;
      }
      case "InterpolatedString": {
        const pieces = expression.parts.map((part) =>
          part.kind === "text"
            ? printString(part.value)
            : `tostring(${this.printExpr(part.expression, depth, 0)})`,
        );
        return pieces.length === 0 ? '""' : pieces.join(" .. ");
      }
      default:
        throw new ReVeilError("unsupported expression in Lua printer", "LUA_PRINT");
    }
  }

  private printTable(fields: TableField[], depth: number): string {
    if (fields.length === 0) {
      return "{}";
    }
    const parts = fields.map((field) => {
      if (field.kind === "array") {
        return this.printExpr(field.value, depth, 0);
      }
      if (field.kind === "record") {
        return `${field.key} = ${this.printExpr(field.value, depth, 0)}`;
      }
      return `[${this.printExpr(field.key, depth, 0)}] = ${this.printExpr(field.value, depth, 0)}`;
    });
    return `{${parts.join(", ")}}`;
  }
}
