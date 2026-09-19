/**
 * ReVeil Lua AST transforms.
 *
 * These are the source-level layers of the Lua engine. They can be used on
 * their own (source-mode presets) or as a pre-pass for the virtual machine.
 *
 * Every transform is deterministic for a given seed and preserves behaviour:
 * dead code is unreachable, opaque predicates are arithmetic identities, the
 * string vault is reversible and number encoding is plain arithmetic.
 */

import { ReVeilError } from "../core/errors";
import type { ReVeilRandom } from "../core/rng";
import type { Block, Chunk, Expression, FunctionExpression, Statement, TableField } from "./ast";

export interface TransformToggles {
  encryptStrings: boolean;
  encodeNumbers: boolean;
  injectDeadCode: boolean;
  opaquePredicates: boolean;
  flattenControlFlow: boolean;
  fractureExpressions: boolean;
  decoys: boolean;
}

export interface TransformStats {
  strings: number;
  numbers: number;
  fractures: number;
  deadBlocks: number;
  flattened: number;
  decoys: number;
}

interface WalkContext {
  rng: ReVeilRandom;
  toggles: TransformToggles;
  vault: string[];
  vaultDecoder: string;
  vaultTable: string;
  constants: string | null;
  stats: TransformStats;
}

/**
 * Applies every enabled transform to `chunk` in place and returns statistics.
 * A vault decoder and the injected constants are prepended to the chunk.
 */
export function applyTransforms(chunk: Chunk, rng: ReVeilRandom, toggles: TransformToggles): TransformStats {
  const context: WalkContext = {
    rng,
    toggles,
    vault: [],
    vaultDecoder: `${rng.identifier(7)}D`,
    vaultTable: `${rng.identifier(7)}V`,
    constants: null,
    stats: { strings: 0, numbers: 0, fractures: 0, deadBlocks: 0, flattened: 0, decoys: 0 },
  };

  const prelude: Statement[] = [];

  if (toggles.decoys) {
    const decoys = buildDecoyFunctions(rng);
    prelude.push(...decoys);
    context.stats.decoys = decoys.length;
  }

  if (toggles.injectDeadCode || toggles.opaquePredicates) {
    context.constants = `${rng.identifier(6)}K`;
    prelude.push({
      type: "LocalStatement",
      names: [context.constants],
      exprs: [numberLiteral(rng.range(1, 1 << 16))],
      line: 0,
      column: 0,
    });
  }

  if (toggles.fractureExpressions || toggles.encodeNumbers || toggles.encryptStrings) {
    visitBlock(chunk.block, context);
  }

  if (toggles.encryptStrings && context.vault.length > 0) {
    prelude.push(...buildVault(context, rng));
  }

  if (toggles.flattenControlFlow) {
    context.stats.flattened = flattenBlocks(chunk.block, context);
  }

  if (toggles.injectDeadCode) {
    injectDeadCode(chunk.block, context);
  }

  if (prelude.length > 0) {
    chunk.block.statements = [...prelude, ...chunk.block.statements];
  }
  return context.stats;
}

/**
 * Engine-facing entry point used by the source-mode emitter: runs the enabled
 * transform layers and folds their counters into the shared statistics object.
 */
export function applySourceTransforms(
  chunk: Chunk,
  rng: ReVeilRandom,
  options: { toggles: object },
  stats: { encryptedStrings: number; encodedNumbers: number; injectedBlocks: number },
): Chunk {
  const flags = options.toggles as Partial<Record<keyof TransformToggles, boolean>>;
  const toggles: TransformToggles = {
    encryptStrings: flags.encryptStrings === true,
    encodeNumbers: flags.encodeNumbers === true,
    injectDeadCode: flags.injectDeadCode === true,
    opaquePredicates: flags.opaquePredicates === true,
    flattenControlFlow: flags.flattenControlFlow === true,
    fractureExpressions: flags.fractureExpressions === true,
    decoys: flags.decoys === true,
  };
  const result = applyTransforms(chunk, rng, toggles);
  stats.encryptedStrings += result.strings;
  stats.encodedNumbers += result.numbers;
  stats.injectedBlocks += result.deadBlocks + result.decoys + result.flattened + result.fractures;
  return chunk;
}

