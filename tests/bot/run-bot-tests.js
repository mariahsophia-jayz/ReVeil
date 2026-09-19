#!/usr/bin/env node
/**
 * ReVeil Discord bot test suite — no gateway connection, no network.
 *
 * Covers two things:
 *   1. the registered command payload (`/obfuscate`, `/presets`)
 *   2. `handleObfuscate()`, including the promise made in the command
 *      description: `/obfuscate` with no `preset` runs the **extreme** preset.
 *
 * The produced payloads are executed in the sandboxed Lua interpreter, so a
 * regression in the engine shows up here as well.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const CASES = path.join(ROOT, "tests", "lua", "cases");

const { runLua } = require("../lua/harness.js");
const {
  COMMAND_JSON,
  DEFAULT_BOT_PRESET,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  PRESET_LABELS,
} = require(path.join(DIST, "bot", "commands.js"));
const {
  handleObfuscate,
  isLuaFilename,
  outputFilename,
  parseSeedOption,
} = require(path.join(DIST, "bot", "obfuscate.js"));
const { PRESET_NAMES, obfuscate } = require(path.join(DIST, "index.js"));

let checks = 0;
let failures = 0;

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

function command(name) {
  return COMMAND_JSON.find((entry) => entry.name === name);
}

function option(payload, name) {
  return (payload.options ?? []).find((entry) => entry.name === name);
}

const source = fs.readFileSync(path.join(CASES, "01_basics.lua"), "utf8");
/** Mirrors what `handleObfuscate()` passes to the engine, for parity checks. */
const botLikeOptions = { language: "lua", filename: "01_basics.lua", maxOutputBytes: MAX_OUTPUT_BYTES };

