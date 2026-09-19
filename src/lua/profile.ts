import type { ReVeilRandom } from "../core/rng";
import { mul32 } from "../core/cipher";
import { OP_SEQUENCE, type OpName } from "./bytecode";

/**
 * Per-build VM profile: opcode numbering, runtime identifier names, cipher key
 * material and the ordering of the dispatch chain. Two ReVeil builds never
 * share an encoding, so signatures cannot be reused across files.
 */
export interface LuaProfile {
  opcodes: Record<OpName, number>;
  names: Record<string, string>;
  salt: string;
  seed: number;
  phase: number;
  seedParts: [number, number, number];
  phaseParts: [number, number];
  /** Opcodes emitted in frequency order first, the rest shuffled. */
  dispatchOrder: OpName[];
  usesBitwise: boolean;
  usesIdiv: boolean;
  /** The compiled program needs the presized-table helper. */
  usesPresize: boolean;
  decoyCount: number;
}

const HOT_OPS: OpName[] = [
  "LOADL", "LOADSTR", "LOADK", "CALL", "GETS", "GETI", "SETS", "SETI", "STOREL",
  "LOADG", "STOREG", "JMP", "JF", "JT", "RET", "NEWT", "CLOSURE", 
];

export interface ProfileInput {
  rng: ReVeilRandom;
  seed: number;
  usesBitwise: boolean;
  usesIdiv: boolean;
  /** The compiled program needs the presized-table helper. */
  usesPresize?: boolean;
  decoys: boolean;
}

export function createLuaProfile(input: ProfileInput): LuaProfile {
  const { rng } = input;

  // Random, unique opcode values. Small numbers keep the payload compact and
  // the dispatch chain comparisons cheap.
  const pool: number[] = [];
  for (let value = 1; value <= 255; value += 1) {
    pool.push(value);
  }
  rng.shuffle(pool);
  const opcodes = {} as Record<OpName, number>;
  OP_SEQUENCE.forEach((name, index) => {
    opcodes[name] = index < pool.length ? pool[index] : 256 + index;
  });

  const names: Record<string, string> = {};
  for (const key of NAME_KEYS) {
    names[key] = rng.identifier(1, 3);
  }

  const dispatchOrder: OpName[] = [];
  for (const name of HOT_OPS) {
    dispatchOrder.push(name);
  }
  const rest = OP_SEQUENCE.filter((name) => !HOT_OPS.includes(name));
  dispatchOrder.push(...rng.shuffle(rest));

  const salt = Array.from({ length: rng.range(6, 14) }, () =>
    String.fromCharCode(rng.range(33, 126)),
  ).join("");

  const seed = input.seed >>> 0;
  const phase = rng.range(1, 255);
  // The runtime rebuilds `seed` and `phase` from these fragments, so the
  // fragments are derived from the real key instead of being independent.
  const seedA = rng.uint32();
  const seedB = rng.uint32();
  const partial = (mul32(seedA, 31) + mul32(seedB, 40503)) % 4294967296;
  const seedParts: [number, number, number] = [seedA, seedB, (seed - partial + 4294967296) % 4294967296];
  const phaseA = rng.range(1, 255);
  const phaseParts: [number, number] = [phaseA, (phase - phaseA + 256) % 256];

  return {
    opcodes,
    names,
    salt,
    seed,
    phase,
    seedParts,
    phaseParts,
    dispatchOrder,
    usesBitwise: input.usesBitwise,
    usesIdiv: input.usesIdiv,
    usesPresize: input.usesPresize === true,
    decoyCount: input.decoys ? rng.range(2, 5) : 0,
  };
}

/**
 * Every placeholder the runtime template can use. All of them get randomised
 * identifiers so the emitted runtime shares almost no tokens between builds.
 */
export const NAME_KEYS = [
  "ENV", "PACK", "UNPACK", "CONCAT", "BYTE", "CHAR", "SUB", "FIND", "FLOOR", "TYPE", "SELECT",
  "RUN", "MAKECL", "B64REV", "B64DEC", "LZW", "UNMASK", "PARSE", "CHECKSUM", "CANARY",
  "CHUNKS", "ORDER", "SEED", "PHASE", "SALT", "PROGRAM", "STRINGS", "ENTRY", "PROTOS",
  "BITS", "IDIV", "BAND", "BOR", "BXOR", "BNOT", "SHL", "SHR", "NUMBERS",
  "DECOY1", "DECOY2", "PARTS", "DATA", "PLAIN", "MAIN", "P", "ST", "TOP", "PC", "VA",
  "CODE", "PROTO", "UPS", "OP", "VAL", "KEY", "STATE", "LOOP", "BUF", "LEN", "RES",
  "CTRL", "LIMIT", "STEP", "INIT", "IDX", "TMP", "OBJ", "STR", "FN", "ACC", "BITS2",
  "SANITY", "G3", "G4", "G5", "G6",
] as const;