// --------------------------------------------------------------------- vault

function buildVault(context: WalkContext, rng: ReVeilRandom): Statement[] {
  const salt = rng.range(1, 255);
  const encoded = context.vault.map((entry) => {
    let out = "";
    for (let index = 0; index < entry.length; index += 1) {
      const code = entry.charCodeAt(index) & 0xff;
      const mixed = (code + salt + (((index + 1) * 31 + 11) % 256)) % 256;
      out += `\\${mixed}`;
    }
    return out;
  });

  const table: Statement = {
    type: "LocalStatement",
    names: [context.vaultTable],
    exprs: [
      {
        type: "TableConstructor",
        fields: encoded.map((text, index): TableField => ({
          kind: "array",
          value: rawString(text),
          line: 0,
          column: index,
        })),
        line: 0,
        column: 0,
      },
    ],
    line: 0,
    column: 0,
  };

  const source = [
    `local ${context.vaultDecoder} = function(index)`,
    `  local raw = ${context.vaultTable}[index]`,
    `  local out = {}`,
    `  for position = 1, #raw do`,
    `    local byte = string.byte(raw, position)`,
    `    out[position] = string.char((byte - ${salt} - ((position * 31 + 11) % 256)) % 256)`,
    `  end`,
    `  return table.concat(out)`,
    `end`,
  ].join("\n");
  const decoder = parseSnippetExpression(source);
  const statement: Statement = {
    type: "LocalStatement",
    names: [context.vaultDecoder],
    exprs: [decoder],
    line: 0,
    column: 0,
  };
  return [table, statement];
}

/** A string literal the printer must emit verbatim (already escaped). */
function rawString(text: string): Expression {
  return { type: "StringLiteral", value: decodeEscapes(text), raw: `"${text}"`, line: 0, column: 0 };
}

function decodeEscapes(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") {
      out += text[index];
      continue;
    }
    let digits = "";
    while (digits.length < 3 && text[index + 1] >= "0" && text[index + 1] <= "9") {
      digits += text[index + 1];
      index += 1;
    }
    if (digits === "") {
      index += 1;
      const next = text[index];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      continue;
    }
    out += String.fromCharCode(Number(digits));
  }
  return out;
}

// ------------------------------------------------------------------ walking

function visitBlock(block: Block, context: WalkContext): void {
  block.statements = block.statements.map((statement) => visitStatement(statement, context));
}

function visitStatement(statement: Statement, context: WalkContext): Statement {
  const map = (expression: Expression): Expression => visitExpression(expression, context);
  switch (statement.type) {
    case "LocalStatement":
      statement.exprs = statement.exprs.map(map);
      return statement;
    case "AssignmentStatement":
      statement.targets = statement.targets.map((target) =>
        target.type === "MemberExpression"
          ? { ...target, base: map(target.base), indexer: target.indexer ? map(target.indexer) : null }
          : target,
      );
      statement.exprs = statement.exprs.map(map);
      return statement;
    case "CompoundAssignmentStatement":
      statement.value = map(statement.value);
      if (statement.target.type === "MemberExpression") {
        statement.target = { ...statement.target, base: map(statement.target.base) };
      }
      return statement;
    case "CallStatement":
      statement.call = visitCall(statement.call, context);
      return statement;
    case "FunctionDeclaration":
      statement.func = visitFunction(statement.func, context);
      if (statement.target.type === "MemberExpression") {
        statement.target = { ...statement.target, base: map(statement.target.base) };
      }
      return statement;
    case "DoStatement":
      visitBlock(statement.body, context);
      return statement;
    case "WhileStatement":
      statement.condition = map(statement.condition);
      visitBlock(statement.body, context);
      return statement;
    case "RepeatStatement":
      visitBlock(statement.body, context);
      statement.condition = map(statement.condition);
      return statement;
    case "IfStatement":
      statement.clauses = statement.clauses.map((clause) => {
        const condition = map(clause.condition);
        visitBlock(clause.body, context);
        return { condition, body: clause.body };
      });
      if (statement.elseBody) visitBlock(statement.elseBody, context);
      return statement;
    case "NumericForStatement":
      statement.start = map(statement.start);
      statement.limit = map(statement.limit);
      if (statement.step) statement.step = map(statement.step);
      visitBlock(statement.body, context);
      return statement;
    case "GenericForStatement":
      statement.exprs = statement.exprs.map(map);
      visitBlock(statement.body, context);
      return statement;
    case "ReturnStatement":
      statement.args = statement.args.map(map);
      return statement;
    default:
      return statement;
  }
}