async function main() {
  console.log("command payload");

  check("/obfuscate is registered", () => {
    const payload = command("obfuscate");
    assert.ok(payload, "no /obfuscate command in the payload");
    assert.match(payload.description, /Lua/);
  });

  check("/obfuscate.preset is optional and defaults to extreme", () => {
    const preset = option(command("obfuscate"), "preset");
    assert.ok(preset, "no preset option");
    assert.strictEqual(preset.type, 3, "preset must be a string option");
    assert.notStrictEqual(preset.required, true, "preset must be optional so it can fall back to extreme");
    assert.match(preset.description, new RegExp(`Defaults to ${DEFAULT_BOT_PRESET}`));
    assert.deepStrictEqual(
      (preset.choices ?? []).map((choice) => choice.value),
      [...PRESET_NAMES],
      "every preset must be selectable",
    );
    for (const choice of preset.choices) {
      assert.ok(choice.name.length <= 100, `choice label too long: ${choice.name}`);
      assert.ok(choice.name.length > 0);
    }
  });

  check("preset choice labels cover every preset", () => {
    assert.deepStrictEqual(Object.keys(PRESET_LABELS).sort(), [...PRESET_NAMES].sort());
  });

  check("/obfuscate accepts file, code, seed, target and share", () => {
    const payload = command("obfuscate");
    for (const name of ["file", "code", "seed", "target", "share"]) {
      assert.ok(option(payload, name), `missing option ${name}`);
    }
    assert.strictEqual(option(payload, "code").max_length, 6000);
  });

  check("/presets is registered", () => {
    assert.ok(command("presets"), "no /presets command");
  });

  console.log("\nhandler");

  check("no preset means extreme", () => {
    const result = handleObfuscate({ source, filename: "01_basics.lua" });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.preset, "extreme");
    assert.strictEqual(DEFAULT_BOT_PRESET, "extreme");
  });

  check("bot default output equals engine extreme output", () => {
    const fromBot = handleObfuscate({ source, filename: "01_basics.lua" });
    const direct = obfuscate(source, { ...botLikeOptions, preset: "extreme" });
    assert.strictEqual(direct.ok, true, direct.error);
    assert.strictEqual(fromBot.code, direct.code, "bot output drifted from obfuscate({preset:'extreme'})");
  });

  check("explicit preset is honoured", () => {
    for (const preset of PRESET_NAMES) {
      const result = handleObfuscate({ source, filename: "01_basics.lua", preset });
      assert.strictEqual(result.ok, true, result.error);
      assert.strictEqual(result.preset, preset);
    }
  });

  check("numeric seed matches the engine's numeric seed", () => {
    const fromBot = handleObfuscate({ source, filename: "01_basics.lua", seed: "4242" });
    const direct = obfuscate(source, { ...botLikeOptions, preset: "extreme", seed: 4242 });
    assert.strictEqual(fromBot.code, direct.code, "`/obfuscate seed: 4242` and --seed 4242 must agree");
    assert.strictEqual(parseSeedOption("4242"), 4242);
    assert.strictEqual(parseSeedOption("nightly"), "nightly");
    assert.strictEqual(parseSeedOption(""), undefined);
    assert.strictEqual(parseSeedOption(null), undefined);
  });

  check("same seed reproduces, different seeds differ", () => {
    const a = handleObfuscate({ source, filename: "01_basics.lua", seed: "stable" });
    const b = handleObfuscate({ source, filename: "01_basics.lua", seed: "stable" });
    const c = handleObfuscate({ source, filename: "01_basics.lua", seed: "other" });
    assert.strictEqual(a.code, b.code);
    assert.notStrictEqual(a.code, c.code);
  });

  check("the Lua-only guard rejects other languages", () => {
    for (const filename of ["script.py", "app.js", "notes.txt", "makefile"]) {
      const result = handleObfuscate({ source, filename });
      assert.strictEqual(result.ok, false, `${filename} should have been rejected`);
      assert.match(result.error, /Lua-only/);
    }
    assert.strictEqual(isLuaFilename("GAME.LUA"), true);
    assert.strictEqual(isLuaFilename("game.luau"), true);
    assert.strictEqual(isLuaFilename("game.py"), false);
  });

  check("empty and oversized inputs are rejected before the engine runs", () => {
    const empty = handleObfuscate({ source: "   \n", filename: "a.lua" });
    assert.strictEqual(empty.ok, false);
    assert.match(empty.error, /Attach/);

    const huge = handleObfuscate({ source: "-- pad\n".repeat(Math.ceil(MAX_INPUT_BYTES / 7) + 10), filename: "a.lua" });
    assert.strictEqual(huge.ok, false);
    assert.match(huge.error, /limit/);
  });

  check("output filenames are flattened and suffixed", () => {
    assert.strictEqual(outputFilename("game.lua"), "game.reveil.lua");
    assert.strictEqual(outputFilename("/tmp/uploads/Game Script.luau"), "Game Script.reveil.lua");
    assert.strictEqual(outputFilename("C:\\uploads\\game.lua"), "game.reveil.lua");
    assert.strictEqual(outputFilename(undefined), "input.reveil.lua");
  });

  check("embed fields describe the run", () => {
    const result = handleObfuscate({ source, filename: "01_basics.lua" });
    const names = result.fields.map((field) => field.name);
    for (const expected of ["Preset", "Seed", "Time", "Size"]) {
      assert.ok(names.includes(expected), `missing field ${expected}`);
    }
    assert.match(result.fields.find((field) => field.name === "Preset").value, /extreme/);
    assert.ok(Number.isInteger(result.seed) && result.seed >= 0, `seed should be an unsigned int, got ${result.seed}`);
    assert.strictEqual(result.filename, "01_basics.reveil.lua");
  });

  await checkAsync("the extreme payload runs and matches the reference output", async () => {
    const reference = await runLua(source);
    assert.strictEqual(reference.ok, true, reference.err);
    const result = handleObfuscate({ source, filename: "01_basics.lua", seed: "bot-test" });
    const run = await runLua(result.code);
    assert.strictEqual(run.ok, true, run.err);
    assert.strictEqual(run.out, reference.out);
  });

  console.log(
    failures === 0
      ? `\n${checks}/${checks} bot checks passed`
      : `\n${checks - failures}/${checks} bot checks passed, ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
