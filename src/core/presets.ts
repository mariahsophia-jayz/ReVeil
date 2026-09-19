import { ReVeilError } from "./errors";
import type { EngineOptions, Language, LuaTarget, PresetName, TransformToggles } from "./types";

export const EMPTY_TOGGLES: TransformToggles = {
  renameIdentifiers: false,
  encryptStrings: false,
  encodeNumbers: false,
  injectDeadCode: false,
  opaquePredicates: false,
  flattenControlFlow: false,
  fractureExpressions: false,
  virtualize: false,
  decoys: false,
  integrityChecks: false,
  antiTamper: false,
  minify: false,
  banner: true,
};

/**
 * Preset table.
 *
 * `extreme` is the ReVeil default — the same configuration the Discord bot and
 * the CLI use when no preset is supplied. It virtualises everything, encrypts
 * the payload, hides constants and plants decoys + integrity checks.
 */
export const PRESETS: Record<PresetName, TransformToggles> = {
  light: {
    ...EMPTY_TOGGLES,
    renameIdentifiers: true,
    encryptStrings: true,
    minify: true,
  },
  medium: {
    ...EMPTY_TOGGLES,
    renameIdentifiers: true,
    encryptStrings: true,
    encodeNumbers: true,
    injectDeadCode: true,
    minify: true,
  },
  heavy: {
    ...EMPTY_TOGGLES,
    renameIdentifiers: true,
    encryptStrings: true,
    encodeNumbers: true,
    injectDeadCode: true,
    opaquePredicates: true,
    flattenControlFlow: true,
    fractureExpressions: true,
    virtualize: true,
    integrityChecks: true,
    minify: true,
  },
  extreme: {
    ...EMPTY_TOGGLES,
    renameIdentifiers: true,
    encryptStrings: true,
    encodeNumbers: true,
    injectDeadCode: true,
    opaquePredicates: true,
    flattenControlFlow: true,
    fractureExpressions: true,
    virtualize: true,
    decoys: true,
    integrityChecks: true,
    antiTamper: true,
    minify: true,
  },
};

export const PRESET_NAMES: PresetName[] = ["light", "medium", "heavy", "extreme"];

/** Alias resolution so `-p max`, `-p hardest`, ... all land on extreme. */
const PRESET_ALIASES: Record<string, PresetName> = {
  l: "light",
  light: "light",
  low: "light",
  m: "medium",
  medium: "medium",
  mid: "medium",
  h: "heavy",
  heavy: "heavy",
  high: "heavy",
  e: "extreme",
  x: "extreme",
  max: "extreme",
  extreme: "extreme",
  hardest: "extreme",
  strongest: "extreme",
  default: "extreme",
};

export function resolvePresetName(value: string | undefined, fallback: PresetName = "extreme"): PresetName {
  if (!value) {
    return fallback;
  }
  const resolved = PRESET_ALIASES[value.trim().toLowerCase()];
  if (!resolved) {
    throw new ReVeilError(`unknown preset "${value}" (expected one of: light, medium, heavy, extreme)`);
  }
  return resolved;
}

export interface NormalizedEngineOptions extends EngineOptions {}

export interface EngineOptionInput {
  preset?: string;
  language?: string;
  seed?: number | string;
  filename?: string;
  luaTarget?: string;
  watermark?: string;
  maxOutputBytes?: number;
  toggles?: Partial<TransformToggles>;
}

const LUA_TARGETS: Record<string, LuaTarget> = {
  "5.1": "5.1", lua51: "5.1", "lua5.1": "5.1",
  "5.2": "5.2", lua52: "5.2", "lua5.2": "5.2",
  "5.3": "5.3", lua53: "5.3", "lua5.3": "5.3",
  "5.4": "5.4", lua54: "5.4", "lua5.4": "5.4",
  luajit: "luajit", jit: "luajit",
  luau: "luau", roblox: "luau",
  universal: "universal", any: "universal", portable: "universal",
};

export function resolveLuaTarget(value: string | undefined): LuaTarget {
  if (!value) {
    return "universal";
  }
  const target = LUA_TARGETS[value.trim().toLowerCase()];
  if (!target) {
    throw new ReVeilError(`unsupported Lua target "${value}" (expected 5.1..5.4, luajit, luau or universal)`);
  }
  return target;
}

export function seedFrom(value: number | string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ReVeilError("seed must be a finite number");
    }
    return value >>> 0;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function normalizeLanguage(value: string | undefined, filename: string): Language {
  const explicit = (value ?? "").trim().toLowerCase();
  const table: Record<string, Language> = {
    lua: "lua",
    luau: "lua",
    roblox: "lua",
    js: "js",
    javascript: "js",
    node: "js",
    mjs: "js",
    cjs: "js",
    ts: "js",
    py: "python",
    python: "python",
    python3: "python",
  };
  if (explicit.length > 0) {
    const resolved = table[explicit];
    if (!resolved) {
      throw new ReVeilError(`unsupported language "${value}" (expected lua, js or python)`);
    }
    return resolved;
  }
  return detectLanguageFromFilename(filename);
}

export function detectLanguageFromFilename(filename: string): Language {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".lua") || lower.endsWith(".luau")) {
    return "lua";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".ts")) {
    return "js";
  }
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) {
    return "python";
  }
  return "lua";
}

export function buildEngineOptions(input: EngineOptionInput, language: Language, seed: number): NormalizedEngineOptions {
  const preset = resolvePresetName(input.preset);
  const toggles: TransformToggles = { ...PRESETS[preset], ...(input.toggles ?? {}) };
  return {
    preset,
    language,
    seed: seed >>> 0,
    filename: input.filename ?? `input.${language === "lua" ? "lua" : language === "js" ? "js" : "py"}`,
    luaTarget: resolveLuaTarget(input.luaTarget),
    toggles,
    watermark: input.watermark ?? "",
    maxOutputBytes: input.maxOutputBytes ?? 0,
  };
}

export const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  light: "Renamed identifiers, encrypted strings, minified. Fastest at runtime.",
  medium: "Light + encoded numbers, dead code injection. Balanced.",
  heavy: "Medium + control-flow flattening and full Lua/JS/Python virtualization.",
  extreme: "Everything ReVeil has: encrypted bytecode VM, decoys, integrity + anti-tamper. (default)",
};
