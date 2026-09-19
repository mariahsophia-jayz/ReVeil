local function sum(...)
  local total = 0
  for index = 1, select("#", ...) do
    total = total + (select(index, ...) or 0)
  end
  return total
end
print(sum(1, 2, 3, 4, 5), sum(), sum(10))

local function forward(...)
  return sum(...)
end
print(forward(1, 2, 3))

local function collect(...)
  return {...}, select("#", ...)
end
local values, count = collect("a", "b", "c")
print(count, values[1], values[3], #values)

local function tail(...)
  return table.concat({...}, "-")
end
print(tail("x", "y", "z"))

local function multi()
  return 1, 2, 3
end
print(multi())
print((multi()))
local a, b, c, d = multi()
print(a, b, c, d)
