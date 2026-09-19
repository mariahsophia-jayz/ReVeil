/** ReVeil Lua/Luau abstract syntax tree. */

/** Set on nodes the parser saw inside parentheses: they never expand to
 *  multiple values (Lua only expands a call or `...` in the last position). */
export interface NodeBase {
  parenthesized?: boolean;
  line: number;
  column: number;
}

export interface Identifier extends NodeBase {
  type: "Identifier";
  name: string;
}

export interface NumberLiteral extends NodeBase {
  type: "NumberLiteral";
  value: number;
  raw: string;
  /** Literals Lua parses as floats stay floats through the whole pipeline. */
  isFloat?: boolean;
}

export interface StringLiteral extends NodeBase {
  type: "StringLiteral";
  value: string;
  raw: string;
}

export interface BooleanLiteral extends NodeBase {
  type: "BooleanLiteral";
  value: boolean;
}

export interface NilLiteral extends NodeBase {
  type: "NilLiteral";
}

export interface VarargLiteral extends NodeBase {
  type: "VarargLiteral";
}

export type TableField =
  | { kind: "array"; value: Expression; line: number; column: number }
  | { kind: "record"; key: string; value: Expression; line: number; column: number }
  | { kind: "computed"; key: Expression; value: Expression; line: number; column: number };

export interface TableConstructor extends NodeBase {
  type: "TableConstructor";
  fields: TableField[];
}

export interface BinaryExpression extends NodeBase {
  type: "BinaryExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface UnaryExpression extends NodeBase {
  type: "UnaryExpression";
  operator: string;
  argument: Expression;
}

export interface FunctionExpression extends NodeBase {
  type: "FunctionExpression";
  params: string[];
  vararg: boolean;
  body: Block;
  name?: string;
}

export type CallArgument = Expression;

export interface CallExpression extends NodeBase {
  type: "CallExpression";
  base: Expression;
  method: string | null;
  args: CallArgument[];
}

export interface MemberExpression extends NodeBase {
  type: "MemberExpression";
  base: Expression;
  key: string;
  computed: boolean;
  indexer: Expression | null;
}

export interface IfExpressionClause {
  condition: Expression;
  value: Expression;
}

export interface IfExpression extends NodeBase {
  type: "IfExpression";
  clauses: IfExpressionClause[];
  elseValue: Expression;
}

export interface InterpolatedString extends NodeBase {
  type: "InterpolatedString";
  parts: Array<{ kind: "text"; value: string } | { kind: "expr"; expression: Expression }>;
}

export type Expression =
  | Identifier
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NilLiteral
  | VarargLiteral
  | TableConstructor
  | BinaryExpression
  | UnaryExpression
  | FunctionExpression
  | CallExpression
  | MemberExpression
  | IfExpression
  | InterpolatedString;

export interface LocalStatement extends NodeBase {
  type: "LocalStatement";
  names: string[];
  exprs: Expression[];
}

export type AssignmentTarget = Identifier | MemberExpression;

export interface AssignmentStatement extends NodeBase {
  type: "AssignmentStatement";
  targets: AssignmentTarget[];
  exprs: Expression[];
}

export interface CompoundAssignmentStatement extends NodeBase {
  type: "CompoundAssignmentStatement";
  operator: string;
  target: AssignmentTarget;
  value: Expression;
}

export interface CallStatement extends NodeBase {
  type: "CallStatement";
  call: CallExpression;
}

export interface FunctionDeclaration extends NodeBase {
  type: "FunctionDeclaration";
  isLocal: boolean;
  target: Identifier | MemberExpression;
  func: FunctionExpression;
}

export interface DoStatement extends NodeBase {
  type: "DoStatement";
  body: Block;
}

export interface WhileStatement extends NodeBase {
  type: "WhileStatement";
  condition: Expression;
  body: Block;
}

export interface RepeatStatement extends NodeBase {
  type: "RepeatStatement";
  body: Block;
  condition: Expression;
}

export interface IfStatement extends NodeBase {
  type: "IfStatement";
  clauses: Array<{ condition: Expression; body: Block }>;
  elseBody: Block | null;
}

export interface NumericForStatement extends NodeBase {
  type: "NumericForStatement";
  variable: string;
  start: Expression;
  limit: Expression;
  step: Expression | null;
  body: Block;
}

export interface GenericForStatement extends NodeBase {
  type: "GenericForStatement";
  variables: string[];
  exprs: Expression[];
  body: Block;
}

export interface ReturnStatement extends NodeBase {
  type: "ReturnStatement";
  args: Expression[];
}

export interface BreakStatement extends NodeBase {
  type: "BreakStatement";
}

export interface ContinueStatement extends NodeBase {
  type: "ContinueStatement";
}

export interface GotoStatement extends NodeBase {
  type: "GotoStatement";
  label: string;
}

export interface LabelStatement extends NodeBase {
  type: "LabelStatement";
  label: string;
}

export type Statement =
  | LocalStatement
  | AssignmentStatement
  | CompoundAssignmentStatement
  | CallStatement
  | FunctionDeclaration
  | DoStatement
  | WhileStatement
  | RepeatStatement
  | IfStatement
  | NumericForStatement
  | GenericForStatement
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | GotoStatement
  | LabelStatement;

export interface Block {
  statements: Statement[];
}

export interface Chunk {
  block: Block;
  /** `true` when the source used Luau-only syntax. */
  luau: boolean;
}
