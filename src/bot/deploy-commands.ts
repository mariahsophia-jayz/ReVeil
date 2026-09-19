#!/usr/bin/env node
/**
 * Registers the ReVeil slash commands.
 *
 *   npm run bot:deploy                     # global commands (up to an hour to appear)
 *   npm run bot:deploy -- --guild 123456   # one server, instant
 *   npm run bot:deploy -- --dry-run        # print the payload, touch nothing
 *
 * Environment: DISCORD_TOKEN, DISCORD_CLIENT_ID, optional DISCORD_GUILD_ID.
 */

import { REST, Routes } from "discord.js";

import { COMMAND_JSON } from "./commands";
import { REVEIL_VERSION } from "../index";

interface DeployOptions {
  guildId?: string;
  dryRun: boolean;
}

export function parseDeployArgs(argv: string[]): DeployOptions {
  const options: DeployOptions = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--guild") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--guild expects a server id");
      }
      options.guildId = value;
      index += 1;
    } else {
      throw new Error(`unknown option "${arg}" (expected --guild <id> or --dry-run)`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let options: DeployOptions;
  try {
    options = parseDeployArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`reveil-bot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  if (options.dryRun) {
    console.log(JSON.stringify(COMMAND_JSON, null, 2));
    return;
  }

  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID must both be set.");
    process.exitCode = 1;
    return;
  }

  const guildId = options.guildId ?? process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(route, { body: COMMAND_JSON });
  console.log(
    `ReVeil v${REVEIL_VERSION}: registered ${COMMAND_JSON.length} command(s) ` +
      `${guildId ? `in guild ${guildId}` : "globally"}`,
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`reveil-bot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
