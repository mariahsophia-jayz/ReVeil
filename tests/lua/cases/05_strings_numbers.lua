local text = "ReVeil-Lua-Engine"
print(string.upper(text), string.lower(text), string.len(text))
print(string.sub(text, 1, 6), text:sub(-6))
print(string.find(text, "Lua"), string.gsub(text, "-", "_"))
print(string.rep("ab", 3), string.reverse("abc"))
print(string.format("%d|%.3f|%s|%x", 42, 3.14159, "text", 255))
print(("%5.2f"):format(2.5), ("%s=%s"):format("k", "v"))

local encoded = ""
for index = 1, 5 do
  encoded = encoded .. string.char(64 + index)
end
print(encoded, string.byte(encoded, 1), #encoded)

print(2^10, 10/4, 10//4, 10%4, math.floor(-2.5), math.max(3, 9, 2), math.min(3, 9, 2))
print(math.huge > 1e300, math.pi > 3.14 and math.pi < 3.15)
print(0x1F, 1e3, 0.5, 1000000000000)
