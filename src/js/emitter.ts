import type { EngineOptions, ObfuscateStats } from "../core/types";

export function emitJavaScript(
  _source: string,
  _options: EngineOptions,
  stats: ObfuscateStats,
  _warnings: string[],
): { code: string; stats: ObfuscateStats; warnings: string[] } {
  throw new Error("JavaScript engine not wired yet");
}
