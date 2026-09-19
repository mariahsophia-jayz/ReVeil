/**
 * ReVeil Lua emitter.
 *
 * Two output modes:
 *  - `virtualize`  → the AST is lowered to ReVeil bytecode and shipped with the
 *                    self-decoding VM (presets heavy / extreme).
 *  - source mode   → the AST is rewritten in place (renamed locals, encrypted
 *                    string vault, encoded numbers, dead code) and printed back
 *                    (presets light / medium).
 */

import { ReVeilError } from "../core/errors";
import { ReVeilRandom } from "../core/rng";
import { checksumOf, packPayload, type CipherParams } from "../core/cipher";
import type { EngineOptions } from "../core/types";
import { OP_ARITY, serializeProgram, type Program, type Proto } from "./bytecode";
import { compileChunk } from "./compiler";
import { parseLua } from "./parser";
import { createLuaProfile } from "./profile";
import { resolveChunk } from "./resolve";
import { renderLuaModule } from "./runtime";
import type { ObfuscateStats } from "../core/types";

export interface LuaEmitResult {
  code: string;
  stats: ObfuscateStats;
  warnings: string[];
}

export function emitLua(source: string, options: EngineOptions, baseStats: ObfuscateStats, warnings: string[]): LuaEmitResult {
  const rng = new ReVeilRandom(options.seed, "lua", 0x1111);
  const chunk = parseLua(source, { allowLuau: true });
  if (chunk.luau && options.luaTarget !== "luau" && options.luaTarget !== "universal") {
    warnings.push(
      `input uses Luau syntax but the target is Lua ${options.luaTarget}; the emitted chunk will not run on that interpreter`,
    );
  }

  const resolve = resolveChunk(chunk, rng);
  baseStats.renamedIdentifiers = resolve.renamed;

  if (options.toggles.virtualize) {
    return emitVirtualized(chunk, resolve, rng, options, baseStats, warnings);
  }
  return emitSourceMode(chunk, resolve, rng, options, baseStats, warnings);
}

function emitVirtualized(
  chunk: ReturnType<typeof parseLua>,
  resolve: ReturnType<typeof resolveChunk>,
  rng: ReVeilRandom,
  options: EngineOptions,
  baseStats: ObfuscateStats,
  warnings: string[],
): LuaEmitResult {
  const { program, stats } = compileChunk(chunk, resolve, rng, { allowGoto: true });
  baseStats.protos = stats.protos;
  baseStats.instructionCount = stats.instructions;

  let entryProgram: Program = program;
  if (options.toggles.decoys) {
    entryProgram = appendDecoys(program, rng, rng.range(2, 5));
    baseStats.injectedBlocks += entryProgram.protos.length - program.protos.length;
  }

  const usesBitwise = entryProgram.protos.some((proto) =>
    proto.code.some((instruction) =>
      ["BAND", "BOR", "BXOR", "SHL", "SHR", "BNOT"].includes(instruction[0] as string),
    ),
  );
  const usesIdiv = entryProgram.protos.some((proto) =>
    proto.code.some((instruction) => instruction[0] === "IDIV"),
  );

  const profile = createLuaProfile({
    rng,
    seed: options.seed,
    usesBitwise,
    usesIdiv,
    usesPresize: stats.presize,
    decoys: options.toggles.decoys,
  });

  if (process.env.REVEIL_TRACE) {
    const opcodes = profile.opcodes as Record<string, number>;
    (baseStats as ObfuscateStats & Record<string, unknown>).opcodes = opcodes;
    const wordOf = (proto: Proto, index: number): number => {
      let word = 1;
      for (let cursor = 0; cursor < index; cursor += 1) {
        word += 1 + OP_ARITY[proto.code[cursor][0] as keyof typeof OP_ARITY];
      }
      return word;
    };
    const dump: string[] = [];
    entryProgram.protos.forEach((proto, protoIndex) => {
      dump.push(` proto #${protoIndex + 1} params=${proto.params} vararg=${proto.vararg} updesc=[${proto.updesc}] maxSlots=${proto.maxSlots}`);
      proto.code.forEach((instruction, index) => {
        const operands = instruction.slice(1).join(" ");
        dump.push(
          `   w${String(wordOf(proto, index)).padStart(3, " ")} ${String(opcodes[instruction[0] as string]).padStart(3, " ")} ${instruction[0]} ${operands}`,
        );
      });
    });
    (baseStats as ObfuscateStats & Record<string, unknown>).disassembly = dump.join("\n");
  }

  const plain = serializeProgram(entryProgram, (name) => profile.opcodes[name]);
  const params: CipherParams = {
    seed: options.seed,
    salt: profile.salt,
    phase: profile.phase,
  };
  const payload = packPayload(plain, params, rng);
  void checksumOf;

  const code = renderLuaModule({
    profile,
    payload,
    options,
    program: entryProgram,
  });

  baseStats.outputBytes = Buffer.byteLength(code, "utf8");
  if (options.maxOutputBytes > 0 && baseStats.outputBytes > options.maxOutputBytes) {
    warnings.push(
      `output is ${baseStats.outputBytes} bytes which exceeds the ${options.maxOutputBytes} byte budget`,
    );
  }
  return { code, stats: baseStats, warnings };
}

