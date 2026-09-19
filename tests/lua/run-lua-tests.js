#!/usr/bin/env node
/**
 * ReVeil Lua test runner.
 *
 * Every case in `tests/lua/cases` is executed twice:
 *   1. as plain Lua (reference output, Lua 5.4 through wasmoon)
 *   2. through the ReVeil virtual machine, for several seeds and presets
 * The outputs must match exactly.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..", "..");
const CASES = path.join(__dirname, "cases");
const { runLua } = require("./harness.js");
const { obfuscate } = require(path.join(ROOT, "dist", "engine.js"));

const PRESETS = (process.env.REVEIL_TEST_PRESETS || "extreme,heavy,medium,light").split(",");
const SEEDS = (process.env.REVEIL_TEST_SEEDS || "12345,987654321").split(",").map(Number);

async function main() {
  const files = fs.readdirSync(CASES).filter((file) => file.endsWith(".lua")).sort();
  const only = process.argv.slice(2);
  const selected = only.length > 0 ? files.filter((file) => only.some((name) => file.includes(name))) : files;
  let failures = 0;
  let checks = 0;
  const started = Date.now();

  for (const file of selected) {
    const source = fs.readFileSync(path.join(CASES, file), "utf8");
    const reference = await runLua(source);
    if (!reference.ok) {
      console.log(`✗ ${file}: reference run failed: ${reference.err}`);
      failures += 1;
      continue;
    }

    for (const preset of PRESETS) {
      for (const seed of SEEDS) {
        checks += 1;
        const result = obfuscate(source, { filename: file, preset, seed, language: "lua" });
        if (!result.ok) {
          console.log(`✗ ${file} [${preset}/${seed}]: obfuscation failed: ${result.error}`);
          failures += 1;
          continue;
        }
        const run = await runLua(result.code);
        if (!run.ok) {
          console.log(`✗ ${file} [${preset}/${seed}]: runtime error: ${run.err}`);
          failures += 1;
          writeFailure(file, preset, seed, result.code);
          continue;
        }
        if (run.out !== reference.out) {
          console.log(`✗ ${file} [${preset}/${seed}]: output mismatch`);
          console.log(`   expected: ${JSON.stringify(reference.out.slice(0, 200))}`);
          console.log(`   actual  : ${JSON.stringify(run.out.slice(0, 200))}`);
          failures += 1;
          writeFailure(file, preset, seed, result.code);
          continue;
        }
      }
    }
    if (failures === 0) {
      console.log(`✓ ${file}`);
    } else {
      console.log(`  ${file}: ${failures} failure(s) so far`);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${checks - failures}/${checks} checks passed in ${seconds}s`);
  if (failures > 0) {
    console.log("failed outputs written to tests/lua/__failures__/");
    process.exit(1);
  }
}

function writeFailure(file, preset, seed, code) {
  const dir = path.join(__dirname, "__failures__");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${file}.${preset}.${seed}.lua`), code, "utf8");
  void os;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
