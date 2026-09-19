/**
 * ReVeil bytecode container.
 *
 * The compiler lowers Lua/Luau ASTs into flat, stack based ReVeil bytecode.
 * Every opcode is written here in canonical form; the per-build profile then
 * maps canoncial names onto random numeric opcodes, so two ReVeil builds never
 * share an encoding.
 */

export const OP = {
  LOADK: "LOADK",
  LOADF: "LOADF",
  LOADSTR: "LOADSTR",
  LOADBOOL: "LOADBOOL",
  LOADNIL: "LOADNIL",
  LOADL: "LOADL",
  STOREL: "STOREL",
  LOADC: "LOADC",
  STOREC: "STOREC",
  CELLNEW: "CELLNEW",
  MAKEF: "MAKEF",
  CELLSET: "CELLSET",
  LOADG: "LOADG",
  LOADENV: "LOADENV",
  STOREG: "STOREG",
  LOADU: "LOADU",
  STOREU: "STOREU",
  NEWT: "NEWT",
  GETI: "GETI",
  SETI: "SETI",
  GETS: "GETS",
  SETS: "SETS",
  SETSAT: "SETSAT",
  SETIAT: "SETIAT",
  SELF: "SELF",
  APPENDAT: "APPENDAT",
  APPENDMAT: "APPENDMAT",
  NEWA: "NEWA",
  ADD: "ADD",
  SUB: "SUB",
  MUL: "MUL",
  DIV: "DIV",
  IDIV: "IDIV",
  MOD: "MOD",
  POW: "POW",
  CONCAT: "CONCAT",
  BAND: "BAND",
  BOR: "BOR",
  BXOR: "BXOR",
  SHL: "SHL",
  SHR: "SHR",
  UNM: "UNM",
  NOTOP: "NOTOP",
  LEN: "LEN",
  BNOT: "BNOT",
  EQ: "EQ",
  NE: "NE",
  LT: "LT",
  LE: "LE",
  GT: "GT",
  GE: "GE",
  JMP: "JMP",
  JT: "JT",
  JF: "JF",
  JTK: "JTK",
  JFK: "JFK",
  POP: "POP",
  DUP: "DUP",
  SETTOP: "SETTOP",
  CALL: "CALL",
  RET: "RET",
  CLOSURE: "CLOSURE",
  VARARG: "VARARG",
  FORPREP: "FORPREP",
  FORLOOP: "FORLOOP",
  TF: "TF",
} as const;

export type OpName = keyof typeof OP;

/** Operand count (excluding the opcode word) for every canonical opcode. */
export const OP_ARITY: Record<OpName, number> = {
  LOADK: 1, LOADF: 1, LOADSTR: 1, LOADBOOL: 1, LOADNIL: 0,
  LOADL: 1, STOREL: 1, LOADC: 1, STOREC: 1,
  CELLNEW: 1, MAKEF: 3, CELLSET: 2,
  LOADG: 1, LOADENV: 0, STOREG: 1, LOADU: 1, STOREU: 1,
  NEWT: 0, GETI: 0, SETI: 0, GETS: 1, SETS: 1, SETSAT: 2, SETIAT: 1,
  SELF: 1, APPENDAT: 2, APPENDMAT: 2, NEWA: 1,
  ADD: 0, SUB: 0, MUL: 0, DIV: 0, IDIV: 0, MOD: 0, POW: 0, CONCAT: 0,
  BAND: 0, BOR: 0, BXOR: 0, SHL: 0, SHR: 0,
  UNM: 0, NOTOP: 0, LEN: 0, BNOT: 0,
  EQ: 0, NE: 0, LT: 0, LE: 0, GT: 0, GE: 0,
  JMP: 1, JT: 1, JF: 1, JTK: 1, JFK: 1, POP: 0, DUP: 0, SETTOP: 1,
  CALL: 2, RET: 2, CLOSURE: 1, VARARG: 2,
  FORPREP: 5, FORLOOP: 5, TF: 4,
};

/** Canonical opcode order — the index is NOT the emitted encoding. */
export const OP_SEQUENCE: OpName[] = Object.keys(OP) as OpName[];

export type Instruction = [OpName, ...number[]];

