local function makeStack()
  local items = {}
  return {
    push = function(value) items[#items + 1] = value return #items end,
    pop = function() local value = items[#items] items[#items] = nil return value end,
    size = function() return #items end,
    each = function(fn) for index = 1, #items do fn(items[index], index) end end,
  }
end

local stack = makeStack()
stack.push("a")
stack.push("b")
print(stack.size(), stack.pop(), stack.size())
stack.push("c")
stack.each(function(value, index) print("item", index, value) end)

local counters = {}
for index = 1, 3 do
  counters[index] = function() return index end
end
print(counters[1](), counters[2](), counters[3]())

local shared = 0
local function bump() shared = shared + 1 return shared end
local function peek() return shared end
bump() bump()
print("shared", peek())

local outer = function(value)
  return function()
    return function()
      return value * 3
    end
  end
end
print("deep", outer(7)()())
