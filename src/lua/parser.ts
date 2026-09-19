import { ReVeilError } from "../core/errors";
import type {
  AssignmentTarget,
  BinaryExpression,
  Block,
  CallExpression,
  Chunk,
  CompoundAssignmentStatement,
  Expression,
  FunctionExpression,
  MemberExpression,
  Statement,
  TableField,
} from "./ast";
import { LuaLexer, type Token } from "./lexer";

/** Binary operator precedence, mirroring the Lua reference manual. */
const BINARY_PRECEDENCE: Record<string, [number, number]> = {
  or: [1, 1],
  and: [2, 2],
  "<": [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
  "|": [4, 4],
  "~": [5, 5],
  "&": [6, 6],
  "<<": [7, 7], ">>": [7, 7],
  "..": [9, 8],
  "+": [10, 10], "-": [10, 10],
  "*": [11, 11], "/": [11, 11], "//": [11, 11], "%": [11, 11],
  "^": [14, 13],
};

const UNARY_PRECEDENCE = 12;
const UNARY_OPERATORS = new Set(["-", "not", "#", "~"]);

const COMPOUND_OPERATORS: Record<string, string> = {
  "+=": "+", "-=": "-", "*=": "*", "/=": "/", "//=": "//", "%=": "%", "^=": "^", "..=": "..",
};

const BLOCK_TERMINATORS = new Set(["end", "else", "elseif", "until"]);

export interface ParseOptions {
  /** When false, Luau-only syntax raises an error instead of being desugared. */
  allowLuau?: boolean;
}

export class LuaParser {
  private readonly lexer: LuaLexer;
  private readonly allowLuau: boolean;

  constructor(lexer: LuaLexer, options: ParseOptions = {}) {
    this.lexer = lexer;
    this.allowLuau = options.allowLuau ?? true;
  }

  /** Parses a single expression and requires the input to end afterwards. */
  parseSingleExpression(): Expression {
    const expression = this.parseExpression();
    const token = this.lexer.peek();
    if (token.type !== "eof") {
      this.error(`unexpected ${describe(token)} after expression`, token);
    }
    return expression;
  }

  parseChunk(): Chunk {
    const block = this.parseBlock();
    const token = this.lexer.peek();
    if (token.type !== "eof") {
      this.error(`unexpected ${describe(token)}`, token);
    }
    return { block, luau: this.lexer.luauOnlyFeatures.size > 0 };
  }

  // ---------------------------------------------------------------- helpers

  private error(message: string, token?: Token): never {
    const at = token ?? this.lexer.peek();
    throw new ReVeilError(`Lua syntax error at ${at.line}:${at.column}: ${message}`, "LUA_SYNTAX");
  }

  private isKeyword(value: string, offset = 0): boolean {
    const token = this.lexer.peek(offset);
    return token.type === "keyword" && token.value === value;
  }

  private isOperator(value: string, offset = 0): boolean {
    const token = this.lexer.peek(offset);
    return token.type === "op" && token.value === value;
  }

  private expectKeyword(value: string): Token {
    if (!this.isKeyword(value)) {
      this.error(`expected '${value}' but found ${describe(this.lexer.peek())}`);
    }
    return this.lexer.next();
  }

  private expectOperator(value: string): Token {
    if (!this.isOperator(value)) {
      this.error(`expected '${value}' but found ${describe(this.lexer.peek())}`);
    }
    return this.lexer.next();
  }

  private expectName(): string {
    const token = this.lexer.next();
    if (token.type !== "name") {
      this.error(`expected a name but found ${describe(token)}`, token);
    }
    return token.value;
  }

  // ------------------------------------------------------------- statements

  private parseBlock(): Block {
    const statements: Statement[] = [];
    while (true) {
      const token = this.lexer.peek();
      if (token.type === "eof") {
        break;
      }
      if (token.type === "keyword" && BLOCK_TERMINATORS.has(token.value)) {
        break;
      }
      if (this.isReturnStatementStart()) {
        statements.push(this.parseReturn());
        break;
      }
      const statement = this.parseStatement();
      if (statement) {
        statements.push(statement);
      }
    }
    return { statements };
  }

  private isReturnStatementStart(): boolean {
    return this.isKeyword("return");
  }

  private parseReturn(): Statement {
    const token = this.expectKeyword("return");
    const args: Expression[] = [];
    const next = this.lexer.peek();
    const endsStatement =
      next.type === "eof" ||
      (next.type === "keyword" && (BLOCK_TERMINATORS.has(next.value) || next.value === "return")) ||
      (next.type === "op" && next.value === ";");
    if (!endsStatement) {
      args.push(...this.parseExpressionList());
    }
    if (this.isOperator(";")) {
      this.lexer.next();
    }
    return { type: "ReturnStatement", args, line: token.line, column: token.column };
  }

  private parseStatement(): Statement | null {
    const token = this.lexer.peek();

    if (this.isOperator(";")) {
      this.lexer.next();
      return null;
    }

    if (token.type === "keyword") {
      switch (token.value) {
        case "local": return this.parseLocal();
        case "if": return this.parseIf();
        case "while": return this.parseWhile();
        case "do": {
          this.lexer.next();
          const body = this.parseBlock();
          this.expectKeyword("end");
          return { type: "DoStatement", body, line: token.line, column: token.column };
        }
        case "for": return this.parseFor();
        case "repeat": return this.parseRepeat();
        case "function": return this.parseFunctionDeclaration(false);
        case "break": {
          this.lexer.next();
          return { type: "BreakStatement", line: token.line, column: token.column };
        }
        case "goto": {
          this.lexer.next();
          const label = this.expectName();
          return { type: "GotoStatement", label, line: token.line, column: token.column };
        }
        default:
          break;
      }
    }

    if (this.isOperator("::")) {
      this.lexer.next();
      const label = this.expectName();
      this.expectOperator("::");
      return { type: "LabelStatement", label, line: token.line, column: token.column };
    }

    // Luau soft keywords: continue / type / export type
    if (token.type === "name" && token.value === "continue" && this.looksLikeContinueStatement()) {
      this.lexer.next();
      return { type: "ContinueStatement", line: token.line, column: token.column };
    }
    if (token.type === "name" && token.value === "type" && this.isOperator("=", 1)) {
      this.lexer.next();
      this.expectOperator("=");
      this.skipType();
      return null;
    }
    if (token.type === "name" && token.value === "export" && this.lexer.peek(1).value === "type") {
      this.lexer.next();
      this.lexer.next();
      if (this.lexer.peek().type === "name") {
        this.lexer.next();
      }
      if (this.isOperator("<")) {
        this.skipType();
      }
      this.expectOperator("=");
      this.skipType();
      return null;
    }

    return this.parseExpressionStatement();
  }

  private looksLikeContinueStatement(): boolean {
    const next = this.lexer.peek(1);
    if (next.type === "eof") {
      return true;
    }
    if (next.type === "keyword") {
      return BLOCK_TERMINATORS.has(next.value) || next.value === "end" || next.value === "local" ||
        next.value === "if" || next.value === "for" || next.value === "while" || next.value === "repeat" ||
        next.value === "do" || next.value === "return" || next.value === "break" || next.value === "function";
    }
    if (next.type === "op") {
      // `continue = 1`, `continue.x`, `continue()`, `continue:y()` are identifiers.
      return !["=", ".", "(", ":", "[", ",", "\"", "'"].includes(next.value);
    }
    return true;
  }

  private parseLocal(): Statement {
    const token = this.expectKeyword("local");
    if (this.isKeyword("function")) {
      return this.parseFunctionDeclaration(true, token);
    }

    const names: string[] = [];
    while (true) {
      names.push(this.expectName());
      if (this.isOperator(":")) {
        this.skipType();
      }
      if (this.isOperator(",")) {
        this.lexer.next();
        continue;
      }
      break;
    }

    const exprs: Expression[] = [];
    if (this.isOperator("=")) {
      this.lexer.next();
      exprs.push(...this.parseExpressionList());
    }
    return { type: "LocalStatement", names, exprs, line: token.line, column: token.column };
  }

  private parseFunctionDeclaration(isLocal: boolean, localToken?: Token): Statement {
    const token = this.expectKeyword("function");
    const startLine = localToken?.line ?? token.line;
    const startColumn = localToken?.column ?? token.column;

    // Name: a.b.c or a.b:c
    let target: Expression;
    const first = this.lexer.next();
    if (first.type !== "name") {
      this.error(`expected a function name but found ${describe(first)}`, first);
    }
    target = { type: "Identifier", name: first.value, line: first.line, column: first.column };
    while (this.isOperator(".")) {
      this.lexer.next();
      const key = this.expectName();
      target = {
        type: "MemberExpression",
        base: target,
        key,
        computed: false,
        indexer: null,
        line: first.line,
        column: first.column,
      };
    }
    let isMethod = false;
    if (this.isOperator(":")) {
      this.lexer.next();
      const key = this.expectName();
      target = {
        type: "MemberExpression",
        base: target,
        key,
        computed: false,
        indexer: null,
        line: first.line,
        column: first.column,
      };
      isMethod = true;
    }

    const func = this.parseFunctionBody(isMethod, startLine, startColumn);
    return { type: "FunctionDeclaration", isLocal, target: target as never, func, line: startLine, column: startColumn };
  }

  private parseFunctionBody(isMethod: boolean, line: number, column: number): FunctionExpression {
    if (this.isOperator("<")) {
      this.skipType();
    }
    this.expectOperator("(");
    const params: string[] = [];
    let vararg = false;
    if (isMethod) {
      params.push("self");
    }
    while (!this.isOperator(")")) {
      if (this.isOperator("...")) {
        this.lexer.next();
        if (this.isOperator(":")) {
          this.skipType();
        }
        vararg = true;
        break;
      }
      const name = this.expectName();
      if (this.isOperator(":")) {
        this.skipType();
      }
      params.push(name);
      if (this.isOperator(",")) {
        this.lexer.next();
        continue;
      }
      break;
    }
    this.expectOperator(")");
    if (this.isOperator(":")) {
      // Luau return type annotation.
      this.skipType();
    }
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "FunctionExpression", params, vararg, body, line, column };
  }

  private parseIf(): Statement {
    const token = this.expectKeyword("if");
    const clauses: Array<{ condition: Expression; body: Block }> = [];
    const condition = this.parseExpression();
    this.expectKeyword("then");
    clauses.push({ condition, body: this.parseBlock() });

    while (this.isKeyword("elseif")) {
      this.lexer.next();
      const clauseCondition = this.parseExpression();
      this.expectKeyword("then");
      clauses.push({ condition: clauseCondition, body: this.parseBlock() });
    }

    let elseBody: Block | null = null;
    if (this.isKeyword("else")) {
      this.lexer.next();
      elseBody = this.parseBlock();
    }
    this.expectKeyword("end");
    return { type: "IfStatement", clauses, elseBody, line: token.line, column: token.column };
  }

  private parseWhile(): Statement {
    const token = this.expectKeyword("while");
    const condition = this.parseExpression();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "WhileStatement", condition, body, line: token.line, column: token.column };
  }

  private parseRepeat(): Statement {
    const token = this.expectKeyword("repeat");
    const body = this.parseBlock();
    this.expectKeyword("until");
    const condition = this.parseExpression();
    return { type: "RepeatStatement", body, condition, line: token.line, column: token.column };
  }

  private parseFor(): Statement {
    const token = this.expectKeyword("for");
    const first = this.expectName();
    if (this.isOperator(":")) {
      this.skipType();
    }

    if (this.isOperator("=")) {
      this.lexer.next();
      const start = this.parseExpression();
      this.expectOperator(",");
      const limit = this.parseExpression();
      let step: Expression | null = null;
      if (this.isOperator(",")) {
        this.lexer.next();
        step = this.parseExpression();
      }
      this.expectKeyword("do");
      const body = this.parseBlock();
      this.expectKeyword("end");
      return {
        type: "NumericForStatement", variable: first, start, limit, step, body,
        line: token.line, column: token.column,
      };
    }

    const variables = [first];
    while (this.isOperator(",")) {
      this.lexer.next();
      variables.push(this.expectName());
      if (this.isOperator(":")) {
        this.skipType();
      }
    }
    this.expectKeyword("in");
    const exprs = this.parseExpressionList();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return {
      type: "GenericForStatement", variables, exprs, body,
      line: token.line, column: token.column,
    };
  }

  private parseExpressionStatement(): Statement {
    const start = this.lexer.peek();
    const first = this.parseSuffixedExpression();

    if (this.isOperator("=") || this.isOperator(",")) {
      const targets: AssignmentTarget[] = [this.asAssignmentTarget(first)];
      while (this.isOperator(",")) {
        this.lexer.next();
        const next = this.parseSuffixedExpression();
        targets.push(this.asAssignmentTarget(next));
      }
      this.expectOperator("=");
      const exprs = this.parseExpressionList();
      return { type: "AssignmentStatement", targets, exprs, line: start.line, column: start.column };
    }

    const compound = this.lexer.peek();
    if (compound.type === "op" && COMPOUND_OPERATORS[compound.value]) {
      this.lexer.next();
      const target = this.asAssignmentTarget(first);
      const value = this.parseExpression();
      const statement: CompoundAssignmentStatement = {
        type: "CompoundAssignmentStatement",
        operator: COMPOUND_OPERATORS[compound.value],
        target,
        value,
        line: start.line,
        column: start.column,
      };
      return statement;
    }

    if (first.type !== "CallExpression") {
      this.error("syntax error: expression is not a statement", start);
    }
    return { type: "CallStatement", call: first, line: start.line, column: start.column };
  }

  private asAssignmentTarget(expression: Expression): AssignmentTarget {
    if (expression.type === "Identifier" || expression.type === "MemberExpression") {
      return expression;
    }
    this.error("cannot assign to this expression");
  }

  // ------------------------------------------------------------ expressions

  private parseExpressionList(): Expression[] {
    const exprs: Expression[] = [this.parseExpression()];
    while (this.isOperator(",")) {
      this.lexer.next();
      exprs.push(this.parseExpression());
    }
    return exprs;
  }

  private parseExpression(minPrecedence = 0): Expression {
    let left = this.parseUnaryExpression();

    while (true) {
      const token = this.lexer.peek();
      const operator = token.value;
      const precedence = BINARY_PRECEDENCE[operator];
      if (!precedence || (token.type !== "op" && token.type !== "keyword")) {
        break;
      }
      const [leftPower, rightPower] = precedence;
      if (leftPower <= minPrecedence) {
        break;
      }
      this.lexer.next();
      const right = this.parseExpression(rightPower);
      const node: BinaryExpression = {
        type: "BinaryExpression",
        operator,
        left,
        right,
        line: token.line,
        column: token.column,
      };
      left = node;
    }

    return left;
  }

  private parseUnaryExpression(): Expression {
    const token = this.lexer.peek();
    const isUnary =
      (token.type === "op" && UNARY_OPERATORS.has(token.value)) ||
      (token.type === "keyword" && token.value === "not");
    if (isUnary) {
      this.lexer.next();
      const argument = this.parseExpression(UNARY_PRECEDENCE);
      return {
        type: "UnaryExpression",
        operator: token.value,
        argument,
        line: token.line,
        column: token.column,
      };
    }
    return this.parseSuffixedExpression();
  }

  private parseSuffixedExpression(): Expression {
    let expression = this.parsePrimaryExpression();

    while (true) {
      const token = this.lexer.peek();
      if (token.type === "op" && token.value === ".") {
        this.lexer.next();
        const key = this.expectName();
        expression = {
          type: "MemberExpression",
          base: expression,
          key,
          computed: false,
          indexer: null,
          line: token.line,
          column: token.column,
        };
        continue;
      }
      if (token.type === "op" && token.value === "[") {
        this.lexer.next();
        const indexer = this.parseExpression();
        this.expectOperator("]");
        expression = {
          type: "MemberExpression",
          base: expression,
          key: "",
          computed: true,
          indexer,
          line: token.line,
          column: token.column,
        };
        continue;
      }
      if (token.type === "op" && token.value === ":") {
        this.lexer.next();
        const method = this.expectName();
        const args = this.parseCallArguments();
        expression = {
          type: "CallExpression",
          base: expression,
          method,
          args,
          line: token.line,
          column: token.column,
        };
        continue;
      }
      if (
        (token.type === "op" && (token.value === "(" || token.value === "{")) ||
        token.type === "string" ||
        token.type === "interp"
      ) {
        const args = this.parseCallArguments();
        expression = {
          type: "CallExpression",
          base: expression,
          method: null,
          args,
          line: token.line,
          column: token.column,
        };
        continue;
      }
      break;
    }

    return expression;
  }

  private parseCallArguments(): Expression[] {
    const token = this.lexer.peek();
    if (token.type === "op" && token.value === "(") {
      this.lexer.next();
      const args: Expression[] = [];
      if (!this.isOperator(")")) {
        args.push(...this.parseExpressionList());
      }
      this.expectOperator(")");
      return args;
    }
    if (token.type === "op" && token.value === "{") {
      return [this.parseTableConstructor()];
    }
    if (token.type === "string" || token.type === "interp") {
      return [this.parsePrimaryExpression()];
    }
    this.error(`expected call arguments but found ${describe(token)}`, token);
  }

  private parsePrimaryExpression(): Expression {
    const token = this.lexer.peek();

    switch (token.type) {
      case "number": {
        this.lexer.next();
        return {
          type: "NumberLiteral",
          value: token.numeric as number,
          raw: token.value,
          isFloat: token.float === true,
          line: token.line,
          column: token.column,
        };
      }
      case "string": {
        this.lexer.next();
        return { type: "StringLiteral", value: token.text ?? "", raw: token.value, line: token.line, column: token.column };
      }
      case "interp": {
        this.lexer.next();
        const parts: Array<{ kind: "text"; value: string } | { kind: "expr"; expression: Expression }> = [];
        for (const part of token.parts ?? []) {
          if (part.kind === "text") {
            parts.push({ kind: "text", value: part.value });
          } else {
            const sub = new LuaParser(new LuaLexer(part.value), { allowLuau: this.allowLuau });
            parts.push({ kind: "expr", expression: sub.parseSingleExpression() });
          }
        }
        return { type: "InterpolatedString", parts, line: token.line, column: token.column };
      }
      case "name": {
        this.lexer.next();
        return { type: "Identifier", name: token.value, line: token.line, column: token.column };
      }
      case "keyword": {
        switch (token.value) {
          case "nil":
            this.lexer.next();
            return { type: "NilLiteral", line: token.line, column: token.column };
          case "true":
          case "false":
            this.lexer.next();
            return { type: "BooleanLiteral", value: token.value === "true", line: token.line, column: token.column };
          case "function": {
            this.lexer.next();
            return this.parseFunctionBody(false, token.line, token.column);
          }
          case "if": {
            this.lexer.next();
            return this.parseIfExpression(token.line, token.column);
          }
          default:
            break;
        }
        break;
      }
      case "op": {
        switch (token.value) {
          case "...":
            this.lexer.next();
            return { type: "VarargLiteral", line: token.line, column: token.column };
          case "{":
            return this.parseTableConstructor();
          case "(": {
            this.lexer.next();
            const expression = this.parseExpression();
            this.expectOperator(")");
            // Parentheses stop multi-value expansion.
            expression.parenthesized = true;
            return expression;
          }
          default:
            break;
        }
        break;
      }
      default:
        break;
    }

    this.error(`unexpected ${describe(token)}`, token);
  }

  private parseIfExpression(line: number, column: number): Expression {
    const clauses: Array<{ condition: Expression; value: Expression }> = [];
    const condition = this.parseExpression();
    this.expectKeyword("then");
    const value = this.parseExpression();
    clauses.push({ condition, value });

    while (this.isKeyword("elseif")) {
      this.lexer.next();
      const clauseCondition = this.parseExpression();
      this.expectKeyword("then");
      const clauseValue = this.parseExpression();
      clauses.push({ condition: clauseCondition, value: clauseValue });
    }

    if (!this.isKeyword("else")) {
      this.error("Luau if-expression requires an else branch");
    }
    this.lexer.next();
    const elseValue = this.parseExpression();
    return { type: "IfExpression", clauses, elseValue, line, column };
  }

  private parseTableConstructor(): Expression {
    const token = this.expectOperator("{");
    const fields: TableField[] = [];

    while (!this.isOperator("}")) {
      const start = this.lexer.peek();
      if (this.isOperator("[")) {
        this.lexer.next();
        const key = this.parseExpression();
        this.expectOperator("]");
        this.expectOperator("=");
        const value = this.parseExpression();
        fields.push({ kind: "computed", key, value, line: start.line, column: start.column });
      } else if (start.type === "name" && this.isOperator("=", 1)) {
        this.lexer.next();
        this.lexer.next();
        const value = this.parseExpression();
        fields.push({ kind: "record", key: start.value, value, line: start.line, column: start.column });
      } else {
        const value = this.parseExpression();
        fields.push({ kind: "array", value, line: start.line, column: start.column });
      }

      if (this.isOperator(",") || this.isOperator(";")) {
        this.lexer.next();
        continue;
      }
      break;
    }

    this.expectOperator("}");
    return { type: "TableConstructor", fields, line: token.line, column: token.column };
  }

  // -------------------------------------------------------------- Luau types

  /** Consumes a Luau type annotation without interpreting it. */
  private skipType(): void {
    if (!this.allowLuau) {
      this.error("Luau type annotations require the luau target");
    }
    const stopKeywords = new Set([
      "end", "do", "then", "else", "elseif", "until", "local", "if", "for", "while", "repeat",
      "return", "function", "break", "continue", "export", "type",
    ]);
    let depth = 0;
    let guard = 0;
    while (guard < 4096) {
      guard += 1;
      const token = this.lexer.peek();
      if (token.type === "eof") {
        this.error("unterminated type annotation", token);
      }
      if (token.type === "op") {
        if (token.value === "(" || token.value === "{" || token.value === "[") {
          depth += 1;
        } else if (token.value === ")" || token.value === "}" || token.value === "]") {
          if (depth === 0) {
            return;
          }
          depth -= 1;
        } else if (depth === 0 && (token.value === "," || token.value === "=" || token.value === ";")) {
          return;
        }
        this.lexer.next();
        continue;
      }
      if (token.type === "keyword" && depth === 0 && stopKeywords.has(token.value)) {
        return;
      }
      this.lexer.next();
    }
    this.error("type annotation is too complex to skip");
  }
}

function describe(token: Token): string {
  if (token.type === "eof") {
    return "end of file";
  }
  return `'${token.value}'`;
}

export function parseLua(source: string, options: ParseOptions = {}): Chunk {
  const lexer = new LuaLexer(source);
  const parser = new LuaParser(lexer, options);
  return parser.parseChunk();
}
