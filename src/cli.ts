#!/usr/bin/env node
/**
 * ReVeil command line interface.
 *
 *   reveil script.lua                          # -> script.reveil.lua  (extreme)
 *   reveil -p medium -o out.lua script.lua
 *   reveil --stdout -s reproducible script.lua > out.lua
 *   reveil --set virtualize=off --set decoys=off game.lua
 *   cat game.lua | reveil --stdin --stdout > game.reveil.lua
 *
 * The CLI and the Discord bot share the exact same `obfuscate()` entry point and
 * the exact same preset table, so `--preset extreme` here and `/obfuscate` with
 * no preset there produce equivalent output for the same seed.
 *
 * Exit codes: 0 = every input obfuscated, 1 = at least one input failed,
 * 2 = bad usage.
 */

import * as fs from "fs";
import * as path from "path";

import { ReVeilError } from "./core/errors";
import { EMPTY_TOGGLES, PRESET_DESCRIPTIONS, PRESET_NAMES } from "./core/presets";
import type { Language, ObfuscateStats, PresetName, TransformToggles } from "./core/types";
import { humanBytes } from "./core/util";
import { obfuscate } from "./engine";
import { REVEIL_VERSION } from "./index";

/** Preset used when `--preset` is omitted — identical to the Discord bot default. */
export const DEFAULT_CLI_PRESET: PresetName = "extreme";

const TOGGLE_NAMES = Object.keys(EMPTY_TOGGLES) as Array<keyof TransformToggles>;

const HELP = `ReVeil ${REVEIL_VERSION} — Lua/Luau obfuscation engine

Usage
  reveil [options] <input.lua|input.luau> [more inputs...]
  reveil [options] --stdin
  cat game.lua | reveil --stdin --stdout > game.reveil.lua

Options
  -o, --output <file>       write to <file> (only valid with a single input)
      --stdout              write the result to stdout instead of a file
      --stdin               read the source from stdin (input name "stdin.lua")
  -p, --preset <name>       ${PRESET_NAMES.join(" | ")}  (default: ${DEFAULT_CLI_PRESET})
  -s, --seed <value>        number or string; the same seed reproduces the output
  -t, --target <dialect>    5.1 | 5.2 | 5.3 | 5.4 | luajit | luau | universal
  -l, --language <name>     lua | js | python (default: from the file extension)
  -w, --watermark <text>    extra text for the banner comment
      --set <toggle>=<on|off>
                            override a single transform on top of the preset
      --max-bytes <n>       fail instead of writing files larger than n bytes
      --stats               print the transform statistics for each input
  -q, --quiet               only print errors
      --presets             list the presets and exit
  -h, --help                show this help
  -v, --version             print the version

Toggles: ${TOGGLE_NAMES.join(", ")}

Presets
${PRESET_NAMES.map((name) => `  ${name.padEnd(8)} ${PRESET_DESCRIPTIONS[name]}`).join("\n")}

Without --output the result is written next to the input as <name>.reveil.lua.
`;

