local total = 0
for i = 1, 10 do
  if i % 2 == 0 then
    total = total + i
  end
end
print("even-sum", total)

local n = 0
local whileTotal = 0
while n < 5 do
  n = n + 1
  if n ~= 3 then
    whileTotal = whileTotal + n
  end
end
print("while", n, whileTotal)

repeat
  n = n - 1
until n == 0
print("repeat", n)

local countdown = ""
for i = 5, 1, -1 do
  countdown = countdown .. i
end
print("countdown", countdown)

local sum = 0
for index = 1, 20 do
  if index % 3 ~= 0 then
    if index > 15 then break end
    sum = sum + index
  end
end
print("skip", sum)
