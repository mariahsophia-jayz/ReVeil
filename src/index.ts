/**
 * ReVeil — Lua/Luau, JavaScript and Python obfuscation engine.
 *
 * Quick start:
 *
 *   import { obfuscate } from "reveil";
 *   const result = obfuscate(source, { filename: "bot.lua" });  // extreme preset
 *   if (result.ok) fs.writeFileSync("bot.obfuscated.lua", result.code);
 */

export { obfuscate, isSupportedFilename, randomSeed } from "./engine";
export type { ObfuscateInput, ObfuscateOptions } from "./engine";
export {
  PRESETS,
  PRESET_DESCRIPTIONS,
  PRESET_NAMES,
  detectLanguageFromFilename,
  resolvePresetName,
} from "./core/presets";
export { ReVeilError } from "./core/errors";
export type {
  Language,
  LuaTarget,
  ObfuscateResult,
  ObfuscateStats,
  PresetName,
  TransformToggles,
} from "./core/types";
export const REVEIL_VERSION = "2.0.0";
