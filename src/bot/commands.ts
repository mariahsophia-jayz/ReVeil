/**
 * Discord slash-command definitions for the ReVeil bot.
 *
 * The bot is Lua-only on purpose: it exposes `/obfuscate` for `.lua` / `.luau`
 * sources and nothing else. Both commands are declared here so the gateway
 * (index.ts) and the registrar (deploy-commands.ts) always agree, and so the
 * test suite can assert the shape of the registered payload.
 */

import { SlashCommandBuilder } from "discord.js";

import { PRESET_NAMES } from "../core/presets";
import type { PresetName } from "../core/types";

/** `/obfuscate` with no `preset` option uses this — the heaviest ReVeil build. */
export const DEFAULT_BOT_PRESET: PresetName = "extreme";

/** Discord's 8 MiB upload ceiling, minus room for the embed payload. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024 - 8 * 1024;

/** Refuse to pull attachments bigger than this. */
export const MAX_INPUT_BYTES = 512 * 1024;

/** Slash-command string options are capped well below 6000 characters. */
export const MAX_INLINE_CODE_CHARS = 6000;

export const LUA_TARGETS = ["5.1", "5.2", "5.3", "5.4", "luajit", "luau", "universal"] as const;

/** Choice labels stay well under Discord's 100 character limit. */
export const PRESET_LABELS: Record<PresetName, string> = {
  light: "light - renamed identifiers, encrypted strings",
  medium: "medium - + encoded numbers, dead code",
  heavy: "heavy - + control-flow flattening, bytecode VM",
  extreme: "extreme - everything ReVeil has (default)",
};

export const obfuscateCommand = new SlashCommandBuilder()
  .setName("obfuscate")
  .setDescription("Obfuscate a Lua/Luau script with ReVeil.")
  .setDMPermission(true)
  .addAttachmentOption((option) =>
    option
      .setName("file")
      .setDescription("The .lua / .luau file to obfuscate (mutually exclusive with code)."),
  )
  .addStringOption((option) =>
    option
      .setName("code")
      .setDescription("Inline Lua source, up to 6000 characters.")
      .setMaxLength(MAX_INLINE_CODE_CHARS),
  )
  .addStringOption((option) =>
    option
      .setName("preset")
      .setDescription(`Hardening level. Defaults to ${DEFAULT_BOT_PRESET}.`)
      .addChoices(...PRESET_NAMES.map((name) => ({ name: PRESET_LABELS[name], value: name }))),
  )
  .addStringOption((option) =>
    option.setName("seed").setDescription("Deterministic seed (number or text). Same seed, same output."),
  )
  .addStringOption((option) =>
    option
      .setName("target")
      .setDescription("Lua dialect to emit for. Defaults to universal.")
      .addChoices(...LUA_TARGETS.map((target) => ({ name: target, value: target }))),
  )
  .addBooleanOption((option) =>
    option.setName("share").setDescription("Post the result publicly instead of ephemerally. Default: no."),
  );

export const presetsCommand = new SlashCommandBuilder()
  .setName("presets")
  .setDescription("List the ReVeil presets and what each one enables.");

export const COMMANDS = [obfuscateCommand, presetsCommand];

export const COMMAND_JSON = COMMANDS.map((command) => command.toJSON());
