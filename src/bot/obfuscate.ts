/**
 * The part of the bot that does actual work.
 *
 * `handleObfuscate()` takes plain strings and returns a plain result, with no
 * discord.js types in the signature, so it can be unit-tested and reused by the
 * CLI-style scripts without booting a gateway client. `index.ts` is a thin
 * adapter: it reads the interaction, fetches the attachment and renders the
 * result this function produces.
 *
 * The bot is Lua-only. Anything that is not `.lua` / `.luau` (or explicitly
 * `language: "lua"`) is rejected before the engine is invoked.
 */

import { ReVeilError } from "../core/errors";
import { PRESET_DESCRIPTIONS } from "../core/presets";
import type { ObfuscateStats, PresetName } from "../core/types";
import { humanBytes } from "../core/util";
import { obfuscate } from "../engine";
import { DEFAULT_BOT_PRESET, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from "./commands";

export interface BotObfuscateRequest {
  /** Raw Lua source. */
  source: string;
  /** Original file name; used for language detection, the banner and the reply. */
  filename?: string | null;
  /** Preset name or alias. Omitted means `extreme`. */
  preset?: string | null;
  /** Deterministic seed, as delivered by a slash-command string option. */
  seed?: string | null;
  /** Lua dialect to emit for. Omitted means `universal`. */
  target?: string | null;
  /** Extra banner text (the invoker's tag, for example). */
  watermark?: string | null;
  /** Override for the attachment-size ceiling. */
  maxOutputBytes?: number;
}

export interface BotField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface BotObfuscateResponse {
  ok: boolean;
  /** Name used for the returned attachment. */
  filename: string;
  code: string;
  preset: PresetName;
  seed: number;
  stats: ObfuscateStats;
  warnings: string[];
  error?: string;
  /** Ready-to-render embed fields. */
  fields: BotField[];
}

const LUA_EXTENSIONS = [".lua", ".luau"];

export function isLuaFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return LUA_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** `script.lua` -> `script.reveil.lua`, keeping directories out of the name. */
export function outputFilename(inputFilename: string | null | undefined): string {
  const base = (inputFilename ?? "input.lua").split(/[\\/]/).pop() || "input.lua";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.reveil.lua`;
}

/**
 * Slash-command options arrive as strings. Numeric seeds are handed to the engine
 * as numbers so that `/obfuscate seed: 4242` and `reveil --seed 4242` produce the
 * same payload; anything else is hashed by name.
 */
export function parseSeedOption(value: string | null | undefined): number | string | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) ? asNumber : trimmed;
}

function emptyResponse(filename: string, error: string): BotObfuscateResponse {
  return {
    ok: false,
    filename,
    code: "",
    preset: DEFAULT_BOT_PRESET,
    seed: 0,
    stats: {
      inputBytes: 0,
      outputBytes: 0,
      inputLines: 0,
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
    },
    warnings: [],
    error,
    fields: [{ name: "Error", value: error }],
  };
}

function buildFields(preset: PresetName, seed: number, stats: ObfuscateStats, warnings: string[]): BotField[] {
  const fields: BotField[] = [
    { name: "Preset", value: `${preset}\n${PRESET_DESCRIPTIONS[preset]}`.slice(0, 1024) },
    { name: "Seed", value: `\`${seed}\``, inline: true },
    { name: "Time", value: `${stats.durationMs} ms`, inline: true },
    {
      name: "Size",
      value: `${humanBytes(stats.inputBytes)} → ${humanBytes(stats.outputBytes)} (${stats.ratio.toFixed(1)}x)`,
      inline: true,
    },
  ];

  const counters: Array<[string, number]> = [
    ["Protos", stats.protos],
    ["Instructions", stats.instructionCount],
    ["Encrypted strings", stats.encryptedStrings],
    ["Encoded numbers", stats.encodedNumbers],
    ["Renamed identifiers", stats.renamedIdentifiers],
    ["Injected blocks", stats.injectedBlocks],
  ];
  for (const [name, value] of counters) {
    if (value > 0) {
      fields.push({ name, value: `\`${value}\``, inline: true });
    }
  }

  if (warnings.length > 0) {
    fields.push({ name: "Warnings", value: warnings.map((line) => `• ${line}`).join("\n").slice(0, 1024) });
  }
  return fields;
}

export function handleObfuscate(request: BotObfuscateRequest): BotObfuscateResponse {
  const source = request.source ?? "";
  const filename = request.filename ?? "input.lua";
  const outName = outputFilename(filename);

  if (source.trim().length === 0) {
    return emptyResponse(outName, "Attach a `.lua` / `.luau` file or paste source in `code`.");
  }
  if (!isLuaFilename(filename)) {
    return emptyResponse(outName, `The ReVeil bot is Lua-only — \`${filename}\` is not a .lua/.luau file.`);
  }
  const inputBytes = Buffer.byteLength(source, "utf8");
  if (inputBytes > MAX_INPUT_BYTES) {
    return emptyResponse(
      outName,
      `Input is ${humanBytes(inputBytes)}, the limit is ${humanBytes(MAX_INPUT_BYTES)}.`,
    );
  }

  const maxOutputBytes = request.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const result = obfuscate(source, {
    language: "lua",
    // Omitted preset -> DEFAULT_BOT_PRESET ("extreme"), the heaviest build.
    preset: request.preset ?? DEFAULT_BOT_PRESET,
    seed: parseSeedOption(request.seed),
    filename,
    luaTarget: request.target ?? undefined,
    watermark: request.watermark ?? undefined,
    maxOutputBytes,
  });

  if (!result.ok) {
    const response = emptyResponse(outName, result.error ?? "obfuscation failed");
    response.preset = result.preset;
    response.seed = result.seed >>> 0;
    response.stats = result.stats;
    response.warnings = result.warnings;
    return response;
  }

  return {
    ok: true,
    filename: outName,
    code: result.code,
    preset: result.preset,
    seed: result.seed >>> 0,
    stats: result.stats,
    warnings: result.warnings,
    fields: buildFields(result.preset, result.seed, result.stats, result.warnings),
  };
}

/** Re-exported so callers surface a stable error type. */
export { ReVeilError };
