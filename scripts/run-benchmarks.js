#!/usr/bin/env node
/**
 * ReVeil benchmark runner.
 *
 * Every file in `benchmarks/` is obfuscated with the requested preset and, when a
 * `lua` interpreter is available, both the original and the obfuscated chunk are
 * executed so their stdout/stderr must match byte for byte. Without `lua` the
 * runner still reports obfuscation cost and output size.
 *
 *   npm run bench
 *   REVEIL_BENCH_PRESET=medium npm run bench
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { obfuscate, PRESET_NAMES } = require("../dist");

const root = path.resolve(__dirname, "..");
const benchmarkDir = path.join(root, "benchmarks");
const outputDir = path.join(root, ".bench-out");
const luaExe = process.env.REVEIL_BENCH_LUA || "lua";
const preset = process.env.REVEIL_BENCH_PRESET || "extreme";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hasLua() {
  const probe = spawnSync(luaExe, ["-v"], { encoding: "utf8" });
  return probe.status === 0;
}

function runLua(file) {
  const started = Date.now();
  const result = spawnSync(luaExe, [file], { cwd: root, encoding: "utf8" });
  if (result.error) {
    return { ok: false, status: null, stdout: "", stderr: String(result.error.message), ms: Date.now() - started };
  }
  return {
    ok: true,
    status: result.status,
    stdout: (result.stdout ?? "").replace(/\r\n/g, "\n"),
    stderr: (result.stderr ?? "").replace(/\r\n/g, "\n"),
    ms: Date.now() - started,
  };
}

function listBenchmarks() {
  return fs
    .readdirSync(benchmarkDir)
    .filter((file) => file.endsWith(".lua"))
    .sort()
    .map((file) => path.join(benchmarkDir, file));
}

function obfuscateFile(inputFile, seed) {
  const source = fs.readFileSync(inputFile, "utf8");
  const result = obfuscate(source, { filename: path.basename(inputFile), preset, seed });
  if (!result.ok) {
    throw new Error(result.error);
  }
  const outputFile = path.join(outputDir, `${path.basename(inputFile, ".lua")}.obf.lua`);
  fs.writeFileSync(outputFile, result.code, "utf8");
  return { outputFile, stats: result.stats };
}

function formatResult(label, result) {
  return `${label} status=${result.status} time=${result.ms}ms stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
}

function main() {
  if (!PRESET_NAMES.includes(preset)) {
    console.error(`REVEIL_BENCH_PRESET must be one of: ${PRESET_NAMES.join(", ")}`);
    process.exit(1);
  }

  ensureDir(outputDir);
  const verify = hasLua();
  const files = listBenchmarks();
  let failures = 0;

  console.log(`ReVeil benchmarks — preset ${preset}, ${verify ? `verifying with ${luaExe}` : "no lua interpreter found (timing only)"}`);

  for (let index = 0; index < files.length; index += 1) {
    const inputFile = files[index];
    let obfuscated;
    try {
      obfuscated = obfuscateFile(inputFile, 0x13572468 + index);
    } catch (error) {
      failures += 1;
      console.log(`\n[${path.basename(inputFile)}]`);
      console.log(`obfuscation failed: ${error.message}`);
      continue;
    }

    console.log(`\n[${path.basename(inputFile)}]`);
    console.log(
      `obfuscated ${obfuscated.stats.inputBytes} B -> ${obfuscated.stats.outputBytes} B ` +
        `in ${obfuscated.stats.durationMs} ms (${obfuscated.stats.protos} protos, ${obfuscated.stats.instructionCount} instructions)`,
    );

    if (!verify) {
      continue;
    }

    const original = runLua(inputFile);
    const obfuscatedRun = runLua(obfuscated.outputFile);
    console.log(formatResult("original", original));
    console.log(formatResult("obfuscated", obfuscatedRun));

    const same =
      original.status === obfuscatedRun.status &&
      original.stdout === obfuscatedRun.stdout &&
      original.stderr === obfuscatedRun.stderr;
    if (!same) {
      failures += 1;
      console.log("mismatch detected");
    }
  }

  if (failures > 0) {
    console.error(`\nbenchmark failures: ${failures}`);
    process.exit(1);
  }

  console.log(`\nall benchmarks passed: ${files.length} (${preset})`);
}

main();
