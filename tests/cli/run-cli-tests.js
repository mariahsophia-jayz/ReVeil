#!/usr/bin/env node
/**
 * ReVeil CLI test suite.
 *
 * Drives the real `dist/cli.js` as a subprocess and executes what it writes with
 * the sandboxed Lua interpreter, so this covers argument parsing, exit codes,
 * output naming, `--stdout` purity and the obfuscated payload in one pass.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const CASES = path.join(ROOT, "tests", "lua", "cases");
const { runLua } = require("../lua/harness.js");

let checks = 0;
let failures = 0;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "reveil-cli-"));

function cli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    input: options.input,
    timeout: 120000,
  });
}

function check(name, body) {
  checks += 1;
  try {
    body();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${name}`);
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkAsync(name, body) {
  checks += 1;
  try {
    await body();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${name}`);
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fixture(name) {
  const target = path.join(workspace, name);
  fs.copyFileSync(path.join(CASES, name), target);
  return target;
}

async function main() {
  console.log("surface");

  check("--version prints the version", () => {
    const result = cli(["--version"]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ReVeil \d+\.\d+\.\d+/);
  });

  check("--presets lists every preset and the default", () => {
    const result = cli(["--presets"]);
    assert.strictEqual(result.status, 0, result.stderr);
    for (const preset of ["light", "medium", "heavy", "extreme"]) {
      assert.ok(result.stdout.includes(preset), `missing ${preset}`);
    }
    assert.match(result.stdout, /default: extreme/);
  });

  check("--help documents the flags", () => {
    const result = cli(["--help"]);
    assert.strictEqual(result.status, 0, result.stderr);
    for (const flag of ["--output", "--stdout", "--stdin", "--preset", "--seed", "--target", "--set", "--max-bytes"]) {
      assert.ok(result.stdout.includes(flag), `help is missing ${flag}`);
    }
    assert.match(result.stdout, /default: extreme/);
  });

  console.log("\nusage errors");

  check("no input exits 2", () => {
    const result = cli([]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /no input file/);
  });

  check("unknown option exits 2", () => {
    const result = cli(["--frobnicate"]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /unknown option/);
  });

  check("--output with several inputs exits 2", () => {
    const result = cli([fixture("01_basics.lua"), fixture("02_control.lua"), "--output", "out.lua"]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--output can only be used with a single input/);
  });

  check("unknown preset exits 1", () => {
    const result = cli([fixture("01_basics.lua"), "--preset", "nope", "--stdout"]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /unknown preset "nope"/);
  });

  check("missing input file exits 1", () => {
    const result = cli([path.join(workspace, "does-not-exist.lua")]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /cannot read/);
  });

  check("--max-bytes refuses oversized output", () => {
    const result = cli([fixture("01_basics.lua"), "--max-bytes", "64", "--stdout"]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /exceeds/);
  });

  check("unknown toggle exits 2", () => {
    const result = cli([fixture("01_basics.lua"), "--set", "nonsense=on"]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /unknown toggle/);
  });

  console.log("\noutput");

  check("writes <name>.reveil.lua next to the input by default", () => {
    const input = fixture("03_functions.lua");
    const expected = path.join(workspace, "03_functions.reveil.lua");
    fs.rmSync(expected, { force: true });
    const result = cli([input, "--quiet"]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(expected), "no .reveil.lua file was written");
    assert.match(fs.readFileSync(expected, "utf8"), /ReVeil/);
  });

  check("--output honours an explicit path", () => {
    const input = fixture("04_tables_methods.lua");
    const target = path.join(workspace, "nested", "custom.lua");
    const result = cli([input, "--output", target, "--quiet"]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(target), "no file at the requested path");
  });

  check("--stdout keeps stdout pure Lua and logs on stderr", () => {
    const result = cli([fixture("01_basics.lua"), "--stdout", "--seed", "purity"]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /^--\[\[|^\s*return/, "stdout must start with the banner or the payload");
    assert.ok(!result.stdout.includes("ReVeil: "), "status line leaked into stdout");
    assert.match(result.stderr, /extreme/);
  });

  check("--stats reports the transforms", () => {
    const result = cli([fixture("01_basics.lua"), "--stats", "--preset", "extreme", "--stdout"]);
    assert.strictEqual(result.status, 0, result.stderr);
    for (const row of ["input", "output", "ratio", "time", "protos"]) {
      assert.ok(result.stderr.includes(row), `stats are missing ${row}`);
    }
  });

  check("the same seed reproduces the same bytes", () => {
    const input = fixture("01_basics.lua");
    const first = cli([input, "--stdout", "--seed", "reproducible", "--preset", "heavy"]);
    const second = cli([input, "--stdout", "--seed", "reproducible", "--preset", "heavy"]);
    const third = cli([input, "--stdout", "--seed", "different", "--preset", "heavy"]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(first.stdout, second.stdout);
    assert.notStrictEqual(first.stdout, third.stdout);
  });

  check("--stdin obfuscates piped source", () => {
    const result = cli(["--stdin", "--stdout", "--preset", "light", "--quiet"], { input: 'print("piped")\n' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /--\[\[ ReVeil/);
  });

  console.log("\npayloads");

  await checkAsync("the default (extreme) payload runs and matches the reference", async () => {
    const input = fixture("01_basics.lua");
    const result = cli([input, "--stdout", "--quiet"]);
    assert.strictEqual(result.status, 0, result.stderr);
    const reference = await runLua(fs.readFileSync(input, "utf8"));
    const run = await runLua(result.stdout);
    assert.strictEqual(run.ok, true, run.err);
    assert.strictEqual(run.out, reference.out);
  });

  await checkAsync("every preset produces a working payload", async () => {
    const input = fixture("02_control.lua");
    const source = fs.readFileSync(input, "utf8");
    const reference = await runLua(source);
    for (const preset of ["light", "medium", "heavy", "extreme"]) {
      const result = cli([input, "--stdout", "--quiet", "--preset", preset, "--seed", "1234"]);
      assert.strictEqual(result.status, 0, `${preset}: ${result.stderr}`);
      const run = await runLua(result.stdout);
      assert.strictEqual(run.ok, true, `${preset}: ${run.err}`);
      assert.strictEqual(run.out, reference.out, `${preset}: output mismatch`);
    }
  });

  await checkAsync("the file written to disk is the file that runs", async () => {
    const input = fixture("05_strings_numbers.lua");
    const target = path.join(workspace, "05_strings_numbers.disk.lua");
    fs.rmSync(target, { force: true });
    const result = cli([input, "--output", target, "--preset", "extreme", "--seed", "99", "--quiet"]);
    assert.strictEqual(result.status, 0, result.stderr);
    const reference = await runLua(fs.readFileSync(input, "utf8"));
    const run = await runLua(fs.readFileSync(target, "utf8"));
    assert.strictEqual(run.ok, true, run.err);
    assert.strictEqual(run.out, reference.out);
  });

  fs.rmSync(workspace, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\n${checks}/${checks} CLI checks passed`
      : `\n${checks - failures}/${checks} CLI checks passed, ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
