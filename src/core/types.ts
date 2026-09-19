import type { ReVeilRandom } from "./rng";

export type Language = "lua" | "js" | "python";

export type PresetName = "light" | "medium" | "heavy" | "extreme";

/** Lua dialects ReVeil can target. `universal` emits the most portable code. */
export type LuaTarget = "5.1" | "5.2" | "5.3" | "5.4" | "luajit" | "luau" | "universal";

export interface TransformToggles {
  /** Rebuild identifier names for locals / parameters / upvalues. */
  renameIdentifiers: boolean;
  /** Move every string literal into an encrypted runtime vault. */
  encryptStrings: boolean;
  /** Rewrite numeric literals into arithmetic expressions. */
  encodeNumbers: boolean;
  /** Inject unreachable branches guarded by opaque predicates. */
  injectDeadCode: boolean;
  /** Insert opaque predicates into live conditional branches. */
  opaquePredicates: boolean;
  /** Flatten eligible statement blocks into a dispatcher state machine. */
  flattenControlFlow: boolean;
  /** Split expressions through identity helpers to break pattern matching. */
  fractureExpressions: boolean;
  /** Compile the program into the ReVeil virtual machine. */
  virtualize: boolean;
  /** Add decoy prototypes / decoder routines to the payload. */
  decoys: boolean;
  /** Verify payload integrity and environment sanity at runtime. */
  integrityChecks: boolean;
  /** Refuse to run when instrumentation (hooks/tracers) is detected. */
  antiTamper: boolean;
  /** Strip comments and collapse whitespace. */
  minify: boolean;
  /** Wrap every emitted file in a `-- ReVeil` banner. */
  banner: boolean;
}

export interface EngineOptions {
  preset: PresetName;
  language: Language;
  seed: number;
  filename: string;
  /** Lua dialect used when compiling to the virtual machine. */
  luaTarget: LuaTarget;
  toggles: TransformToggles;
  /** Free-form text embedded in the debug/watermark banner. */
  watermark: string;
  /** Discord / CLI friendly cap on the emitted size in bytes (0 = unlimited). */
  maxOutputBytes: number;
}

export interface ObfuscateStats {
  inputBytes: number;
  outputBytes: number;
  inputLines: number;
  outputLines: number;
  ratio: number;
  durationMs: number;
  virtualizedFunctions: number;
  encryptedStrings: number;
  encodedNumbers: number;
  renamedIdentifiers: number;
  injectedBlocks: number;
  instructionCount: number;
  protos: number;
}

export interface ObfuscateResult {
  ok: boolean;
  code: string;
  language: Language;
  preset: PresetName;
  seed: number;
  stats: ObfuscateStats;
  warnings: string[];
  error?: string;
}

export interface EmitContext {
  rng: ReVeilRandom;
  options: EngineOptions;
  stats: ObfuscateStats;
  warnings: string[];
}
