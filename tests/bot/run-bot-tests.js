#!/usr/bin/env node
/**
 * ReVeil Discord bot test suite — no gateway connection, no network.
 *
 * Covers three things:
 *   1. the registered command payload (`/obfuscate`, `/presets`, access commands)
 *   2. `handleObfuscate()`, including the promise made in the command
 *      description: `/obfuscate` with no `preset` runs the **extreme** preset
 *   3. the owner-gated access rules (`authorizeObfuscate()` and the store).
 *
 * The produced payloads are executed in the sandboxed Lua interpreter, so a
 * regression in the engine shows up here as well.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const CASES = path.join(ROOT, "tests", "lua", "cases");

// Point the access store at a scratch file before loading the module.
const ACCESS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reveil-access-")), "access.json");
process.env.REVEIL_ACCESS_FILE = ACCESS_FILE;
delete process.env.REVEIL_OWNER_ID;

const { runLua } = require("../lua/harness.js");
const {
  COMMAND_JSON,
  DEFAULT_BOT_PRESET,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  OWNER_ONLY_COMMANDS,
  PRESET_LABELS,
} = require(path.join(DIST, "bot", "commands.js"));
const access = require(path.join(DIST, "bot", "access.js"));
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

  console.log("\naccess control");

  const OWNER = "1380042914922758224";
  const MATE = "222222222222222222";
  const CHANNEL = "333333333333333333";
  const ELSEWHERE = "444444444444444444";
  const inGuild = (userId, channelId) => access.authorizeObfuscate({ userId, channelId, inGuild: true });
  const inDm = (userId) => access.authorizeObfuscate({ userId, channelId: null, inGuild: false });

  check("a fresh install is owner-only", () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    assert.strictEqual(access.accessFilePath(), ACCESS_FILE);
    assert.strictEqual(access.DEFAULT_OWNER_ID, OWNER);

    assert.strictEqual(inGuild(OWNER, CHANNEL).allowed, true);
    assert.strictEqual(inDm(OWNER).allowed, true);
    assert.strictEqual(inGuild(OWNER, CHANNEL).reason, "owner");

    const stranger = inGuild(MATE, CHANNEL);
    assert.strictEqual(stranger.allowed, false);
    assert.strictEqual(stranger.reason, "denied");
    assert.match(stranger.detail, /\/give-access/);
    assert.strictEqual(inDm(MATE).allowed, false);
  });

  check("the owner snowflake survives as a string", () => {
    assert.strictEqual(access.readAccess().owner, OWNER);
    assert.strictEqual(typeof access.readAccess().owner, "string");
    assert.strictEqual(access.isOwner(OWNER), true);
    // 1380042914922758224 > Number.MAX_SAFE_INTEGER, so this must NOT match.
    assert.notStrictEqual(String(Number(OWNER)), OWNER);
    assert.strictEqual(access.isOwner(String(Number(OWNER))), false);
  });

  check("REVEIL_OWNER_ID overrides the stored owner", () => {
    process.env.REVEIL_OWNER_ID = MATE;
    assert.strictEqual(access.ownerId(), MATE);
    assert.strictEqual(inDm(MATE).allowed, true);
    assert.strictEqual(inDm(OWNER).allowed, false);
    delete process.env.REVEIL_OWNER_ID;
    assert.strictEqual(access.ownerId(), OWNER);
    assert.strictEqual(inDm(OWNER).allowed, true);
  });

  check("/give-access opens /obfuscate in servers and DMs, /take-access closes it", () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    assert.strictEqual(inDm(MATE).allowed, false);

    assert.strictEqual(access.grantUser(MATE).changed, true);
    assert.strictEqual(inGuild(MATE, ELSEWHERE).allowed, true);
    assert.strictEqual(inGuild(MATE, ELSEWHERE).reason, "user");
    assert.strictEqual(inDm(MATE).allowed, true);

    assert.strictEqual(access.grantUser(MATE).changed, false, "granting twice must be a no-op");

    assert.strictEqual(access.revokeUser(MATE).changed, true);
    assert.strictEqual(inGuild(MATE, ELSEWHERE).allowed, false);
    assert.strictEqual(inDm(MATE).allowed, false);
    assert.strictEqual(access.revokeUser(MATE).changed, false, "revoking twice must be a no-op");
  });

  check("/access-channel is scoped to that one channel, /remove-channel closes it", () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    assert.strictEqual(access.grantChannel(CHANNEL).changed, true);

    assert.strictEqual(inGuild(MATE, CHANNEL).allowed, true);
    assert.strictEqual(inGuild(MATE, CHANNEL).reason, "channel");
    assert.strictEqual(inGuild(MATE, ELSEWHERE).allowed, false, "other channels must stay closed");
    assert.strictEqual(inDm(MATE).allowed, false, "a channel grant must not open DMs");
    assert.strictEqual(inGuild(OWNER, ELSEWHERE).allowed, true, "the owner is never locked out");

    assert.strictEqual(access.revokeChannel(CHANNEL).changed, true);
    assert.strictEqual(inGuild(MATE, CHANNEL).allowed, false);
    assert.strictEqual(access.revokeChannel(CHANNEL).changed, false);
  });

  check("grants are persisted to the access file", () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    access.grantUser(MATE);
    access.grantChannel(CHANNEL);

    const onDisk = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    assert.deepStrictEqual(onDisk.users, [MATE]);
    assert.deepStrictEqual(onDisk.channels, [CHANNEL]);
    assert.strictEqual(onDisk.owner, OWNER);

    const reloaded = access.readAccess();
    assert.deepStrictEqual(reloaded.users, [MATE]);
    assert.strictEqual(inDm(MATE).allowed, true, "grants must survive a reload");
  });

  check("a corrupt or hand-edited store cannot lock the owner out", () => {
    fs.writeFileSync(ACCESS_FILE, "{not json", "utf8");
    assert.strictEqual(access.readAccess().owner, OWNER);
    assert.strictEqual(inDm(OWNER).allowed, true);

    fs.writeFileSync(ACCESS_FILE, JSON.stringify({ owner: OWNER, users: ["nope", MATE, 123456789012345678], channels: [null] }), "utf8");
    const reloaded = access.readAccess();
    // A bare number in JSON has already lost precision at this point (snowflakes
    // are past 2^53), so it is dropped instead of being trusted as an id.
    assert.ok(!Number.isSafeInteger(123456789012345678), "premise: numeric snowflakes are lossy");
    assert.deepStrictEqual(reloaded.users, [MATE]);
    assert.deepStrictEqual(reloaded.channels, []);
    assert.strictEqual(inDm(MATE).allowed, true);

    // Safe-range numbers (e.g. written by a script) are still accepted.
    fs.writeFileSync(ACCESS_FILE, JSON.stringify({ owner: OWNER, users: [222222222222222], channels: [] }), "utf8");
    assert.deepStrictEqual(access.readAccess().users, ["222222222222222"]);
    fs.rmSync(ACCESS_FILE, { force: true });
  });

  check("malformed ids are rejected", () => {
    for (const bad of ["nope", "", "12345", "1380042914922758224; rm -rf /"]) {
      assert.throws(() => access.grantUser(bad), /Discord id/);
      assert.throws(() => access.grantChannel(bad), /Discord id/);
    }
    assert.strictEqual(access.isSnowflake(OWNER), true);
    assert.strictEqual(access.isSnowflake("abc"), false);
  });

  check("only the owner may run the access commands", () => {
    assert.strictEqual(access.canManageAccess(OWNER), true);
    assert.strictEqual(access.canManageAccess(MATE), false);
    assert.deepStrictEqual([...OWNER_ONLY_COMMANDS].sort(), [
      "access-channel",
      "access-list",
      "give-access",
      "remove-channel",
      "take-access",
    ]);
  });

  check("every command is usable in DMs and the access commands take the right options", () => {
    assert.strictEqual(COMMAND_JSON.length, 7);
    for (const payload of COMMAND_JSON) {
      assert.strictEqual(payload.dm_permission, true, `${payload.name} must work in DMs`);
    }
    const byName = Object.fromEntries(COMMAND_JSON.map((payload) => [payload.name, payload]));

    for (const name of ["give-access", "take-access"]) {
      const user = (byName[name].options ?? []).find((entry) => entry.name === "user");
      assert.ok(user, `${name} needs a user option`);
      assert.strictEqual(user.type, 6, `${name}: user option must be a User`);
      assert.strictEqual(user.required, true);
    }
    for (const name of ["access-channel", "remove-channel"]) {
      const channel = (byName[name].options ?? []).find((entry) => entry.name === "channel");
      assert.ok(channel, `${name} needs a channel option`);
      assert.strictEqual(channel.type, 7, `${name}: channel option must be a Channel`);
      assert.strictEqual(channel.required, true);
      assert.ok((channel.channel_types ?? []).length > 0, `${name}: restrict to text channels`);
    }
  });

  console.log("\ngateway routing");

  // Build the real client (no login) and emit interactions at it, so the routing
  // and the guards in src/bot/index.ts actually execute.
  const { createClient } = require(path.join(DIST, "bot", "index.js"));
  const { Events } = require("discord.js");
  const client = createClient();

  function fakeInteraction(overrides = {}) {
    const calls = { replies: [], edits: [] };
    const interaction = {
      commandName: "obfuscate",
      user: { id: OWNER, tag: "owner#0001" },
      client: {
        users: { fetch: async () => ({ tag: "mate#0002" }) },
        channels: { fetch: async () => ({ name: "general" }) },
      },
      inGuild: () => true,
      channelId: CHANNEL,
      isChatInputCommand: () => true,
      options: {
        getAttachment: () => null,
        getString: (name) => (name === "code" ? source : null),
        getBoolean: () => false,
        getUser: () => ({ id: MATE, tag: "mate#0002", toString: () => "<@mate>" }),
        getChannel: () => ({ id: CHANNEL, name: "general", toString: () => "#general" }),
      },
      reply: async (payload) => {
        calls.replies.push(payload);
      },
      deferReply: async () => {},
      editReply: async (payload) => {
        calls.edits.push(payload);
      },
      ...overrides,
    };
    return { interaction, calls };
  }

  async function dispatch(overrides) {
    const { interaction, calls } = fakeInteraction(overrides);
    client.emit(Events.InteractionCreate, interaction);
    for (let tick = 0; tick < 40; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (calls.replies.length > 0 || calls.edits.length > 0) {
        break;
      }
    }
    return calls;
  }

  const embedText = (payload) =>
    (payload.embeds ?? []).map((embed) => `${embed.data?.title ?? ""} ${embed.data?.description ?? ""}`).join(" ");

  await checkAsync("a stranger is refused /obfuscate before the engine runs", async () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    const calls = await dispatch({ user: { id: MATE, tag: "mate#0002" } });
    assert.strictEqual(calls.edits.length, 0, "no payload may be produced for a denied user");
    assert.strictEqual(calls.replies.length, 1);
    assert.match(embedText(calls.replies[0]), /Access denied/);
    // The refusal must be ephemeral (MessageFlags.Ephemeral = 1 << 6), so the
    // channel sees nothing. discord.js v14 passes the flag as a plain number.
    const flags = calls.replies[0].flags;
    const bits = typeof flags === "number" ? flags : flags.bitfield;
    assert.strictEqual(bits & 64, 64, "refusals must be ephemeral");
  });

  await checkAsync("the owner can run /obfuscate with inline code", async () => {
    const calls = await dispatch({});
    assert.strictEqual(calls.edits.length, 1, "the owner's request must produce a payload");
    const files = calls.edits[0].files ?? [];
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, "input.reveil.lua");
    assert.match(calls.edits[0].files[0].attachment.toString("utf8").slice(0, 40), /ReVeil/);
  });

  await checkAsync("/give-access is owner-only and persists the grant", async () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    const refused = await dispatch({ commandName: "give-access", user: { id: MATE, tag: "mate#0002" } });
    assert.match(embedText(refused.replies[0]), /Owner only/);
    assert.deepStrictEqual(access.readAccess().users, [], "a non-owner must not be able to grant access");

    const granted = await dispatch({ commandName: "give-access" });
    assert.match(embedText(granted.replies[0]), /Access granted/);
    assert.deepStrictEqual(access.readAccess().users, [MATE]);
  });

  await checkAsync("a granted user can run /obfuscate, including in DMs", async () => {
    const inServer = await dispatch({ commandName: "obfuscate", user: { id: MATE, tag: "mate#0002" }, channelId: ELSEWHERE });
    assert.strictEqual(inServer.edits.length, 1, "granted user should get a payload in any channel");

    const inDmCalls = await dispatch({
      user: { id: MATE, tag: "mate#0002" },
      inGuild: () => false,
      channelId: null,
    });
    assert.strictEqual(inDmCalls.edits.length, 1, "granted user should get a payload in DMs");
  });

  await checkAsync("/take-access closes it again", async () => {
    const calls = await dispatch({ commandName: "take-access" });
    assert.match(embedText(calls.replies[0]), /Access removed/);
    const refused = await dispatch({ user: { id: MATE, tag: "mate#0002" } });
    assert.strictEqual(refused.edits.length, 0);
    assert.match(embedText(refused.replies[0]), /Access denied/);
  });

  await checkAsync("/access-channel opens one channel and refuses to run in DMs", async () => {
    fs.rmSync(ACCESS_FILE, { force: true });
    const opened = await dispatch({ commandName: "access-channel" });
    assert.match(embedText(opened.replies[0]), /Channel opened/);
    assert.deepStrictEqual(access.readAccess().channels, [CHANNEL]);

    const mateInChannel = await dispatch({ user: { id: MATE, tag: "mate#0002" } });
    assert.strictEqual(mateInChannel.edits.length, 1, "everyone in the open channel may obfuscate");

    const mateElsewhere = await dispatch({ user: { id: MATE, tag: "mate#0002" }, channelId: ELSEWHERE });
    assert.strictEqual(mateElsewhere.edits.length, 0, "the grant must not leak to other channels");

    const inDm = await dispatch({ commandName: "access-channel", inGuild: () => false, channelId: null });
    assert.match(embedText(inDm.replies[0]), /Servers only/);
  });

  await checkAsync("/remove-channel closes it and /access-list reports the state", async () => {
    const closed = await dispatch({ commandName: "remove-channel" });
    assert.match(embedText(closed.replies[0]), /Channel closed/);
    assert.deepStrictEqual(access.readAccess().channels, []);

    const list = await dispatch({ commandName: "access-list" });
    const text = embedText(list.replies[0]);
    assert.match(text, /ReVeil access/);
    assert.ok(text.includes(OWNER), "the list must show the owner id");

    const strangerList = await dispatch({ commandName: "access-list", user: { id: MATE, tag: "mate#0002" } });
    assert.match(embedText(strangerList.replies[0]), /Owner only/);
  });

  await checkAsync("an unknown command is answered, not ignored", async () => {
    const calls = await dispatch({ commandName: "frobnicate" });
    assert.strictEqual(calls.replies.length, 1);
    assert.match(calls.replies[0].content ?? "", /Unknown command/);
  });

  await client.destroy();
  fs.rmSync(path.dirname(ACCESS_FILE), { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\n${checks}/${checks} bot checks passed`
      : `\n${checks - failures}/${checks} bot checks passed, ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
