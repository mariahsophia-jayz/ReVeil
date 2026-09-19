#!/usr/bin/env node
/**
 * ReVeil test suite entry point.
 *
 * Runs every check that does not need network access:
 *   1. payload round-trip  — serialiser/parser agree on the wire format
 *   2. Lua corpora         — reference Lua vs every preset and seed
 *   3. CLI                 — dist/cli.js end to end, payloads executed
 *   4. Discord bot         — /obfuscate payload + handler (extreme by default)
 *
 * Usage: node tests/run-all.js [preset,preset] [seed,seed]
 */

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const presets = process.argv[2] || process.env.REVEIL_TEST_PRESETS || "extreme,heavy,medium,light";
const seeds = process.argv[3] || process.env.REVEIL_TEST_SEEDS || "12345,777";

const steps = [
  { name: "payload round-trip", file: "tests/tools/payload-roundtrip.js", env: {} },
  { name: "lua corpus", file: "tests/lua/run-lua-tests.js", env: { REVEIL_TEST_PRESETS: presets, REVEIL_TEST_SEEDS: seeds } },
  { name: "cli", file: "tests/cli/run-cli-tests.js", env: {} },
  { name: "discord bot", file: "tests/bot/run-bot-tests.js", env: {} },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n== ${step.name} ==\n`);
  const result = spawnSync(process.execPath, [path.join(ROOT, step.file)], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...step.env },
  });
  if (result.status !== 0) {
    failed += 1;
    console.log(`✗ ${step.name} failed`);
  }
}

console.log(failed === 0 ? "\nReVeil: all suites passed" : `\nReVeil: ${failed} suite(s) failed`);
process.exit(failed === 0 ? 0 : 1);
