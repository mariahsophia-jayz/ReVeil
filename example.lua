--[[
  ReVeil v2 • 2026-09-19 • preset: extreme
  Reverse engineering is a breach of the license.
]]
return (function(...)
local dL = _ENV or (getfenv and getfenv(1)) or _G
local LfI = select
local lRd = table.concat
local y = string.byte
local _N = string.char
local P = string.sub
local K = string.find
local L = math.floor
local c = type
local XQO = rawget
local zt = dL.math or math
local p = table.unpack or unpack
local function Viv(...)
  return {n = LfI("#", ...), ...}
end
local h
local W9
local function RM(a, b)
  local aHigh = L(a / 65536) % 65536
  local aLow = a % 65536
  local bHigh = L(b / 65536) % 65536
  local bLow = b % 65536
  return (((aHigh * bLow + aLow * bHigh) % 65536) * 65536 + aLow * bLow) % 4294967296
end
local EiB = {}
do
  local alphabet = "ABCDEFGHIJK" .. "LMNOPQRSTUV" .. "WXYZabcdefg" .. "hijklmnopqr" .. "stuvwxyz012" .. "3456789+/"
  for index = 1, #alphabet do
    EiB[P(alphabet, index, index)] = index - 1
  end
end
local function WP(text)
  local out = {}
  local accumulator = 0
  local bitsIn = 0
  for index = 1, #text do
    local value = EiB[P(text, index, index)]
    if value then
      accumulator = accumulator * 64 + value
      bitsIn = bitsIn + 6
      if bitsIn >= 8 then
        bitsIn = bitsIn - 8
        out[#out + 1] = _N(L(accumulator / 2 ^ bitsIn) % 256)
        accumulator = accumulator % 2 ^ bitsIn
      end
    end
  end
  return lRd(out)
end
local function Z(data)
  local out = {}
  local dict, nextCode, previous
  local function reset()
    dict = {}
    for index = 0, 255 do
      dict[index] = _N(index)
    end
    nextCode = 258
    previous = nil
  end
  reset()
  for index = 1, #data - 1, 2 do
    local code = y(data, index) * 256 + y(data, index + 1)
    if code == 256 then
      reset()
    elseif code == 257 then
      break
    else
      local entry
      if code < nextCode and dict[code] then
        entry = dict[code]
      elseif previous then
        entry = previous .. P(previous, 1, 1)
      else
        error("invalid instruction")
      end
      out[#out + 1] = entry
      if previous and nextCode <= 4095 then
        dict[nextCode] = previous .. P(entry, 1, 1)
        nextCode = nextCode + 1
      end
      previous = entry
    end
  end
  return lRd(out)
end
local function Zz(data, seed, phase, salt)
  local state = (RM(seed, 40503) + 2654435761) % 4294967296
  for index = 1, #salt do
    state = (RM(state, 31) + y(salt, index)) % 4294967296
  end
  state = (state + phase * 2246822519) % 4294967296
  if state == 0 then
    state = 2463534242
  end
  local key = state
  local out = {}
  for index = 1, #data do
    key = (RM(key, 1664525) + 1013904223) % 4294967296
    local folded = (L(key / 65536) + key % 65536) % 256
    local mask = (folded + (index * 29) % 256 + phase) % 256
    out[index] = _N((y(data, index) - mask) % 256)
  end
  return lRd(out)
end
local function hao(value)
  local hash = 2166136261
  for index = 1, #value do
    hash = (hash + y(value, index) + (index * 97) % 65521) % 4294967296
    hash = (RM(hash, 16777619) + 2654435769) % 4294967296
  end
  return hash % 4294967296
end
local function C(text)
  local position = 1
  local function readNumber()
    local stop = K(text, ";", position, true)
    local body = P(text, position, stop - 1)
    position = stop + 1
    if body == "#I" then return zt.huge end
    if body == "#J" then return -zt.huge end
    if body == "#K" then return 0 / 0 end
    return tonumber(body) or 0
  end
  local function readString()
    local stop = K(text, ":", position, true)
    local length = tonumber(P(text, position, stop - 1)) or 0
    local value = P(text, stop + 1, stop + length)
    position = stop + length + 1
    return value
  end
  local readValue
  readValue = function()
    local tag = P(text, position, position)
    position = position + 1
    if tag == "S" then
      return readString()
    elseif tag == "N" then
      return readNumber()
    elseif tag == "A" then
      local stop = K(text, "[", position, true)
      local count = tonumber(P(text, position, stop - 1)) or 0
      position = stop + 1
      local array = {}
      for index = 1, count do
        array[index] = readValue()
      end
      position = position + 1
      return array
    elseif tag == "T" then
      return true
    elseif tag == "F" then
      return false
    end
    return nil
  end
  return readValue()
end
local _Se = {("drjeTcve+cNU0VuOC9eOTLoMAbY2KHR4WZOjWBsntQaW7fW/HudSGk712V4bs2ka9v01waK4NjKNdv4BsM/+b7P5Pkfr7QKD" .. "gSMWpX87qm+5RqAFHUhjnJSbJjkbobeu6objAVteKToiFTK9PqZiaig0e9HJ3xY5jcw7T4Lq+GtdrvXQiojqKT"), ("FbC+zprFfpr/P7nkwfwMs8KhDQrl5oNZAC8mO5OyZ03KNA1K1I6m/m/LjEVgy9ifywH50PJ6RdB5dXcMOIxqt4Iyam7B9Qslt9qb6eVIpfOg/cgG+" .. "Ju0o+u93UjjZKJB+ez0C2haM0HU7qHjbdV9YP0YHn6vbKQFvAznA9kcjJ+vJb2zreBPhUEJR0Vwke/amNA9ykUPDqddY+8PTJbBAFheyzdW57+hzO" .. "y2H8OhTVC2KhY8FmXmu9yFMf4C9QRYvVo26q2UEYm924DEzqca9tKnT"), ("uZa0IYzF/CMoHMaOtpgWeAe6YcOrxtV2cgiwzT+90o4WV20L0F/KwO"), ("7YR/qFxb89Z07X9MPKbByRalpt9JXx0CaZmqKO12ND/kB6mnhL3+iJZdZ3JfCOsNJ5pAWopL1kb2L7rJ+PtNl8sevyL+LYjr" .. "jplV4bP5jZYNpDk64pdidOwyyDxr/8ZN4AsE7K4NYLDb4+tr+pqd1ihEXZK2I+2+uuU2kqNmPFREj6XW7/8di17+kCKsDle/" .. "ff1U84cTapXqyK0exk+9XMut6rNxJOWsCGuGGP22eIOtUVqwEgfM7JEfqnMPXskZoue8VELg2AW5rKufubUx1RsB0JoRY3Y1" .. "diux4SK1RzxHf5ILntSASeREkolBLDgl8JDNw0XH1uGi7vP7GbWLt2B3Mqtvor5qyTQ56C69uWeWgX3+"), ("LJfCI0dr6hK4QQv8ahAtBWjsjVopvgjNkkxWTEfUdFwCdCqs1uNM+pA6qb1zzVNr0VRpCnQkQswCuMWGvwwW78XAP+/qWJLEWUNrrSzwMjCy/Hfsh" .. "ejBNUtl3AesqmMKcpz9ny6NAQHo/Zg8rbrxpgBF8fQKTb5bvbYgQcDx536UbFhrLYM2xRPLMN4Brxud1dQqEjjUxNCzih3nTaPo3gERb0cCvALgVg" .. "6qhBkPIaoBiDD4xUAFJrSE12okgp/7NuzopQW6WGX5KW2gA90BnIXEBRpk0hQvWUg2e+7QNGfLoYJ2qr/AZui9wyPzGqTHNKorp8XLp30BtjiOik5" .. "c9UGRkW0xzng1pe1cgnHKJHxSnCuUXzADIcSwYNRzfyT2uV4ne8Eo"), ("beRh2y8sfW1mDmZ8KNGbQBRvhhkTf9hlKr17qdNUWc+0hVenzhTjBiqOWywokUg+2Xek0j6B6QF72wTXA+g2BgIpvXW2rbqWmk6xzg8GGq4sTSx+Rg3IluhiRIbo6fBOM6" .. "R/KBjoqWFBoTaEX6EsTz1Bov7TVDSmz6UR235K2SkIRpQe7/cMp7gYjXB2FRLknCZK9bOH23NUNUG3Zz2JGaLjMz5kDFRr54XP9JET"), ("Qt5dWtTd4oGQsG8PonNcplJ+m/EWp2Acy4oCJjsXIRnkgAoa+q1YtKr73RSjnMJL0JzsyGkUna8p9GSb4iswNi/jvlaJ6EDu" .. "gAk2RkAlm8BbvEX2yMiQoiblMkpIg3PN61yB18qtH1bXWH4zwJBsmbtUtEx9Lrxuimp3HLWZdTbgGVzEBoF8rHm+v/Rsh8Bl" .. "tg09dM/xrjM")}
local J = {7, 1, 4, 5, 6, 2, 3}
local j = {}
for index = 1, #J do
  j[index] = _Se[J[index]]
end
local ktw = (RM(2464172820, 31) + RM(2560314286, 40503) + 2495889971) % 4294967296
local IRk = (254 + 83) % 256
local Pt = "j-K*C" .. "fZ*z7" .. "&2E"
local X = WP(lRd(j))
local qF = Z(Zz(X, ktw, IRk, Pt))
if hao(qF) ~= 3869126224 then error("invalid instruction") end
local s7 = C(qF)
local dvu = s7[1]
local zul = s7[2]
local q = s7[3]
local t1J = s7[4]
if c(lRd) ~= "function" or c(_N) ~= "function" or c(L) ~= "function" then
  error("invalid instruction")
end
if _N(65) ~= "A" or P("abc", 2, 3) ~= "bc" or lRd({_N(82), _N(86)}) ~= "RV" then
  error("invalid instruction")
end
local rDx = function(value) local out = {} for index = 1, #value do out[index] = _N((y(value, index) + index) % 256) end return lRd(out) end
local lDm = function(value) return c(value) == "table" and #value or 0 end
local U
local function O(protoIndex, upvalues)
  return function(...)
    return U(dvu, protoIndex, upvalues, ...)
  end
end
U = function(F, T43, l5, ...)
  local Ey = F[T43][4]
  local params = F[T43][1]
  local args = Viv(...)
  local Zwc = {}
  local e2 = params
  for index = 1, params do
    Zwc[index] = args[index]
  end
  local Gg = {n = args.n - params}
  for index = 1, Gg.n do
    Gg[index] = args[index + params]
  end
  local J9 = 1
  local d
  while true do
    d = Ey[J9]
    J9 = J9 + 1
    if d == 51 then
      e2 = e2 + 1
      Zwc[e2] = Zwc[Ey[J9]]
      J9 = J9 + 1
    elseif d == 162 then
      e2 = e2 + 1
      Zwc[e2] = zul[Ey[J9]]
      J9 = J9 + 1
    elseif d == 46 then
      e2 = e2 + 1
      Zwc[e2] = Ey[J9]
      J9 = J9 + 1
    elseif d == 29 then
      local base = Ey[J9]
      local wanted = Ey[J9 + 1]
      J9 = J9 + 2
      if wanted == 0 then
        Zwc[base](p(Zwc, base + 1, e2))
        for index = base, e2 do Zwc[index] = nil end
        e2 = base - 1
      elseif wanted == 1 then
        Zwc[base] = Zwc[base](p(Zwc, base + 1, e2))
        for index = base + 1, e2 do Zwc[index] = nil end
        e2 = base
      else
        local results = Viv(Zwc[base](p(Zwc, base + 1, e2)))
        if wanted < 0 then wanted = results.n end
        for index = 1, wanted do Zwc[base + index - 1] = results[index] end
        for index = base + wanted, e2 do Zwc[index] = nil end
        e2 = base + wanted - 1
      end
    elseif d == 17 then
      Zwc[e2] = Zwc[e2][zul[Ey[J9]]]
      J9 = J9 + 1
    elseif d == 248 then
      local key = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2][key]
    elseif d == 88 then
      local value = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2][zul[Ey[J9]]] = value
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
    elseif d == 176 then
      local value = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      local key = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2][key] = value
      Zwc[e2] = nil
      e2 = e2 - 1
    elseif d == 239 then
      Zwc[Ey[J9]] = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
    elseif d == 193 then
      e2 = e2 + 1
      Zwc[e2] = dL[zul[Ey[J9]]]
      J9 = J9 + 1
    elseif d == 190 then
      dL[zul[Ey[J9]]] = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
    elseif d == 78 then
      local offset = Ey[J9]
      J9 = J9 + 1 + offset
    elseif d == 92 then
      local condition = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
      if not condition then J9 = J9 + Ey[J9 - 1] end
    elseif d == 129 then
      local condition = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
      if condition then J9 = J9 + Ey[J9 - 1] end
    elseif d == 252 then
      local base = Ey[J9]
      local mode = Ey[J9 + 1]
      if base == 0 then return end
      if mode < 0 then return p(Zwc, base, e2) end
      if mode == 0 then return end
      return p(Zwc, base, base + mode - 1)
    elseif d == 41 then
      e2 = e2 + 1
      Zwc[e2] = {}
    elseif d == 36 then
      local descriptor = dvu[Ey[J9]][3]
      local captured = {}
      for index = 1, #descriptor do
        local slot = descriptor[index]
        if slot > 0 then captured[index] = Zwc[slot] else captured[index] = l5[-slot] end
      end
      e2 = e2 + 1
      Zwc[e2] = O(Ey[J9], captured)
      J9 = J9 + 1
    elseif d == 24 then
      local right = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] <= right
    elseif d == 216 then
      local loopVar = Ey[J9]
      local control = Ey[J9 + 1]
      local step = Zwc[control + 2]
      local nextValue = Zwc[control] + step
      local limit = Zwc[control + 1]
      Zwc[control] = nextValue
      J9 = J9 + 5
      if (step > 0 and nextValue <= limit) or (step < 0 and nextValue >= limit) then
        Zwc[loopVar] = nextValue
        J9 = J9 + Ey[J9 - 1]
      end
    elseif d == 139 then
      J9 = J9 + 1
      if not Zwc[e2] then J9 = J9 + Ey[J9 - 1] end
    elseif d == 28 then
      local right = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] ~= right
    elseif d == 148 then
      e2 = e2 + 1
      Zwc[e2] = Zwc[e2 - 1]
    elseif d == 140 then
      e2 = e2 + 1
      Zwc[e2] = Ey[J9] == 1
      J9 = J9 + 1
    elseif d == 149 then
      e2 = e2 + 1
      Zwc[e2] = dL
    elseif d == 47 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] + right
    elseif d == 207 then
      Zwc[Ey[J9]][1] = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
    elseif d == 39 then
      do
        local target = Zwc[Ey[J9]]
        local base = Ey[J9]
        local offset = Ey[J9 + 1] - 1
        local count = e2 - base
        for index = base + 1, e2 do
          target[offset + index - base] = Zwc[index]
          Zwc[index] = nil
        end
        Zwc[Ey[J9]] = target
        e2 = base
        J9 = J9 + 2
      end
    elseif d == 147 then
      local value = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      local key = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[Ey[J9]][key] = value
      J9 = J9 + 1
    elseif d == 212 then
      local base = Ey[J9]
      local mode = Ey[J9 + 1]
      if mode < 0 then
        for index = 1, Gg.n do Zwc[base + index - 1] = Gg[index] end
        e2 = base + Gg.n - 1
      else
        for index = 1, mode do Zwc[base + index - 1] = Gg[index] end
        e2 = base + mode - 1
      end
      J9 = J9 + 2
    elseif d == 143 then
      Zwc[Ey[J9]] = {}
      J9 = J9 + 1
    elseif d == 73 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = h.rshift(Zwc[e2], right)
    elseif d == 57 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] / right
    elseif d == 203 then
      e2 = Ey[J9]
      J9 = J9 + 1
    elseif d == 171 then
      local object = Zwc[e2]
      Zwc[e2] = object[zul[Ey[J9]]]
      e2 = e2 + 1
      Zwc[e2] = object
      J9 = J9 + 1
    elseif d == 228 then
      Zwc[e2] = not Zwc[e2]
    elseif d == 66 then
      Zwc[e2] = #Zwc[e2]
    elseif d == 215 then
      e2 = e2 + 1
      Zwc[e2] = q[Ey[J9]]
      J9 = J9 + 1
    elseif d == 16 then
      local right = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] > right
    elseif d == 84 then
      local right = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] == right
    elseif d == 206 then
      J9 = J9 + 1
      if Zwc[e2] then J9 = J9 + Ey[J9 - 1] end
    elseif d == 115 then
      e2 = e2 + 1
      Zwc[e2] = RA(Ey[J9])
      J9 = J9 + 1
    elseif d == 195 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] ^ right
    elseif d == 77 then
      local slot = Ey[J9]
      local target = Ey[J9 + 1]
      local boxed = Ey[J9 + 2] == 1
      local descriptor = dvu[target][3]
      local captured = {}
      for index = 1, #descriptor do
        local reference = descriptor[index]
        if reference > 0 then captured[index] = Zwc[reference] else captured[index] = l5[-reference] end
      end
      local closure = O(target, captured)
      if boxed then Zwc[slot][1] = closure else Zwc[slot] = closure end
      J9 = J9 + 3
    elseif d == 27 then
      local value = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[Ey[J9]][zul[Ey[J9 + 1]]] = value
      J9 = J9 + 2
    elseif d == 5 then
      local right = Zwc[e2]
      e2 = e2 - 1
      if not W9 then
        local loader = rawget(dL, "loadstring") or rawget(dL, "load")
        local ok, chunk = pcall(loader, "return function(a, b) return a // b end")
        local helper
        if ok and type(chunk) == "function" then
          local built, compiled = pcall(chunk)
          if built and type(compiled) == "function" then helper = compiled end
        end
        W9 = helper or function(a, b) return L(a / b) end
      end
      Zwc[e2] = W9(Zwc[e2], right)
    elseif d == 224 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] * right
    elseif d == 187 then
      local loopVar = Ey[J9]
      local control = Ey[J9 + 1]
      local init = tonumber(Zwc[control])
      local limit = tonumber(Zwc[control + 1])
      local step = tonumber(Zwc[control + 2])
      if init == nil then error("'for' initial value must be a number", 0) end
      if limit == nil then error("'for' limit must be a number", 0) end
      if step == nil then error("'for' step must be a number", 0) end
      if step == 0 then error("'for' step is zero", 0) end
      Zwc[control] = init - step
      Zwc[control + 1] = limit
      Zwc[control + 2] = step
      J9 = J9 + 5
      J9 = J9 + Ey[J9 - 1]
    elseif d == 87 then
      Zwc[e2] = -Zwc[e2]
    elseif d == 132 then
      local base = Ey[J9]
      local vars = Ey[J9 + 1]
      local count = Ey[J9 + 2]
      local results = Viv(Zwc[base](Zwc[base + 1], Zwc[base + 2]))
      Zwc[base + 2] = results[1]
      for index = 1, count do Zwc[vars + index - 1] = results[index] end
      J9 = J9 + 4
      if results[1] == nil then
        J9 = J9 + Ey[J9 - 1]
      end
    elseif d == 234 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = h.band(Zwc[e2], right)
    elseif d == 217 then
      local right = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] < right
    elseif d == 150 then
      Zwc[Ey[J9]][Ey[J9 + 1]] = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 2
    elseif d == 121 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] .. right
    elseif d == 110 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = h.lshift(Zwc[e2], right)
    elseif d == 166 then
      local cellValue = Zwc[Ey[J9 + 1]]
      Zwc[Ey[J9]] = {cellValue}
      J9 = J9 + 2
    elseif d == 64 then
      e2 = e2 + 1
      Zwc[e2] = l5[Ey[J9]][1]
      J9 = J9 + 1
    elseif d == 160 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] - right
    elseif d == 255 then
      e2 = e2 + 1
      Zwc[e2] = Zwc[Ey[J9]][1]
      J9 = J9 + 1
    elseif d == 79 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = h.bor(Zwc[e2], right)
    elseif d == 208 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] % right
    elseif d == 26 then
      Zwc[e2] = h.bnot(Zwc[e2])
    elseif d == 99 then
      e2 = e2 + 1
      Zwc[e2] = nil
    elseif d == 235 then
      local right = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      Zwc[e2] = Zwc[e2] >= right
    elseif d == 108 then
      local right = Zwc[e2]
      e2 = e2 - 1
      Zwc[e2] = h.bxor(Zwc[e2], right)
    elseif d == 145 then
      Zwc[e2] = nil
      e2 = e2 - 1
    elseif d == 4 then
      l5[Ey[J9]][1] = Zwc[e2]
      Zwc[e2] = nil
      e2 = e2 - 1
      J9 = J9 + 1
    else
      error("invalid instruction")
    end
  end
end
local Qu = O(t1J, {})
return Qu(...)
end)(...)