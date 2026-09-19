local ok, err = pcall(function() error("boom") end)
print("pcall", ok, tostring(err):match("boom") ~= nil)

local ok2, value = pcall(function() return 5 * 5 end)
print("pcall2", ok2, value)

local function risky(input)
  assert(type(input) == "number", "number expected")
  return input * 2
end
print(pcall(risky, 21), pcall(risky, "nope"))

local wrapped = function(...)
  local results = table.pack(...)
  return results.n
end
print("pack", wrapped(1, nil, 3))

local coroutineLib = coroutine
if coroutineLib then
  local co = coroutineLib.create(function(a)
    local b = coroutineLib.yield(a + 1)
    return b * 2
  end)
  print("co", coroutineLib.resume(co, 1))
  print("co", coroutineLib.resume(co, 5))
  print("co", coroutineLib.status(co))
end
