--[[
  Source for ../example.lua — regenerate it with:

    node dist/cli.js examples/source.lua -o example.lua --seed 1 --quiet

  (the `extreme` preset is the default, the same one `/obfuscate` uses)
]]

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
