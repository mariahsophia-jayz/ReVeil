#!/usr/bin/env node
/**
 * ReVeil Discord bot.
 *
 * A thin gateway adapter around `handleObfuscate()`: it only requests the
 * `Guilds` intent (no message content, no members), answers `/obfuscate` and
 * `/presets`, and streams nothing back to the channel — the obfuscated script is
 * uploaded as an ephemeral attachment unless the invoker passes `share: true`.
 *
 * The bot is **private**. Only the owner may use it until the owner opens it up
 * with `/give-access <user>` (one account, servers and DMs) or
 * `/access-channel <channel>` (everyone in that channel). `/take-access` and
 * `/remove-channel` close those again; `/access-list` shows the current state.
 * All five access commands are owner-only, and every command works in DMs.
 *
 * Environment:
 *   DISCORD_TOKEN            required, bot token
 *   REVEIL_OWNER_ID          optional, owner snowflake (default 1380042914922758224)
 *   REVEIL_ACCESS_FILE       optional, access store path (default data/access.json)
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
  accessChannelCommand,
  accessListCommand,
  DEFAULT_BOT_PRESET,
  giveAccessCommand,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  obfuscateCommand,
  presetsCommand,
  removeChannelCommand,
  takeAccessCommand,
} from "./commands";
import {
  accessFilePath,
  authorizeObfuscate,
  canManageAccess,
  grantChannel,
  grantUser,
  ownerId,
  readAccess,
  revokeChannel,
  revokeUser,
} from "./access";
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

/** Denies quietly: the refusal is ephemeral, so the channel sees nothing. */
async function replyPrivate(interaction: ChatInputCommandInteraction, title: string, description: string): Promise<void> {
  await interaction.reply({
    embeds: [banner().setTitle(title).setDescription(description.slice(0, 4000))],
    flags: MessageFlags.Ephemeral,
  });
}

/** Gate for `/obfuscate` and `/presets`. Returns false (and replies) when denied. */
async function guardUsage(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const decision = authorizeObfuscate({
    userId: interaction.user.id,
    channelId: interaction.inGuild() ? interaction.channelId : null,
    inGuild: interaction.inGuild(),
  });
  if (decision.allowed) {
    return true;
  }
  await replyPrivate(interaction, "Access denied", decision.detail);
  return false;
}

/** Gate for the five owner-only access commands. */
async function guardOwner(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (canManageAccess(interaction.user.id)) {
    return true;
  }
  await replyPrivate(
    interaction,
    "Owner only",
    `\`${interaction.commandName}\` is restricted to the owner of this bot.`,
  );
  return false;
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
  if (!(await guardUsage(interaction))) {
    return;
  }

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
  if (!(await guardUsage(interaction))) {
    return;
  }
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

/** Best-effort `name (id)` labels for `/access-list`; falls back to the bare id. */
async function labelUser(interaction: ChatInputCommandInteraction, id: string): Promise<string> {
  try {
    const user = await interaction.client.users.fetch(id);
    return `${user.tag} (\`${id}\`)`;
  } catch {
    return `\`${id}\``;
  }
}

async function labelChannel(interaction: ChatInputCommandInteraction, id: string): Promise<string> {
  try {
    const channel = await interaction.client.channels.fetch(id);
    const name = (channel as { name?: string } | null)?.name;
    return name ? `#${name} (\`${id}\`)` : `\`${id}\``;
  } catch {
    return `\`${id}\``;
  }
}

async function runGiveAccess(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await guardOwner(interaction))) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const { changed } = grantUser(user.id);
  await replyPrivate(
    interaction,
    changed ? "Access granted" : "Already had access",
    `${user} (\`${user.id}\`) can now run \`/obfuscate\` — in servers and in DMs.` +
      (changed ? "" : " Nothing changed."),
  );
}

async function runTakeAccess(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await guardOwner(interaction))) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const { changed } = revokeUser(user.id);
  await replyPrivate(
    interaction,
    changed ? "Access removed" : "No access to remove",
    changed
      ? `${user} (\`${user.id}\`) can no longer run \`/obfuscate\`.`
      : `${user} (\`${user.id}\`) was not on the access list.`,
  );
}

async function runAccessChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await guardOwner(interaction))) {
    return;
  }
  if (!interaction.inGuild()) {
    await replyPrivate(
      interaction,
      "Servers only",
      "`/access-channel` opens a server channel. Use `/give-access` to allow someone in DMs.",
    );
    return;
  }
  const channel = interaction.options.getChannel("channel", true);
  const { changed } = grantChannel(channel.id);
  await replyPrivate(
    interaction,
    changed ? "Channel opened" : "Already open",
    `Everyone in ${channel} can now run \`/obfuscate\` in that channel.` + (changed ? "" : " Nothing changed."),
  );
}

async function runRemoveChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await guardOwner(interaction))) {
    return;
  }
  if (!interaction.inGuild()) {
    await replyPrivate(interaction, "Servers only", "`/remove-channel` closes a server channel.");
    return;
  }
  const channel = interaction.options.getChannel("channel", true);
  const { changed } = revokeChannel(channel.id);
  await replyPrivate(
    interaction,
    changed ? "Channel closed" : "Was not open",
    changed
      ? `${channel} is closed again — only the owner and granted users can run \`/obfuscate\` there now.`
      : `${channel} was not on the open-channel list.`,
  );
}

async function runAccessList(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await guardOwner(interaction))) {
    return;
  }
  const state = readAccess();
  const users = await Promise.all(state.users.map((id) => labelUser(interaction, id)));
  const channels = await Promise.all(state.channels.map((id) => labelChannel(interaction, id)));

  const embed = banner()
    .setTitle("ReVeil access")
    .setDescription(`Owner: \`${ownerId()}\``)
    .addFields(
      {
        name: `Users with /obfuscate (${users.length})`,
        value: users.length > 0 ? users.join("\n").slice(0, 1024) : "_nobody_",
      },
      {
        name: `Open channels (${channels.length})`,
        value: channels.length > 0 ? channels.join("\n").slice(0, 1024) : "_none_",
      },
      {
        name: "Commands",
        value:
          "`/give-access` and `/take-access` per user, `/access-channel` and " +
          "`/remove-channel` per channel. Everyone else is denied.",
      },
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export function createClient(): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (ready) => {
    console.log(`ReVeil bot v${REVEIL_VERSION} online as ${ready.user.tag}`);
    console.log(`owner: ${ownerId()} — access store: ${accessFilePath()}`);
    ready.user.setActivity(`/obfuscate • private`, { type: 3 });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    switch (interaction.commandName) {
      case obfuscateCommand.name:
        void runObfuscate(interaction);
        return;
      case presetsCommand.name:
        void runPresets(interaction);
        return;
      case giveAccessCommand.name:
        void runGiveAccess(interaction);
        return;
      case takeAccessCommand.name:
        void runTakeAccess(interaction);
        return;
      case accessChannelCommand.name:
        void runAccessChannel(interaction);
        return;
      case removeChannelCommand.name:
        void runRemoveChannel(interaction);
        return;
      case accessListCommand.name:
        void runAccessList(interaction);
        return;
      default:
        void interaction.reply({
          content: `Unknown command \`${interaction.commandName}\`.`,
          flags: MessageFlags.Ephemeral,
        });
    }
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