export interface CliOptions {
  inputs: string[];
  output?: string;
  stdout: boolean;
  stdin: boolean;
  preset?: string;
  seed?: string;
  target?: string;
  language?: string;
  watermark?: string;
  maxBytes: number;
  toggles: Partial<TransformToggles>;
  stats: boolean;
  quiet: boolean;
  listPresets: boolean;
  help: boolean;
  version: boolean;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} expects a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputs: [],
    stdout: false,
    stdin: false,
    maxBytes: 0,
    toggles: {},
    stats: false,
    quiet: false,
    listPresets: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case "-o":
      case "--output":
        options.output = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--stdout":
        options.stdout = true;
        break;
      case "--stdin":
        options.stdin = true;
        break;
      case "-p":
      case "--preset":
        options.preset = takeValue(argv, index, arg);
        index += 1;
        break;
      case "-s":
      case "--seed":
        options.seed = takeValue(argv, index, arg);
        index += 1;
        break;
      case "-t":
      case "--target":
        options.target = takeValue(argv, index, arg);
        index += 1;
        break;
      case "-l":
      case "--language":
        options.language = takeValue(argv, index, arg);
        index += 1;
        break;
      case "-w":
      case "--watermark":
        options.watermark = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--max-bytes": {
        const raw = takeValue(argv, index, arg);
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`--max-bytes expects a non-negative number, got "${raw}"`);
        }
        options.maxBytes = Math.floor(parsed);
        index += 1;
        break;
      }
      case "--set": {
        const raw = takeValue(argv, index, arg);
        const separator = raw.indexOf("=");
        const name = (separator === -1 ? raw : raw.slice(0, separator)).trim();
        const value = separator === -1 ? "on" : raw.slice(separator + 1).trim().toLowerCase();
        if (!TOGGLE_NAMES.includes(name as keyof TransformToggles)) {
          throw new Error(`unknown toggle "${name}" (expected one of: ${TOGGLE_NAMES.join(", ")})`);
        }
        if (!["on", "off", "true", "false", "1", "0"].includes(value)) {
          throw new Error(`--set ${name} expects on or off, got "${value}"`);
        }
        options.toggles[name as keyof TransformToggles] = value === "on" || value === "true" || value === "1";
        index += 1;
        break;
      }
      case "--stats":
        options.stats = true;
        break;
      case "-q":
      case "--quiet":
        options.quiet = true;
        break;
      case "--presets":
        options.listPresets = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") {
          throw new Error(`unknown option "${arg}" (see --help)`);
        }
        options.inputs.push(arg);
        break;
    }
  }

  return options;
}

function extensionFor(language: Language): string {
  if (language === "js") {
    return ".js";
  }
  if (language === "python") {
    return ".py";
  }
  return ".lua";
}

/** `game.lua` -> `game.reveil.lua`; matches the *.reveil.* entries in .gitignore. */
export function defaultOutputPath(inputFile: string, language: Language): string {
  const extension = path.extname(inputFile);
  const base = extension.length > 0 ? inputFile.slice(0, -extension.length) : inputFile;
  return `${base}.reveil${extensionFor(language)}`;
}

function parseSeed(value: string | undefined): number | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === "") {
    return undefined;
  }
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : value;
}

function formatStats(label: string, stats: ObfuscateStats): string {
  const rows: Array<[string, string]> = [
    ["input", `${humanBytes(stats.inputBytes)} / ${stats.inputLines} lines`],
    ["output", humanBytes(stats.outputBytes)],
    ["ratio", `${stats.ratio.toFixed(2)}x`],
    ["time", `${stats.durationMs} ms`],
  ];
  if (stats.protos > 0) {
    rows.push(["protos", String(stats.protos)]);
  }
  if (stats.instructionCount > 0) {
    rows.push(["instructions", String(stats.instructionCount)]);
  }
  if (stats.encryptedStrings > 0) {
    rows.push(["encrypted strings", String(stats.encryptedStrings)]);
  }
  if (stats.encodedNumbers > 0) {
    rows.push(["encoded numbers", String(stats.encodedNumbers)]);
  }
  if (stats.renamedIdentifiers > 0) {
    rows.push(["renamed identifiers", String(stats.renamedIdentifiers)]);
  }
  if (stats.injectedBlocks > 0) {
    rows.push(["injected blocks", String(stats.injectedBlocks)]);
  }
  const width = Math.max(...rows.map((row) => row[0].length));
  return [`  ${label}:`, ...rows.map((row) => `    ${row[0].padEnd(width)}  ${row[1]}`)].join("\n");
}

function listPresets(): string {
  return [
    `ReVeil presets (default: ${DEFAULT_CLI_PRESET})`,
    "",
    ...PRESET_NAMES.map((name) => `  ${name.padEnd(8)} ${PRESET_DESCRIPTIONS[name]}`),
    "",
    `Toggles: ${TOGGLE_NAMES.join(", ")}`,
  ].join("\n");
}

