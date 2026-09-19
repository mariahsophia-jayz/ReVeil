/**
 * Owner-gated access control for the ReVeil bot.
 *
 * Out of the box the bot answers to nobody but the owner. The owner opens it up
 * two ways:
 *
 *   /give-access <user>       one account may run /obfuscate anywhere, DMs included
 *   /access-channel <channel> everyone in that channel may run /obfuscate there
 *
 * and closes it again with `/take-access` and `/remove-channel`.
 *
 * State lives in a small JSON file (`data/access.json` by default) so grants
 * survive a restart. Snowflakes are 19-digit integers, far past
 * `Number.MAX_SAFE_INTEGER`, so every id is a **string** end to end — nothing
 * here ever calls `Number()` on one.
 */

import * as fs from "fs";
import * as path from "path";

/** The account that owns the bot unless `REVEIL_OWNER_ID` overrides it. */
export const DEFAULT_OWNER_ID = "1380042914922758224";

const STATE_VERSION = 1;
const SNOWFLAKE = /^\d{15,25}$/;

export interface AccessState {
  version: number;
  /** Owner snowflake. */
  owner: string;
  /** Snowflakes allowed to run `/obfuscate` anywhere, DMs included. */
  users: string[];
  /** Channel snowflakes where everyone may run `/obfuscate`. */
  channels: string[];
}

export interface AccessContext {
  /** Who invoked the command. */
  userId: string;
  /** Where it was invoked, or `null` in a DM. */
  channelId: string | null;
  /** `false` in a DM. */
  inGuild: boolean;
}

export type AccessReason = "owner" | "user" | "channel" | "denied";

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  /** Human-readable explanation, safe to show to the invoker. */
  detail: string;
}

export interface AccessChange {
  /** `false` when the grant/revocation was already in place. */
  changed: boolean;
  state: AccessState;
}

export function accessFilePath(): string {
  return process.env.REVEIL_ACCESS_FILE || path.join(process.cwd(), "data", "access.json");
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

function defaultState(): AccessState {
  return { version: STATE_VERSION, owner: DEFAULT_OWNER_ID, users: [], channels: [] };
}

/** Keeps only well-formed ids so a hand-edited file cannot poison the bot. */
function normalizeId(value: unknown): string | null {
  if (isSnowflake(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

export function requireSnowflake(value: string, label: string): string {
  if (!isSnowflake(value)) {
    throw new Error(`${label} must be a Discord id (digits only), got "${value}"`);
  }
  return value;
}

export function readAccess(): AccessState {
  const file = accessFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No file yet: owner-only.
    return defaultState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file: fall back to owner-only rather than locking the owner out.
    return defaultState();
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  const state = defaultState();
  const owner = normalizeId(record.owner);
  if (owner) {
    state.owner = owner;
  }
  for (const key of ["users", "channels"] as const) {
    const list = record[key];
    if (Array.isArray(list)) {
      const ids = list.map(normalizeId).filter((id): id is string => id !== null);
      state[key] = [...new Set(ids)];
    }
  }
  return state;
}

export function writeAccess(state: AccessState): void {
  const file = accessFilePath();
  const directory = path.dirname(file);
  if (directory) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** `REVEIL_OWNER_ID` wins over the stored value, the stored value over the default. */
export function ownerId(): string {
  const fromEnv = (process.env.REVEIL_OWNER_ID ?? "").trim();
  if (isSnowflake(fromEnv)) {
    return fromEnv;
  }
  return readAccess().owner;
}

export function isOwner(userId: string): boolean {
  return typeof userId === "string" && userId === ownerId();
}

/** Owner-only commands (`/give-access`, `/take-access`, ...). */
export function canManageAccess(userId: string): boolean {
  return isOwner(userId);
}

export function grantUser(userId: string): AccessChange {
  requireSnowflake(userId, "user id");
  const state = readAccess();
  if (state.users.includes(userId)) {
    return { changed: false, state };
  }
  state.users.push(userId);
  writeAccess(state);
  return { changed: true, state };
}

export function revokeUser(userId: string): AccessChange {
  requireSnowflake(userId, "user id");
  const state = readAccess();
  const next = state.users.filter((id) => id !== userId);
  if (next.length === state.users.length) {
    return { changed: false, state };
  }
  state.users = next;
  writeAccess(state);
  return { changed: true, state };
}

export function grantChannel(channelId: string): AccessChange {
  requireSnowflake(channelId, "channel id");
  const state = readAccess();
  if (state.channels.includes(channelId)) {
    return { changed: false, state };
  }
  state.channels.push(channelId);
  writeAccess(state);
  return { changed: true, state };
}

export function revokeChannel(channelId: string): AccessChange {
  requireSnowflake(channelId, "channel id");
  const state = readAccess();
  const next = state.channels.filter((id) => id !== channelId);
  if (next.length === state.channels.length) {
    return { changed: false, state };
  }
  state.channels = next;
  writeAccess(state);
  return { changed: true, state };
}

/**
 * The single gate the gateway calls before `/obfuscate` and `/presets` run.
 * Precedence: owner, then per-user grant, then per-channel grant.
 */
export function authorizeObfuscate(context: AccessContext): AccessDecision {
  const state = readAccess();
  const { userId, channelId } = context;

  if (isOwner(userId)) {
    return { allowed: true, reason: "owner", detail: "you own this bot" };
  }
  if (state.users.includes(userId)) {
    return { allowed: true, reason: "user", detail: "granted with /give-access" };
  }
  if (channelId && state.channels.includes(channelId)) {
    return { allowed: true, reason: "channel", detail: "this channel is open" };
  }

  return {
    allowed: false,
    reason: "denied",
    detail: context.inGuild
      ? "This bot is private. Ask the owner to run `/give-access` for you, or `/access-channel` in this channel."
      : "This bot is private. Ask the owner to run `/give-access` for you.",
  };
}
