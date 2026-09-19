local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end
print("fib", fib(12))

local function pack2(...)
  local count = select("#", ...)
  local first, second = ...
  return count, first, second
end
print(pack2("a", "b", "c"))

local function mapper(fn, ...)
  local out = {}
  for index = 1, select("#", ...) do
    out[index] = fn((select(index, ...)))
  end
  return table.concat(out, "|")
end
print(mapper(function(value) return value * 2 end, 1, 2, 3))

local function counter(start)
  local value = start
  return function(step)
    value = value + (step or 1)
    return value
  end
end
local tick = counter(100)
print(tick(), tick(5), tick())
