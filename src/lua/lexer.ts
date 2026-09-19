import { ReVeilError } from "../core/errors";

export type TokenType = "name" | "number" | "string" | "keyword" | "op" | "interp" | "eof";

export interface InterpPart {
  kind: "text" | "expr";
  value: string;
}

export interface Token {
  type: TokenType;
  value: string;
  /** Numeric value for `number` tokens. */
  numeric?: number;
  /** True for literals Lua would treat as floats (1.0, 1e3, 0x1p4). */
  float?: boolean;
  /** Decoded string for `string` tokens. */
  text?: string;
  /** Parts for `interp` (Luau backtick string) tokens. */
  parts?: InterpPart[];
  line: number;
  column: number;
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

/** Luau soft keywords handled positionally by the parser. */
export const LUAU_SOFT_KEYWORDS = new Set(["continue", "type", "export", "typeof"]);

const OPERATOR_START = "+-*/%^#&~|<>=(){}[];:,.?";
const COMPOUND_OPERATORS = ["//=", "..=", "+=", "-=", "*=", "/=", "%=", "^="];
const SIMPLE_OPERATORS_THREE = ["..."];
const SIMPLE_OPERATORS_TWO = ["//", "..", "==", "~=", "<=", ">=", "<<", ">>", "::", "->"];

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isHexDigit(char: string): boolean {
  return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

function isNameStart(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
}

function isNamePart(char: string): boolean {
  return isNameStart(char) || isDigit(char);
}

export class LuaLexer {
  private readonly source: string;
  private index = 0;
  private line = 1;
  private column = 1;
  private lookahead: Token[] = [];
  private readonly tokens: Token[] = [];
  private cursor = 0;
  luauOnlyFeatures = new Set<string>();

  constructor(source: string) {
    // Strip a UTF-8 BOM and a shebang line, both are legal in real world files.
    let text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    if (text.startsWith("#!")) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : `\n${text.slice(newline + 1)}`;
    }
    this.source = text;
    this.tokenizeAll();
  }

  private error(message: string, line = this.line, column = this.column): never {
    throw new ReVeilError(`Lua syntax error at ${line}:${column}: ${message}`, "LUA_SYNTAX");
  }

  peek(offset = 0): Token {
    const token = this.tokens[this.cursor + offset];
    if (token) {
      return token;
    }
    const last = this.tokens[this.tokens.length - 1];
    return last ?? { type: "eof", value: "", line: this.line, column: this.column };
  }

  next(): Token {
    const token = this.peek();
    if (token.type !== "eof") {
      this.cursor += 1;
    }
    return token;
  }

  /** All tokens (used by tests / tooling). */
  all(): Token[] {
    return this.tokens.slice();
  }

  private char(offset = 0): string {
    return this.source[this.index + offset] ?? "";
  }

  private advance(count = 1): void {
    for (let step = 0; step < count; step += 1) {
      if (this.source[this.index] === "\n") {
        this.line += 1;
        this.column = 1;
      } else {
        this.column += 1;
      }
      this.index += 1;
    }
  }

  private push(token: Omit<Token, "line" | "column"> & { line?: number; column?: number }): void {
    this.tokens.push({
      ...token,
      line: token.line ?? this.line,
      column: token.column ?? this.column,
    } as Token);
  }

  private tokenizeAll(): void {
    while (this.index < this.source.length) {
      this.step();
    }
    this.push({ type: "eof", value: "" });
  }

  private step(): void {
    const char = this.char();

    if (char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f" || char === "\v") {
      this.advance();
      return;
    }

    if (char === "-" && this.char(1) === "-") {
      this.skipComment();
      return;
    }

    const line = this.line;
    const column = this.column;

    if (isDigit(char) || (char === "." && isDigit(this.char(1)))) {
      this.readNumber(line, column);
      return;
    }

    if (isNameStart(char)) {
      this.readName(line, column);
      return;
    }

    if (char === '"' || char === "'") {
      this.readShortString(char, line, column);
      return;
    }

    if (char === "[") {
      const longBracket = this.tryLongBracket();
      if (longBracket) {
        this.push({ type: "string", value: longBracket.raw, text: longBracket.text, line, column });
        return;
      }
    }

    if (char === "`") {
      this.readInterpolatedString(line, column);
      return;
    }

    if (OPERATOR_START.includes(char)) {
      this.readOperator(line, column);
      return;
    }

    this.error(`unexpected character ${JSON.stringify(char)}`);
  }

  private skipComment(): void {
    this.advance(2);
    if (this.char() === "[") {
      const bracket = this.tryLongBracket(true);
      if (bracket) {
        return;
      }
    }
    while (this.index < this.source.length && this.char() !== "\n") {
      this.advance();
    }
  }

  /** Reads `[[ ... ]]` or `[==[ ... ]==]`; returns null when it is not a long bracket. */
  private tryLongBracket(comment = false): { raw: string; text: string } | null {
    const start = this.index;
    let cursor = 0;
    if (this.char(cursor) !== "[") {
      return null;
    }
    cursor += 1;
    let equals = 0;
    while (this.char(cursor) === "=") {
      equals += 1;
      cursor += 1;
    }
    if (this.char(cursor) !== "[") {
      return null;
    }
    cursor += 1;

    const openLine = this.line;
    const openColumn = this.column;
    const closer = `]${"=".repeat(equals)}]`;
    const contentStart = this.index + cursor;
    // Long strings skip a leading newline immediately after the opener.
    let content = this.source.slice(contentStart);
    const closeIndex = content.indexOf(closer);
    if (closeIndex === -1) {
      this.index = start;
      this.line = openLine;
      this.column = openColumn;
      this.error(comment ? "unterminated block comment" : "unterminated long string");
    }
    const consumed = cursor + closeIndex + closer.length;
    const raw = this.source.slice(this.index, this.index + consumed);
    let text = content.slice(0, closeIndex);
    if (text.startsWith("\r\n")) {
      text = text.slice(2);
    } else if (text.startsWith("\n")) {
      text = text.slice(1);
    }
    text = text.replace(/\r\n/g, "\n");
    this.advance(consumed);
    return { raw, text };
  }

  private readNumber(line: number, column: number): void {
    const start = this.index;
    let isHex = false;
    let isBinary = false;

    if (this.char() === "0" && (this.char(1) === "x" || this.char(1) === "X")) {
      isHex = true;
      this.advance(2);
      while (isHexDigit(this.char()) || this.char() === "_") {
        this.advance();
      }
      if (this.char() === "." && isHexDigit(this.char(1))) {
        this.advance();
        while (isHexDigit(this.char()) || this.char() === "_") {
          this.advance();
        }
      }
      if (this.char() === "p" || this.char() === "P") {
        this.advance();
        if (this.char() === "+" || this.char() === "-") {
          this.advance();
        }
        while (isDigit(this.char()) || this.char() === "_") {
          this.advance();
        }
      }
    } else if (this.char() === "0" && (this.char(1) === "b" || this.char(1) === "B")) {
      isBinary = true;
      this.advance(2);
      while (this.char() === "0" || this.char() === "1" || this.char() === "_") {
        this.advance();
      }
    } else {
      while (isDigit(this.char()) || this.char() === "_") {
        this.advance();
      }
      // Only treat `.` as part of the number when it is not the concat operator.
      if (this.char() === "." && this.char(1) !== ".") {
        this.advance();
        while (isDigit(this.char()) || this.char() === "_") {
          this.advance();
        }
      }
      if (this.char() === "e" || this.char() === "E") {
        const save = this.index;
        const saveLine = this.line;
        const saveColumn = this.column;
        this.advance();
        if (this.char() === "+" || this.char() === "-") {
          this.advance();
        }
        if (isDigit(this.char())) {
          while (isDigit(this.char()) || this.char() === "_") {
            this.advance();
          }
        } else {
          this.index = save;
          this.line = saveLine;
          this.column = saveColumn;
        }
      }
    }

    const raw = this.source.slice(start, this.index);
    const cleaned = raw.replace(/_/g, "");
    let value: number;
    if (isHex) {
      value = parseHexNumber(cleaned);
    } else if (isBinary) {
      value = parseInt(cleaned.slice(2), 2);
    } else {
      value = Number(cleaned);
    }
    if (!Number.isFinite(value)) {
      this.error(`malformed number ${raw}`, line, column);
    }
    const isFloat = isHex
      ? /[pP.]/.test(cleaned)
      : /[.eE]/.test(cleaned);
    this.push({ type: "number", value: raw, numeric: value, float: isFloat, line, column });
  }

  private readName(line: number, column: number): void {
    const start = this.index;
    while (isNamePart(this.char())) {
      this.advance();
    }
    const name = this.source.slice(start, this.index);
    if (KEYWORDS.has(name)) {
      this.push({ type: "keyword", value: name, line, column });
    } else {
      this.push({ type: "name", value: name, line, column });
    }
  }

  private readShortString(quote: string, line: number, column: number): void {
    const rawStart = this.index;
    this.advance();
    let value = "";
    while (true) {
      const char = this.char();
      if (char === "" || char === "\n") {
        this.error("unterminated string", line, column);
      }
      if (char === quote) {
        this.advance();
        break;
      }
      if (char === "\\") {
        this.advance();
        value += this.readEscape(line, column);
        continue;
      }
      value += char;
      this.advance();
    }
    this.push({
      type: "string",
      value: this.source.slice(rawStart, this.index),
      text: value,
      line,
      column,
    });
  }

  private readEscape(line: number, column: number): string {
    const char = this.char();
    this.advance();
    switch (char) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "a": return "\x07";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "\\": return "\\";
      case '"': return '"';
      case "'": return "'";
      case "\n": return "\n";
      case "\r":
        if (this.char() === "\n") {
          this.advance();
        }
        return "\n";
      case "x": {
        let hex = "";
        while (/[0-9a-fA-F]/.test(this.char()) && hex.length < 2) {
          hex += this.char();
          this.advance();
        }
        if (hex.length === 0) {
          this.error("invalid hexadecimal escape");
        }
        return String.fromCharCode(parseInt(hex, 16));
      }
      case "z": {
        while (/\s/.test(this.char())) {
          this.advance();
        }
        return "";
      }
      case "u": {
        if (this.char() !== "{") {
          this.error("invalid unicode escape");
        }
        this.advance();
        let hex = "";
        while (this.char() !== "}" && this.char() !== "") {
          hex += this.char();
          this.advance();
        }
        this.advance();
        const code = parseInt(hex, 16);
        if (!Number.isFinite(code)) {
          this.error("invalid unicode escape");
        }
        return String.fromCodePoint(code);
      }
      default: {
        if (isDigit(char)) {
          let digits = char;
          while (isDigit(this.char()) && digits.length < 3) {
            digits += this.char();
            this.advance();
          }
          const code = parseInt(digits, 10);
          if (code > 255) {
            this.error(`decimal escape \\${digits} is out of range`, line, column);
          }
          return String.fromCharCode(code);
        }
        this.error(`invalid escape sequence \\${char}`, line, column);
      }
    }
  }