export interface Proto {
  /** Number of declared parameters (slots 1..params are filled from varargs). */
  params: number;
  vararg: boolean;
  /** Upvalue descriptors: > 0 = parent cell slot, < 0 = parent upvalue index. */
  updesc: number[];
  code: Instruction[];
  maxSlots: number;
  name: string;
}

export interface Program {
  protos: Proto[];
  strings: string[];
  numbers: number[];
  entry: number;
}

export function makeProto(name: string, params: number, vararg: boolean): Proto {
  return { params, vararg, updesc: [], code: [], maxSlots: params + 4, name };
}

/**
 * Serialises a program into the compact, byte safe payload format understood by
 * the bundled runtime:
 *
 *   Z            nil
 *   T / F        boolean
 *   N<text>;     number (`#I`, `#J`, `#K` for inf / -inf / nan)
 *   S<len>:<raw> byte string
 *   A<count>[..] array
 */
export class PayloadWriter {
  private readonly out: number[] = [];

  ascii(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.out.push(value.charCodeAt(index) & 0xff);
    }
  }

  /** Writes a latin1 "byte string" (charCode === byte value). */
  bytes(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.out.push(value.charCodeAt(index) & 0xff);
    }
  }

  /** Floats are always written with a fractional part so `tonumber` keeps them floats. */
  float(value: number): void {
    if (Number.isNaN(value)) {
      this.ascii("#K");
      return;
    }
    if (value === Infinity) {
      this.ascii("#I");
      return;
    }
    if (value === -Infinity) {
      this.ascii("#J");
      return;
    }
    const text = String(value);
    this.ascii(/[.eE]/.test(text) ? text : `${text}.0`);
  }

  number(value: number): void {
    if (Number.isNaN(value)) {
      this.ascii("#K");
      return;
    }
    if (value === Infinity) {
      this.ascii("#I");
      return;
    }
    if (value === -Infinity) {
      this.ascii("#J");
      return;
    }
    if (Number.isInteger(value) && Math.abs(value) < 1e15) {
      this.ascii(String(value));
      return;
    }
    // Shortest round-trippable representation.
    this.ascii(String(value));
  }

  string(value: string): void {
    this.ascii(`S${value.length}:`);
    this.bytes(value);
  }

  array(values: unknown[]): void {
    this.ascii(`A${values.length}[`);
    for (const entry of values) {
      this.value(entry);
    }
    this.ascii("]");
  }

  value(entry: unknown): void {
    if (entry === null || entry === undefined) {
      this.ascii("Z");
      return;
    }
    if (typeof entry === "boolean") {
      this.ascii(entry ? "T" : "F");
      return;
    }
    if (typeof entry === "number") {
      this.ascii("N");
      this.number(entry);
      this.ascii(";");
      return;
    }
    if (typeof entry === "string") {
      this.string(entry);
      return;
    }
    this.array(entry as Array<string | number | null | boolean | unknown[]>);
  }

  toBuffer(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

export function serializeProgram(program: Program, encodeOp: (op: OpName) => number): Uint8Array {
  const writer = new PayloadWriter();
  const protos = program.protos.map((proto) => [
    proto.params,
    proto.vararg ? 1 : 0,
    proto.updesc,
    proto.code.length === 0 ? [] : flattenCode(proto.code, encodeOp),
    proto.maxSlots,
  ]);
  // The payload is a single array: [protos, strings, numbers, entry].
  writer.ascii("A4[");
  writer.array(protos as unknown[]);
  writer.array(program.strings as unknown[]);
  // Floats keep their identity through the payload: they live in their own
  // pool and are written with an explicit fractional part.
  writer.ascii(`A${program.numbers.length}[`);
  for (const value of program.numbers) {
    writer.ascii("N");
    writer.float(value);
    writer.ascii(";");
  }
  writer.ascii("]");
  writer.value(program.entry);
  writer.ascii("]");
  return writer.toBuffer();
}

/** Flattens instructions into the word stream the VM executes. */
function flattenCode(code: Instruction[], encodeOp: (op: OpName) => number): number[] {
  const out: number[] = [];
  for (const instruction of code) {
    out.push(encodeOp(instruction[0]));
    for (let index = 1; index < instruction.length; index += 1) {
      const part = instruction[index] as number;
      out.push(part);
    }
  }
  return out;
}