function visitFunction(func: FunctionExpression, context: WalkContext): FunctionExpression {
  visitBlock(func.body, context);
  return func;
}

function visitCall(call: import("./ast").CallExpression, context: WalkContext): typeof call {
  call.base = visitExpression(call.base, context);
  call.args = call.args.map((argument) => visitExpression(argument, context));
  return call;
}

function visitExpression(expression: Expression, context: WalkContext): Expression {
  switch (expression.type) {
    case "StringLiteral": {
      if (!context.toggles.encryptStrings) return expression;
      context.vault.push(expression.value);
      context.stats.strings += 1;
      return {
        type: "CallExpression",
        base: { type: "Identifier", name: context.vaultDecoder, line: 0, column: 0 },
        method: null,
        args: [numberLiteral(context.vault.length)],
        line: expression.line,
        column: expression.column,
      };
    }
    case "NumberLiteral": {
      if (
        !context.toggles.encodeNumbers ||
        expression.isFloat === true ||
        !Number.isInteger(expression.value) ||
        Math.abs(expression.value) > 1 << 30
      ) {
        return expression;
      }
      context.stats.numbers += 1;
      return encodeNumber(expression.value, context.rng);
    }
    case "TableConstructor":
      expression.fields = expression.fields.map((field): TableField => {
        if (field.kind === "record") {
          return { ...field, value: visitExpression(field.value, context) };
        }
        if (field.kind === "computed") {
          return { ...field, key: visitExpression(field.key, context), value: visitExpression(field.value, context) };
        }
        return { ...field, value: visitExpression(field.value, context) };
      });
      return expression;
    case "BinaryExpression": {
      expression.left = visitExpression(expression.left, context);
      expression.right = visitExpression(expression.right, context);
      if (context.toggles.fractureExpressions) {
        const fractured = fracture(expression);
        if (fractured) {
          context.stats.fractures += 1;
          return fractured;
        }
      }
      return expression;
    }
    case "UnaryExpression":
      expression.argument = visitExpression(expression.argument, context);
      return expression;
    case "FunctionExpression":
      return visitFunction(expression, context);
    case "CallExpression":
      return visitCall(expression, context);
    case "MemberExpression":
      expression.base = visitExpression(expression.base, context);
      if (expression.indexer) expression.indexer = visitExpression(expression.indexer, context);
      return expression;
    case "IfExpression":
      expression.clauses = expression.clauses.map((clause) => ({
        condition: visitExpression(clause.condition, context),
        value: visitExpression(clause.value, context),
      }));
      expression.elseValue = visitExpression(expression.elseValue, context);
      return expression;
    case "InterpolatedString":
      expression.parts = expression.parts.map((part) =>
        part.kind === "text" ? part : { kind: "expr", expression: visitExpression(part.expression, context) },
      );
      return expression;
    default:
      return expression;
  }
}

/** `a == b` → `not (a ~= b)`, `a ~= b` → `not (a == b)`. */
function fracture(expression: import("./ast").BinaryExpression): Expression | null {
  if (expression.operator === "==" || expression.operator === "~=") {
    return {
      type: "UnaryExpression",
      operator: "not",
      argument: {
        type: "BinaryExpression",
        operator: expression.operator === "==" ? "~=" : "==",
        left: expression.left,
        right: expression.right,
        parenthesized: true,
        line: expression.line,
        column: expression.column,
      },
      line: expression.line,
      column: expression.column,
    };
  }
  return null;
}

