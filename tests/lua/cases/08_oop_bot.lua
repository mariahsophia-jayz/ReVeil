-- A mini discord-bot-shaped module: commands, hooks, dispatch, state.
local Bot = {}
Bot.__index = Bot

local function luaClass()
  return setmetatable({}, {__index = Bot})
end

function Bot.new(name)
  local self = luaClass()
  self.name = name
  self.commands = {}
  self.state = {handled = 0, log = {}}
  return self
end

function Bot:command(name, handler)
  self.commands[name] = handler
  return self
end

function Bot:dispatch(message)
  local command, argument = message:match("^(%S+)%s*(.*)$")
  local handler = self.commands[command]
  if not handler then
    table.insert(self.state.log, "unknown:" .. tostring(command))
    return "unknown command: " .. tostring(command)
  end
  self.state.handled = self.state.handled + 1
  table.insert(self.state.log, command)
  local ok, result = pcall(handler, self, argument, message)
  if not ok then
    return "error: " .. tostring(result)
  end
  return result
end

local bot = Bot.new("ReVeil")
bot:command("ping", function() return "pong" end)
bot:command("echo", function(_, argument) return argument end)
bot:command("count", function(self) return "handled=" .. self.state.handled end)
bot:command("boom", function() error("kaboom") end)

local messages = {"ping", "echo hello world", "count", "boom", "missing"}
for _, message in ipairs(messages) do
  print(message, "->", bot:dispatch(message))
end
print("#log", #bot.state.log, table.concat(bot.state.log, ","))
print("final", bot:dispatch("count"))
