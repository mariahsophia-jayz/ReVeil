local Account = {}
Account.__index = Account

function Account.new(owner, balance)
  return setmetatable({owner = owner, balance = balance}, Account)
end

function Account:deposit(amount)
  self.balance = self.balance + amount
  return self
end

function Account:describe()
  return string.format("%s has %d coins", self.owner, self.balance)
end

local account = Account.new("reveil", 10)
account:deposit(5):deposit(7)
print(account:describe())
print(getmetatable(account) == Account, rawget(account, "balance"))

local list = {5, 3, 9, 1}
table.sort(list, function(left, right) return left > right end)
print(table.concat(list, " "))
print(table.unpack and table.unpack(list) or unpack(list))

local proxy = setmetatable({}, {
  __index = function(_, key) return "default:" .. key end,
  __newindex = function(table, key, value) rawset(table, key, value .. "!") end,
  __call = function(_, arg) return "called:" .. arg end,
  __len = function() return 42 end,
})
print(proxy.missing, proxy("hi"), #proxy)
proxy.set = "value"
print(proxy.set)
