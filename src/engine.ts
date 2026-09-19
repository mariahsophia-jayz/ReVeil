/**
 * ReVeil — unified obfuscation engine entry point.
 *
 * `obfuscate()` runs the whole pipeline for one source file: language
 * detection, preset resolution, transforms and emission. It never throws for
 * recoverable problems: the result carries `ok: false` plus a message so the
 * Discord bot and the CLI can report failures without crashing.
 */

import { ReVeilError } from "./core/errors";
import { PRESETS, buildEngineOptions, detectLanguageFromFilename, normalizeLanguage, resolvePresetName } from "./core/presets";
import { ReVeilRandom, seedFromString } from "./core/rng";
import type { Language, ObfuscateResult, ObfuscateStats, PresetName, TransformToggles } from "./core/types";
import { countLines, humanBytes } from "./core/util";
import { emitLua } from "./lua/emitter";
import { emitJavaScript } from "./js/emitter";
import { emitPython } from "./py/emitter";

export interface ObfuscateInput {
  /** Force a language instead of detecting it from the filename. */
  language?: Language | string;
  /** Preset name or alias. Defaults to `extreme` (the heaviest build). */
  preset?: PresetName | string;
  /** Deterministic seed; strings are hashed. */
  seed?: number | string;
  /** Used for language detection and the banner. */
  filename?: string;
  /** Lua dialect to emit for. */
  luaTarget?: string;
  /** Extra text for the banner. */
  watermark?: string;
  /** Hard cap for the produced file (Discord attachment limits). */
  maxOutputBytes?: number;
  /** Individual toggle overrides applied on top of the preset. */
  toggles?: Partial<TransformToggles>;
}

export interface ObfuscateOptions extends ObfuscateInput {
  /** Return the produced code even when it exceeds `maxOutputBytes`. */
  ignoreBudget?: boolean;
}

export { PRESETS, PRESET_DESCRIPTIONS, PRESET_NAMES, detectLanguageFromFilename } from "./core/presets";

export function obfuscate(source: string, input: ObfuscateOptions = {}): ObfuscateResult {
  const started = Date.now();
  const stats: ObfuscateStats = {
    inputBytes: Buffer.byteLength(source, "utf8"),
    outputBytes: 0,
    inputLines: countLines(source),
    outputLines: 0,
    ratio: 0,
    durationMs: 0,
    virtualizedFunctions: 0,
    encryptedStrings: 0,
    encodedNumbers: 0,
    renamedIdentifiers: 0,
    injectedBlocks: 0,
    instructionCount: 0,
    protos: 0,
  };
  const warnings: string[] = [];

  let language: Language = "lua";
  let preset: PresetName = "extreme";
  let seed = 0;

  try {
    if (typeof source !== "string" || source.length === 0) {
      throw new ReVeilError("input is empty", "EMPTY_INPUT");
    }
    language = normalizeLanguage(typeof input.language === "string" ? input.language : undefined, input.filename ?? "");
    preset = resolvePresetName(typeof input.preset === "string" ? input.preset : undefined);
    seed =
      input.seed === undefined || input.seed === null
        ? seedFromString(`${input.filename ?? "input"}:${source.length}:${input.preset ?? "extreme"}`) ^ 0x5bf03635
        : typeof input.seed === "number"
          ? input.seed >>> 0
          : seedFromString(String(input.seed));

    const options = buildEngineOptions(
      {
        preset,
        language,
        seed,
        filename: input.filename,
        luaTarget: input.luaTarget,
        watermark: input.watermark,
        maxOutputBytes: input.maxOutputBytes,
        toggles: input.toggles,
      },
      language,
      seed,
    );

    let code = "";
    let outputStats = stats;
    if (language === "lua") {
      const result = emitLua(source, options, stats, warnings);
      code = result.code;
      outputStats = result.stats;
    } else if (language === "js") {
      const result = emitJavaScript(source, options, stats, warnings);
      code = result.code;
      outputStats = result.stats;
    } else {
      const result = emitPython(source, options, stats, warnings);
      code = result.code;
      outputStats = result.stats;
    }

    outputStats.outputBytes = Buffer.byteLength(code, "utf8");
    outputStats.outputLines = countLines(code);
    outputStats.ratio = outputStats.inputBytes === 0 ? 0 : outputStats.outputBytes / outputStats.inputBytes;
    outputStats.durationMs = Date.now() - started;

    if (
      input.maxOutputBytes &&
      input.maxOutputBytes > 0 &&
      outputStats.outputBytes > input.maxOutputBytes &&
      !input.ignoreBudget
    ) {
      return {
        ok: false,
        code: "",
        language,
        preset,
        seed,
        stats: outputStats,
        warnings,
        error: `obfuscated output is ${humanBytes(outputStats.outputBytes)} which exceeds the ${humanBytes(
          input.maxOutputBytes,
        )} limit`,
      };
    }

    return { ok: true, code, language, preset, seed, stats: outputStats, warnings };
  } catch (error) {
    stats.durationMs = Date.now() - started;
    const message = error instanceof ReVeilError ? error.message : (error as Error)?.message ?? String(error);
    warnings.push(`seed ${seed}`);
    return {
      ok: false,
      code: "",
      language,
      preset,
      seed,
      stats,
      warnings,
      error: message,
    };
  }
}

/** Convenience helper used by the bot / CLI for a quick "is this supported?" check. */
export function isSupportedFilename(filename: string): boolean {
  try {
    detectLanguageFromFilename(filename);
    return true;
  } catch {
    return false;
  }
}

/** Random-but-stable seed generator. */
export function randomSeed(): number {
  return new ReVeilRandom(Date.now() >>> 0, "lua", 0x7f4a).uint32();
}

export type { Language, ObfuscateResult, ObfuscateStats, PresetName, TransformToggles };
