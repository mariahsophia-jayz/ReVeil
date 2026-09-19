<div align="center">

<img width="100%" src="https://capsule-render.vercel.app/api?type=waving&height=180&color=gradient&text=ReVeil&fontAlign=50&fontAlignY=35&fontSize=42&desc=Lua%20Obfuscation%20Engine%20%E2%80%A2%20Self-decoding%20VM%20%E2%80%A2%20CLI%20%2B%20Discord%20Bot&descAlign=50&descAlignY=60" />

</div>

<p align="center">
<b>ReVeil is a Lua/Luau obfuscation engine. Source is lowered to ReVeil bytecode and shipped with a self-decoding VM that decrypts, verifies and interprets the payload at runtime.</b>
</p>

---

## ⚙️ Features

- Full Lua/Luau front end: lexer → parser → scope resolver → bytecode compiler
- Self-decoding VM: the payload is encrypted, chunked and reassembled at runtime
- Identifier renaming, encrypted string vault, encoded numeric constants
- Dead-code injection, opaque predicates, control-flow flattening, expression fracturing
- Decoy protos, payload integrity checks and anti-tamper guards
- Four presets plus per-transform toggles; a seed reproduces a build byte for byte
- `reveil` CLI and a Lua-only Discord bot whose `/obfuscate` defaults to `extreme`
- Lua 5.1–5.4 / LuaJIT / Luau in, portable Lua out

---

## 🚀 Quick start

```bash
git clone https://github.com/mariahsophia-jayz/ReVeil.git
cd ReVeil
npm install
npm run build

node dist/cli.js examples/source.lua            # -> examples/source.reveil.lua
node dist/cli.js game.lua -p heavy -o build/game.lua
```

## 🖥️ CLI

```
reveil [options] <input.lua|input.luau> [more inputs...]
reveil [options] --stdin
```

| Flag | Meaning |
| --- | --- |
| `-o, --output <file>` | write to `<file>` (single input only) |
| `--stdout` | write the payload to stdout, status to stderr |
| `--stdin` | read the source from stdin |
| `-p, --preset <name>` | `light` \| `medium` \| `heavy` \| `extreme` (default `extreme`) |
| `-s, --seed <value>` | number or text; the same seed reproduces the output |
| `-t, --target <dialect>` | `5.1`–`5.4`, `luajit`, `luau`, `universal` |
| `-w, --watermark <text>` | extra text in the banner comment |
| `--set <toggle>=<on\|off>` | override one transform on top of the preset |
| `--max-bytes <n>` | fail instead of writing files larger than `n` bytes |
| `--stats` | print transform statistics |
| `--presets` | list the presets |

Without `--output` the result lands next to the input as `<name>.reveil.lua`.

## 🎚️ Presets

| Preset | What it enables |
| --- | --- |
| `light` | renamed identifiers, encrypted strings, minified — fastest at runtime |
| `medium` | light + encoded numbers and dead-code injection |
| `heavy` | medium + control-flow flattening and the bytecode VM |
| `extreme` | everything: VM, decoys, integrity checks, anti-tamper — **the default** |

`extreme` is the default everywhere: `reveil` with no `--preset`, and `/obfuscate`
with no `preset` option.

## 🤖 Discord bot

The bot is **Lua-only**: it accepts `.lua` / `.luau` attachments or inline source
and nothing else. It asks for no privileged intents — only `Guilds` — and replies
with an ephemeral attachment unless `share: true` is passed.

```bash
export DISCORD_TOKEN=...            # bot token
export DISCORD_CLIENT_ID=...        # application id

npm run bot:deploy -- --guild 123456789012345678   # register the commands (instant)
npm run bot                                        # start the gateway client
```

`/obfuscate` options:

| Option | Type | Notes |
| --- | --- | --- |
| `file` | attachment | a `.lua` / `.luau` file |
| `code` | string | inline source, up to 6000 characters |
| `preset` | choice | `light` / `medium` / `heavy` / `extreme` — defaults to **extreme** |
| `seed` | string | number or text; the same seed reproduces the output |
| `target` | choice | Lua dialect, defaults to `universal` |
| `share` | boolean | post the result publicly instead of ephemerally |

`/presets` lists the four presets and what each one enables.

## 📥 Example

### Input — `examples/source.lua`

```lua
local Inventory = {}
Inventory.__index = Inventory

function Inventory.new(owner, capacity)
  return setmetatable({ owner = owner, capacity = capacity, items = {} }, Inventory)
end

function Inventory:add(name, amount)
  local used = 0
  for _ in pairs(self.items) do
    used = used + 1
  end
  if used >= self.capacity then
    return false, "inventory full"
  end
  self.items[name] = (self.items[name] or 0) + amount
  return true
end

function Inventory:total()
  local sum = 0
  for _, amount in pairs(self.items) do
    sum = sum + amount
  end
  return sum
end

local function fib(n)
  if n < 2 then
    return n
  end
  return fib(n - 1) + fib(n - 2)
end

local bag = Inventory.new("mara", 4)
print(bag:add("rope", 1), bag:add("torch", 2), bag:add("coins", 30))
print(bag.owner, bag:total(), fib(12))
```

### Output — `example.lua` (first bytes of 17 KB)

```lua
--[[
  ReVeil v2 • 2026-09-19 • preset: extreme
  Reverse engineering is a breach of the license.
]]
return (function(...)
local dL = _ENV or (getfenv and getfenv(1)) or _G
local LfI = select
local lRd = table.concat
local y = string.byte
local _N = string.char
local P = string.sub
local K = string.find
local L = math.floor
local c = type
local XQO = rawget
local zt = dL.math or math
local p = table.unpack or unpack
local function Viv(...)
  return {n = LfI("#", ...), ...}
end
local h
local W9
local function RM(a,
-- remaining output omitted
```

Regenerate it any time:

```bash
node dist/cli.js examples/source.lua -o example.lua --seed 1 --quiet
```

## 🧠 How it works

1. **Parse** — the Lua/Luau source becomes an AST (`src/lua/lexer.ts`, `parser.ts`).
2. **Resolve** — scopes, upvalues and call targets are resolved; locals are renamed (`resolve.ts`).
3. **Compile** — the AST is lowered to ReVeil bytecode protos (`compiler.ts`, `bytecode.ts`).
4. **Harden** — strings, numbers and control flow are rewritten per preset (`transforms.ts`).
5. **Emit** — the payload is encrypted and wrapped in the self-decoding VM (`cipher.ts`, `runtime.ts`).

The CLI (`src/cli.ts`) and the bot (`src/bot/`) are both thin adapters over the
same `obfuscate()` entry point in `src/engine.ts`.

## 🧪 Tests

```bash
npm test
```

Runs the payload serialiser round-trip, the Lua corpora (every case in
`tests/lua/cases` executed as plain Lua and through the VM for every preset and
seed), the CLI end-to-end suite and the Discord bot suite — both of which execute
the payloads they produce in a sandboxed Lua 5.4 interpreter.

```bash
npm run bench    # benchmarks/, verified against a local `lua` when available
```

## 📜 License

[GPL-3.0](LICENSE)

<div align="center"> <img width="100%" src="https://capsule-render.vercel.app/api?type=waving&height=120&section=footer&color=gradient" /> </div>