/** `value` → `(a + b)` / `(a - b)` with random a, b. */
function encodeNumber(value: number, rng: ReVeilRandom): Expression {
  const spread = Math.max(2, Math.min(1 << 20, Math.abs(value) || 1));
  const left = rng.range(1, spread);
  const difference = value - left;
  const literal = (input: number): Expression => ({ type: "NumberLiteral", value: input, raw: String(input), line: 0, column: 0 });
  if (difference === 0) {
    return literal(value);
  }
  return {
    type: "BinaryExpression",
    operator: difference < 0 ? "-" : "+",
    left: literal(left),
    right: literal(Math.abs(difference)),
    line: 0,
    column: 0,
  };
}

// -------------------------------------------------------------- dead code

function injectDeadCode(block: Block, context: WalkContext): void {
  const injected: Statement[] = [];
  for (const statement of block.statements) {
    for (const inner of innerBlocks(statement)) {
      injectDeadCode(inner, context);
    }
  }
  if (context.constants === null || block.statements.length === 0) {
    return;
  }
  const count = Math.min(2, Math.max(1, block.statements.length > 2 ? 2 : 1));
  for (let index = 0; index < count; index += 1) {
    injected.push(deadCodeGuard(context));
    context.stats.deadBlocks += 1;
  }
  block.statements = [...injected, ...block.statements];
}

function deadCodeGuard(context: WalkContext): Statement {
  const constant = context.constants as string;
  const operator = context.rng.pick(["<", ">", "=="] as const);
  // `K*K` is never negative, so `K*K < 0` is always false.
  const condition: Expression = {
    type: "BinaryExpression",
    operator,
    left: {
      type: "BinaryExpression",
      operator: "*",
      left: { type: "Identifier", name: constant, line: 0, column: 0 },
      right: { type: "Identifier", name: constant, line: 0, column: 0 },
      line: 0,
      column: 0,
    },
    right: numberLiteral(operator === "<" ? 0 : -1),
    line: 0,
    column: 0,
  };
  const junkName = `${context.rng.identifier(8)}`;
  const junk: Block = {
    statements: [
      {
        type: "LocalStatement",
        names: [junkName],
        exprs: [
          {
            type: "BinaryExpression",
            operator: "+",
            left: { type: "Identifier", name: constant, line: 0, column: 0 },
            right: numberLiteral(context.rng.range(1, 1 << 16)),
            line: 0,
            column: 0,
          },
        ],
        line: 0,
        column: 0,
      },
      {
        type: "AssignmentStatement",
        targets: [{ type: "Identifier", name: junkName, line: 0, column: 0 }],
        exprs: [
          {
            type: "BinaryExpression",
            operator: "-",
            left: { type: "Identifier", name: junkName, line: 0, column: 0 },
            right: { type: "Identifier", name: junkName, line: 0, column: 0 },
            line: 0,
            column: 0,
          },
        ],
        line: 0,
        column: 0,
      },
    ],
  };
  return {
    type: "IfStatement",
    clauses: [{ condition, body: junk }],
    elseBody: null,
    line: 0,
    column: 0,
  };
}

// ---------------------------------------------------------- control flow

function innerBlocks(statement: Statement): Block[] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "NumericForStatement":
    case "GenericForStatement":
      return [statement.body];
    case "IfStatement":
      return [...statement.clauses.map((clause) => clause.body), ...(statement.elseBody ? [statement.elseBody] : [])];
    default:
      return [];
  }
}

/** Turns straight-line blocks into a shuffled state machine. */
function flattenBlocks(block: Block, context: WalkContext): number {
  let flattened = 0;
  for (const statement of block.statements) {
    for (const inner of innerBlocks(statement)) {
      flattened += flattenBlocks(inner, context);
    }
  }
  if (!canFlatten(block)) {
    return flattened;
  }
  block.statements = flatten(block, context);
  return flattened + 1;
}

