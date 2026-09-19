/**
 * ReVeil — deterministic random number generator.
 *
 * The generator is used everywhere in the engine: identifier name generation,
 * opcode randomisation, payload keys, transform decisions. It is a ChaCha20
 * based CSPRNG seeded from a 32-bit seed so that a given seed always produces
 * the exact same build (useful for reproducibility, caching and bug reports).
 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

const LUA_RESERVED = new Set([
  "and", "break", "continue", "do", "else", "elseif", "end", "export", "false", "for", "function",
  "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "type",
  "until", "while",
]);

/** Characters that are legal at the head of a Lua identifier. */
const NAME_HEAD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
const NAME_TAIL = `${NAME_HEAD}0123456789`;

/** JavaScript reserved words that must never be produced as an identifier. */
const JS_RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package", "private", "protected",
  "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined",
  "var", "void", "while", "with", "yield", "arguments", "eval", "NaN", "Infinity", "globalThis",
]);

/** Python keywords that must never be produced as an identifier. */
const PY_RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  "match", "case", "self", "print", "exec", "eval", "type", "object", "int", "str", "list", "dict",
]);

function rotl32(value: number, shift: number): number {
  return (((value << shift) >>> 0) | (value >>> (32 - shift))) >>> 0;
}

function quarterRound(state: number[], a: number, b: number, c: number, d: number): void {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotl32(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotl32(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotl32(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotl32(state[b] ^ state[c], 7);
}

export class ReVeilRandom {
  private state: number[] = new Array<number>(16).fill(0);
  private buffer: number[] = [];
  private counter = 0;
  private readonly nameHead: string;
  private readonly nameTail: string;
  private readonly reserved: Set<string>;
  private nameCounter = 0;
  private readonly issued = new Set<string>();

  constructor(seed: number, namespace: "lua" | "js" | "py" = "lua", salt = 0) {
    const key = [
      seed >>> 0,
      (seed ^ 0x9e3779b9) >>> 0,
      (seed ^ 0x85ebca6b) >>> 0,
      (seed ^ 0xc2b2ae35) >>> 0,
      namespace === "lua" ? 0x6c7561 : namespace === "js" ? 0x6a73 : 0x7079,
      salt >>> 0,
      (seed * 2654435761) >>> 0,
      ((seed << 7) ^ 0x27d4eb2f) >>> 0,
    ];
    for (let index = 0; index < 8; index += 1) {
      this.state[index] = key[index];
    }
    for (let index = 0; index < 4; index += 1) {
      this.state[index + 12] = SIGMA[index];
    }
    this.reserved = namespace === "js" ? JS_RESERVED : namespace === "py" ? PY_RESERVED : LUA_RESERVED;
    // Warm up the generator so that low-entropy seeds do not leak structure.
    for (let index = 0; index < 12; index += 1) {
      this.block();
    }
    this.nameHead = this.shuffled(NAME_HEAD.split(""), namespace === "js" ? 0x11 : namespace === "py" ? 0x22 : 0x33).join("");
    this.nameTail = this.shuffled(NAME_TAIL.split(""), 0x44).join("");
  }

  private block(): void {
    const working = this.state.slice();
    for (let round = 0; round < 10; round += 1) {
      quarterRound(working, 0, 4, 8, 12);
      quarterRound(working, 1, 5, 9, 13);
      quarterRound(working, 2, 6, 10, 14);
      quarterRound(working, 3, 7, 11, 15);
      quarterRound(working, 0, 5, 10, 15);
      quarterRound(working, 1, 6, 11, 12);
      quarterRound(working, 2, 7, 8, 13);
      quarterRound(working, 3, 4, 9, 14);
    }
    for (let index = 0; index < 16; index += 1) {
      working[index] = (working[index] + this.state[index]) >>> 0;
    }
    for (let index = 0; index < 16; index += 1) {
      this.buffer.push(working[index]);
    }
    this.counter = (this.counter + 1) >>> 0;
    this.state[12] = (this.state[12] + 1) >>> 0;
    if (this.state[12] === 0) {
      this.state[13] = (this.state[13] + 1) >>> 0;
    }
  }

  private take(): number {
    if (this.buffer.length === 0) {
      this.block();
    }
    return this.buffer.shift() as number;
  }

  /** Uniform 32-bit unsigned integer. */
  uint32(): number {
    return this.take() >>> 0;
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 1) {
      return 0;
    }
    // Rejection sampling keeps the distribution uniform.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let value = this.uint32();
    let guard = 0;
    while (value >= limit && guard < 64) {
      value = this.uint32();
      guard += 1;
    }
    return value % maxExclusive;
  }

  /** Uniform integer in [min, max] inclusive. */
  range(min: number, max: number): number {
    if (max <= min) {
      return min;
    }
    return min + this.int((max - min) + 1);
  }

  bool(chance = 0.5): boolean {
    return this.int(1000) < Math.floor(chance * 1000);
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new Error("ReVeilRandom.pick: empty collection");
    }
    return values[this.int(values.length)];
  }

  /** Fisher-Yates shuffle, in place. */
  shuffle<T>(values: T[]): T[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swap = this.int(index + 1);
      const temp = values[index];
      values[index] = values[swap];
      values[swap] = temp;
    }
    return values;
  }

  /** Returns a shuffled copy. */
  shuffled<T>(values: readonly T[], salt = 0): T[] {
    const copy = values.slice();
    if (salt !== 0) {
      // Rotate by a salted amount so different call sites shuffle differently.
      const offset = this.int(copy.length || 1) + (salt % 7);
      for (let index = 0; index < offset; index += 1) {
        const head = copy.shift() as T;
        copy.push(head);
      }
    }
    return this.shuffle(copy);
  }

  /** Random bytes, used for payload salt/keys. */
  bytes(length: number): Buffer {
    const out = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = this.uint32() & 0xff;
    }
    return out;
  }

  /** A fresh, colliding-free identifier in the requested alphabet. */
  identifier(minLength = 1, maxLength = 4): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const length = this.range(minLength, maxLength);
      let name = "";
      for (let index = 0; index < length; index += 1) {
        const alphabet = index === 0 ? this.nameHead : this.nameTail;
        name += alphabet[this.int(alphabet.length)];
      }
      if (this.reserved.has(name) || this.issued.has(name)) {
        continue;
      }
      this.issued.add(name);
      this.nameCounter += 1;
      return name;
    }
    // Extremely unlikely fallback with a guaranteed unique suffix.
    this.nameCounter += 1;
    const fallback = `${this.nameHead[this.int(this.nameHead.length)]}_${this.nameCounter.toString(36)}`;
    this.issued.add(fallback);
    return fallback;
  }

  /** True when the identifier was handed out by this generator before. */
  isIssued(name: string): boolean {
    return this.issued.has(name);
  }

  /** A short, deterministic hex tag derived from the current state. */
  tag(): string {
    return `${this.uint32().toString(36)}${this.uint32().toString(36)}`.slice(0, 10);
  }
}

/** Builds a stable 32-bit seed out of any string (FNV-1a). */
export function seedFromString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Time based seed used when the caller does not pin one. */
export function freshSeed(): number {
  const now = Date.now() >>> 0;
  const noise = Math.floor(Math.random() * 0x100000000) >>> 0;
  return (now ^ noise ^ 0x1d872b41) >>> 0;
}