/**
 * Informational output. With `--stdout` the result travels on stdout, so every
 * status line moves to stderr and `reveil --stdout a.lua > a.reveil.lua` stays a
 * clean, runnable file.
 */
function log(options: CliOptions, line: string): void {
  if (options.stdout) {
    process.stderr.write(`${line}\n`);
    return;
  }
  console.log(line);
}

function warn(options: CliOptions, line: string): void {
  if (options.stdout) {
    process.stderr.write(`${line}\n`);
    return;
  }
  console.warn(line);
}

function writeOutput(code: string, options: CliOptions, inputFile: string, language: Language): void {
  if (options.stdout) {
    process.stdout.write(code.endsWith("\n") ? code : `${code}\n`);
    return;
  }
  const target = options.output ?? defaultOutputPath(inputFile, language);
  const directory = path.dirname(path.resolve(target));
  if (directory) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(target, code, "utf8");
  if (options.stats) {
    log(options, `  wrote         ${target}`);
  } else if (!options.quiet) {
    log(options, `ReVeil: wrote ${target}`);
  }
}

function processOne(inputFile: string, source: string, options: CliOptions): void {
  const result = obfuscate(source, {
    preset: options.preset ?? DEFAULT_CLI_PRESET,
    seed: parseSeed(options.seed),
    filename: inputFile,
    language: options.language,
    luaTarget: options.target,
    watermark: options.watermark,
    maxOutputBytes: options.maxBytes,
    toggles: options.toggles,
  });

  if (!result.ok) {
    throw new ReVeilError(result.error ?? "obfuscation failed", "CLI_OBFUSCATE_FAILED");
  }
  for (const warning of result.warnings) {
    warn(options, `ReVeil warning (${inputFile}): ${warning}`);
  }
  if (options.stats) {
    log(options, formatStats(`${inputFile} [${result.preset}] seed ${result.seed >>> 0}`, result.stats));
  } else if (!options.quiet) {
    log(options,
      `ReVeil: ${inputFile} [${result.preset}] -> ${humanBytes(result.stats.outputBytes)} ` +
        `in ${result.stats.durationMs} ms (seed ${result.seed >>> 0})`,
    );
  }
  writeOutput(result.code, options, inputFile, result.language);
}

export function runCli(argv: string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`ReVeil: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (options.version) {
    console.log(`ReVeil ${REVEIL_VERSION}`);
    return 0;
  }
  if (options.listPresets) {
    console.log(listPresets());
    return 0;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.inputs.length === 0 && !options.stdin) {
    console.error("ReVeil: no input file (see --help)");
    return 2;
  }
  if (options.inputs.length > 1 && options.output) {
    console.error("ReVeil: --output can only be used with a single input (try --stdout)");
    return 2;
  }
  if (options.inputs.length > 0 && options.stdin) {
    console.error("ReVeil: --stdin cannot be combined with input files");
    return 2;
  }

  let failures = 0;
  if (options.stdin) {
    let source = "";
    try {
      source = fs.readFileSync(0, "utf8");
    } catch (error) {
      console.error(`ReVeil: cannot read stdin: ${(error as Error).message}`);
      return 1;
    }
    try {
      processOne("stdin.lua", source, options);
    } catch (error) {
      console.error(`ReVeil: stdin: ${describe(error)}`);
      return 1;
    }
    return 0;
  }

  for (const inputFile of options.inputs) {
    let source = "";
    try {
      source = fs.readFileSync(inputFile, "utf8");
    } catch (error) {
      console.error(`ReVeil: cannot read ${inputFile}: ${(error as Error).message}`);
      failures += 1;
      continue;
    }
    try {
      processOne(inputFile, source, options);
    } catch (error) {
      console.error(`ReVeil: ${inputFile}: ${describe(error)}`);
      failures += 1;
    }
  }

  return failures === 0 ? 0 : 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}