  private readInterpolatedString(line: number, column: number): void {
    this.advance();
    const parts: InterpPart[] = [];
    let text = "";
    while (true) {
      const char = this.char();
      if (char === "" || char === "\n") {
        this.error("unterminated interpolated string", line, column);
      }
      if (char === "`") {
        this.advance();
        break;
      }
      if (char === "\\") {
        this.advance();
        text += this.readEscape(line, column);
        continue;
      }
      if (char === "{") {
        if (text.length > 0) {
          parts.push({ kind: "text", value: text });
          text = "";
        }
        this.advance();
        let depth = 1;
        let source = "";
        while (depth > 0) {
          const inner = this.char();
          if (inner === "") {
            this.error("unterminated interpolation", line, column);
          }
          if (inner === "{") {
            depth += 1;
          } else if (inner === "}") {
            depth -= 1;
            if (depth === 0) {
              this.advance();
              break;
            }
          } else if (inner === '"' || inner === "'") {
            // Copy nested string literals verbatim so braces inside them are inert.
            source += inner;
            this.advance();
            while (this.char() !== inner && this.char() !== "") {
              if (this.char() === "\\") {
                source += this.char();
                this.advance();
              }
              source += this.char();
              this.advance();
            }
            source += inner;
            this.advance();
            continue;
          }
          source += inner;
          this.advance();
        }
        parts.push({ kind: "expr", value: source });
        continue;
      }
      text += char;
      this.advance();
    }
    if (text.length > 0) {
      parts.push({ kind: "text", value: text });
    }
    this.luauOnlyFeatures.add("interpolated-string");
    this.push({ type: "interp", value: "`", parts, line, column });
  }

