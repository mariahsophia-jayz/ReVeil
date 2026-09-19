local record = {alpha = 1, beta = 2, gamma = 3}
local keys = {}
for key, value in pairs(record) do
  keys[#keys + 1] = key .. "=" .. value
end
table.sort(keys)
print(table.concat(keys, ","))

local array = {"a", "b", "c"}
for index, value in ipairs(array) do
  print(index, value)
end

local function range(count)
  local index = 0
  return function()
    index = index + 1
    if index <= count then return index, index * index end
  end
end
for index, square in range(4) do
  print("range", index, square)
end

local iterator = next
local firstKey, firstValue = iterator(record)
print("next", firstKey ~= nil, firstValue ~= nil)

for key in pairs({x = 1, y = 2}) do
  if key == "x" then
    print("key", key)
  end
end