function emitSourceMode(
  chunk: ReturnType<typeof parseLua>,
  _resolve: ReturnType<typeof resolveChunk>,
  rng: ReVeilRandom,
  options: EngineOptions,
  baseStats: ObfuscateStats,
  warnings: string[],
): LuaEmitResult {
  const { printChunk } = require("./printer") as typeof import("./printer");
  const { applySourceTransforms } = require("./transforms") as typeof import("./transforms");
  const transformed = applySourceTransforms(chunk, rng, options, baseStats);
  const code = printChunk(transformed, {
    luau: options.luaTarget === "luau",
    minify: options.toggles.minify,
    banner: options.toggles.banner,
    watermark: options.watermark,
    preset: options.preset,
  });
  baseStats.outputBytes = Buffer.byteLength(code, "utf8");
  if (options.maxOutputBytes > 0 && baseStats.outputBytes > options.maxOutputBytes) {
    warnings.push(
      `output is ${baseStats.outputBytes} bytes which exceeds the ${options.maxOutputBytes} byte budget`,
    );
  }
  return { code, stats: baseStats, warnings };
}

/**
 * Appends unreachable "decoy" prototypes so that the payload size, prototype
 * count and instruction histogram say nothing about the original program.
 */
export function appendDecoys(program: Program, rng: ReVeilRandom, count: number): Program {
  const protos: Proto[] = program.protos.slice();
  const opcodePool = ["LOADK", "LOADSTR", "LOADL", "STOREL", "ADD", "SUB", "MUL", "CALL", "RET", "NEWT", "GETS", "SETS", "EQ", "LT", "JMP"] as const;
  for (let index = 0; index < count; index += 1) {
    const body: Proto = {
      params: rng.range(1, 3),
      vararg: rng.bool(0.3),
      updesc: [],
      code: [],
      maxSlots: rng.range(6, 18),
      name: `decoy${index}`,
    };
    const steps = rng.range(6, 24);
    for (let step = 0; step < steps; step += 1) {
      const opcode = rng.pick(opcodePool);
      switch (opcode) {
        case "LOADK":
          body.code.push(["LOADK", rng.range(1, 9999)]);
          break;
        case "LOADSTR":
          body.code.push(["LOADSTR", rng.range(1, Math.max(1, program.strings.length))]);
          break;
        case "LOADL":
        case "STOREL":
          body.code.push([opcode, rng.range(1, body.maxSlots)]);
          break;
        case "ADD":
        case "SUB":
        case "MUL":
        case "EQ":
        case "LT":
          body.code.push([opcode]);
          break;
        case "NEWT":
          body.code.push(["NEWT"]);
          break;
        case "GETS":
        case "SETS":
          body.code.push([opcode, rng.range(1, Math.max(1, program.strings.length))]);
          break;
        case "CALL":
          body.code.push(["CALL", rng.range(1, 3), rng.range(0, 2)]);
          break;
        case "JMP":
          body.code.push(["JMP", rng.range(0, 2)]);
          break;
        default:
          body.code.push(["LOADNIL"]);
          break;
      }
    }
    body.code.push(["RET", 0, 0]);
    protos.push(body);
  }
  return { ...program, protos };
}

export function requireVirtualizable(chunk: { luau: boolean }, options: EngineOptions): void {
  if (options.toggles.virtualize && chunk.luau && options.luaTarget === "5.1") {
    throw new ReVeilError("Luau sources cannot be lowered to a Lua 5.1 target", "LUA_TARGET");
  }
}