  private readOperator(line: number, column: number): void {
    const three = this.source.slice(this.index, this.index + 3);
    if (COMPOUND_OPERATORS.includes(three)) {
      this.luauOnlyFeatures.add("compound-assignment");
      this.advance(3);
      this.push({ type: "op", value: three, line, column });
      return;
    }
    if (SIMPLE_OPERATORS_THREE.includes(three)) {
      this.advance(3);
      this.push({ type: "op", value: three, line, column });
      return;
    }
    const two = this.source.slice(this.index, this.index + 2);
    if (COMPOUND_OPERATORS.includes(two)) {
      this.luauOnlyFeatures.add("compound-assignment");
      this.advance(2);
      this.push({ type: "op", value: two, line, column });
      return;
    }
    if (SIMPLE_OPERATORS_TWO.includes(two)) {
      if (two === "//") {
        this.luauOnlyFeatures.add("floor-division");
      }
      if (two === "->") {
        this.luauOnlyFeatures.add("type-annotation");
      }
      this.advance(2);
      this.push({ type: "op", value: two, line, column });
      return;
    }
    const char = this.char();
    this.advance();
    this.push({ type: "op", value: char, line, column });
  }
}

function parseHexNumber(cleaned: string): number {
  const body = cleaned.slice(2);
  const exponentIndex = body.search(/[pP]/);
  if (exponentIndex === -1) {
    const [intPart, fracPart] = body.split(".");
    let value = parseInt(intPart.length > 0 ? intPart : "0", 16);
    if (fracPart) {
      let scale = 1 / 16;
      for (const digit of fracPart) {
        value += parseInt(digit, 16) * scale;
        scale /= 16;
      }
    }
    return value;
  }
  const mantissa = body.slice(0, exponentIndex);
  const exponent = parseInt(body.slice(exponentIndex + 1), 10) || 0;
  const [intPart, fracPart] = mantissa.split(".");
  let value = 0;
  for (const digit of intPart) {
    value = value * 16 + parseInt(digit, 16);
  }
  let scale = 1 / 16;
  for (const digit of fracPart ?? "") {
    value += parseInt(digit, 16) * scale;
    scale /= 16;
  }
  return value * 2 ** exponent;
}