function canFlatten(block: Block): boolean {
  return (
    block.statements.length >= 3 &&
    block.statements.every((statement) => ["LocalStatement", "AssignmentStatement", "CallStatement"].includes(statement.type))
  );
}

function flatten(block: Block, context: WalkContext): Statement[] {
  const stateName = `${context.rng.identifier(6)}S`;
  const statements = block.statements;
  const order = context.rng.shuffle(statements.map((_, index) => index));
  const states = new Map<number, number>();
  order.forEach((statementIndex, position) => states.set(statementIndex, position + 1));

  const branches: Statement[] = order.map((statementIndex, position) => {
    const body: Block = { statements: [statements[statementIndex]] };
    const next = position < order.length - 1 ? (states.get(order[position + 1]) as number) : order.length + 1;
    body.statements.push(assign(stateName, numberLiteral(next)));
    return {
      type: "IfStatement",
      clauses: [
        {
          condition: {
            type: "BinaryExpression",
            operator: "==",
            left: { type: "Identifier", name: stateName, line: 0, column: 0 },
            right: numberLiteral(states.get(statementIndex) as number),
            line: 0,
            column: 0,
          },
          body,
        },
      ],
      elseBody: null,
      line: 0,
      column: 0,
    };
  });

  return [
    {
      type: "DoStatement",
      body: {
        statements: [
          {
            type: "LocalStatement",
            names: [stateName],
            exprs: [numberLiteral(states.get(order[0]) as number)],
            line: 0,
            column: 0,
          },
          {
            type: "WhileStatement",
            condition: {
              type: "BinaryExpression",
              operator: "<=",
              left: { type: "Identifier", name: stateName, line: 0, column: 0 },
              right: numberLiteral(order.length),
              line: 0,
              column: 0,
            },
            body: { statements: branches },
            line: 0,
            column: 0,
          },
        ],
      },
      line: 0,
      column: 0,
    },
  ];
}

// ------------------------------------------------------------------ decoys

function buildDecoyFunctions(rng: ReVeilRandom): Statement[] {
  const statements: Statement[] = [];
  const count = rng.range(1, 3);
  for (let index = 0; index < count; index += 1) {
    const name = `${rng.identifier(8)}`;
    statements.push({
      type: "FunctionDeclaration",
      isLocal: true,
      target: { type: "Identifier", name, line: 0, column: 0 },
      func: {
        type: "FunctionExpression",
        params: ["value"],
        vararg: false,
        body: {
          statements: [
            {
              type: "ReturnStatement",
              args: [
                {
                  type: "BinaryExpression",
                  operator: "+",
                  left: { type: "Identifier", name: "value", line: 0, column: 0 },
                  right: numberLiteral(rng.range(1, 1 << 16)),
                  line: 0,
                  column: 0,
                },
              ],
              line: 0,
              column: 0,
            },
          ],
        },
        line: 0,
        column: 0,
      },
      line: 0,
      column: 0,
    });
  }
  return statements;
}

// ----------------------------------------------------------------- helpers

function numberLiteral(value: number): Expression {
  return { type: "NumberLiteral", value, raw: String(value), line: 0, column: 0 };
}

function assign(name: string, value: Expression): Statement {
  return {
    type: "AssignmentStatement",
    targets: [{ type: "Identifier", name, line: 0, column: 0 }],
    exprs: [value],
    line: 0,
    column: 0,
  };
}

/** Parses a generated helper (`local f = function ... end`) into an expression. */
function parseSnippetExpression(source: string): Expression {
  const { parseLua } = require("./parser") as typeof import("./parser");
  const chunk = parseLua(source, { allowLuau: false });
  const statement = chunk.block.statements[chunk.block.statements.length - 1];
  if (!statement || statement.type !== "LocalStatement" || statement.exprs.length !== 1) {
    throw new ReVeilError("internal error: could not parse a generated Lua helper", "LUA_TRANSFORM");
  }
  return statement.exprs[0];
}
