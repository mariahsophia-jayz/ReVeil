import type { EngineOptions, ObfuscateStats } from "../core/types";

export function emitPython(
  _source: string,
  _options: EngineOptions,
  stats: ObfuscateStats,
  _warnings: string[],
): { code: string; stats: ObfuscateStats; warnings: string[] } {
  throw new Error("Python engine not wired yet");
}
