#!/usr/bin/env node
/**
 * ReVeil Discord bot.
 *
 * A thin gateway adapter around `handleObfuscate()`: it only requests the
 * `Guilds` intent (no message content, no members), answers `/obfuscate` and
 * `/presets`, and streams nothing back to the channel — the obfuscated script is
 * uploaded as an ephemeral attachment unless the invoker passes `share: true`.
 *
 * Environment:
 *   DISCORD_TOKEN           required, bot token
 *   DISCORD_MAX_OUTPUT_BYTES optional, overrides the 8 MiB attachment ceiling
 *
 * Register the commands first with `npm run bot:deploy`.
 */

import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";

import { PRESET_DESCRIPTIONS, PRESET_NAMES } from "../core/presets";
import { REVEIL_VERSION } from "../index";
import {
  DEFAULT_BOT_PRESET,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  obfuscateCommand,
  presetsCommand,
} from "./commands";
import { handleObfuscate, isLuaFilename } from "./obfuscate";

const ACCENT = 0x6e56cf;

/** `DISCORD_MAX_OUTPUT_BYTES` overrides the 8 MiB attachment ceiling. */
function outputLimit(): number {
  const raw = Number(process.env.DISCORD_MAX_OUTPUT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_OUTPUT_BYTES;
}

function banner(): EmbedBuilder {
  return new EmbedBuilder().setColor(ACCENT).setFooter({ text: `ReVeil v${REVEIL_VERSION}` });
}

async function readAttachment(url: string, name: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not download \`${name}\` (HTTP ${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`\`${name}\` is ${buffer.byteLength} bytes, the limit is ${MAX_INPUT_BYTES} bytes`);
  }
  return buffer.toString("utf8");
}

async function runObfuscate(interaction: ChatInputCommandInteraction): Promise<void> {
  const file = interaction.options.getAttachment("file");
  const inline = interaction.options.getString("code");
  const preset = interaction.options.getString("preset");
  const seed = interaction.options.getString("seed");
  const target = interaction.options.getString("target");
  const share = interaction.options.getBoolean("share") ?? false;

  const flags = share ? undefined : MessageFlags.Ephemeral;
  await interaction.deferReply(flags ? { flags } : {});

  if (file && inline) {
    await interaction.editReply({
      embeds: [banner().setDescription("Use either `file` or `code`, not both.")],
    });
    return;
  }
  if (!file && !inline) {
    await interaction.editReply({
      embeds: [
        banner().setDescription(
          "Attach a `.lua` / `.luau` file with `file`, or paste source in `code`.\n" +
            `No preset means **${DEFAULT_BOT_PRESET}**.`,
        ),
      ],
    });
    return;
  }

  try {
    let source = inline ?? "";
    let filename = "input.lua";
    if (file) {
      if (!isLuaFilename(file.name)) {
        await interaction.editReply({
          embeds: [
            banner().setDescription(
              `The ReVeil bot is Lua-only — \`${file.name}\` is not a \`.lua\`/\`.luau\` file.`,
            ),
          ],
        });
        return;
      }
      filename = file.name;
      source = await readAttachment(file.url, file.name);
    }

    const result = handleObfuscate({
      source,
      filename,
      preset,
      seed,
      target,
      watermark: `discord:${interaction.user.tag}`,
      maxOutputBytes: outputLimit(),
    });

    if (!result.ok) {
      await interaction.editReply({
        embeds: [banner().setTitle("ReVeil could not obfuscate that").addFields(result.fields)],
      });
      return;
    }

    const attachment = new AttachmentBuilder(Buffer.from(result.code, "utf8"), { name: result.filename });
    const embed = banner()
      .setTitle(`${result.filename}`)
      .setDescription(
        `Obfuscated with the **${result.preset}** preset — re-run with the same seed (\`${result.seed}\`) for identical output.`,
      )
      .addFields(result.fields);

    await interaction.editReply({ embeds: [embed], files: [attachment] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      embeds: [banner().setTitle("ReVeil error").setDescription(message.slice(0, 1000))],
    });
  }
}

async function runPresets(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = banner()
    .setTitle("ReVeil presets")
    .setDescription(`\`/obfuscate\` with no preset uses **${DEFAULT_BOT_PRESET}**.`)
    .addFields(
      ...PRESET_NAMES.map((name) => ({
        name: `${name}${name === DEFAULT_BOT_PRESET ? " (default)" : ""}`,
        value: PRESET_DESCRIPTIONS[name],
      })),
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export function createClient(): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (ready) => {
    console.log(`ReVeil bot v${REVEIL_VERSION} online as ${ready.user.tag}`);
    ready.user.setActivity(`/obfuscate • preset ${DEFAULT_BOT_PRESET}`, { type: 3 });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    if (interaction.commandName === obfuscateCommand.name) {
      void runObfuscate(interaction);
      return;
    }
    if (interaction.commandName === presetsCommand.name) {
      void runPresets(interaction);
      return;
    }
    void interaction.reply({
      content: `Unknown command \`${interaction.commandName}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  });

  client.on(Events.Error, (error) => {
    console.error("ReVeil bot error:", error);
  });

  return client;
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN is not set. Create a bot token and export it before starting the bot.");
    process.exitCode = 1;
    return;
  }
  const client = createClient();
  const shutdown = (): void => {
    void client.destroy().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await client.login(token);
}

if (require.main === module) {
  void main();
}
