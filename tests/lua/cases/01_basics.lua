local a, b = 10, 3
print(a + b, a - b, a * b, a / b, a % b, a ^ 2)
print("concat: " .. a .. "-" .. b)
print(#"hello", -a, not false, 7 // 2)
local t = {1, 2, 3, "four", {nested = true}}
print(#t, t[1], t[4], t[5].nested)
t[5] = "five"
print(t[5], #t, table.concat(t, ","))
print(tostring(nil), tostring(true), tonumber("42") + 1)
