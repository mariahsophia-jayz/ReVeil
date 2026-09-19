/**
 * ReVeil Lua runtime emitter.
 *
 * Renders the self-decoding VM that every virtualised build ships with:
 *   scrambled base64 chunks → stream decryption → LZW → payload parser → VM.
 *
 * Every identifier, opcode, jump table entry and literal is randomised through
 * the per-build profile, so no two outputs share a token sequence.
 */

import { ReVeilError } from "../core/errors";
import type { PackedPayload } from "../core/cipher";
import type { EngineOptions } from "../core/types";
import { luaQuote } from "../core/util";
import type { OpName, Program } from "./bytecode";
import type { LuaProfile } from "./profile";

export interface RuntimeInput {
  profile: LuaProfile;
  payload: PackedPayload;
  options: EngineOptions;
  program: Program;
}

export function renderRuntime(input: RuntimeInput): string {
  const { profile, payload, options } = input;
  const n = (key: string): string => {
    const value = profile.names[key];
    if (!value) {
      throw new ReVeilError(`internal error: missing runtime name '${key}'`, "LUA_RUNTIME");
    }
    return value;
  };
  const op = (name: OpName): string => String(profile.opcodes[name]);

  const lines: string[] = [];
  const push = (...values: string[]): void => {
    for (const value of values) {
      lines.push(value);
    }
  };

  const ENV = n("ENV");
  const PACK = n("PACK");
  const UNPACK = n("UNPACK");
  const CONCAT = n("CONCAT");
  const BYTE = n("BYTE");
  const CHAR = n("CHAR");
  const SUB = n("SUB");
  const FIND = n("FIND");
  const FLOOR = n("FLOOR");
  const TYPE = n("TYPE");
  const SELECT = n("SELECT");
  const RUN = n("RUN");
  const MAKECL = n("MAKECL");
  const B64REV = n("B64REV");
  const B64DEC = n("B64DEC");
  const LZW = n("LZW");
  const UNMASK = n("UNMASK");
  const PARSE = n("PARSE");
  const CHECKSUM = n("CHECKSUM");
  const CHUNKS = n("CHUNKS");
  const ORDER = n("ORDER");
  const SEED = n("SEED");
  const PHASE = n("PHASE");
  const SALT = n("SALT");
  const PROGRAM = n("PROGRAM");
  const PROTOS = n("PROTOS");
  const STRINGS = n("STRINGS");
  const ENTRY = n("ENTRY");
  const PARTS = n("PARTS");
  const DATA = n("DATA");
  const PLAIN = n("PLAIN");
  const MAIN = n("MAIN");
  const P = n("P");
  const ST = n("ST");
  const TOP = n("TOP");
  const PC = n("PC");
  const VA = n("VA");
  const CODE = n("CODE");
  const UPS = n("UPS");
  const OP = n("OP");
  const MUL = `${n("STATE")}M`;
  const BITS = n("BITS");
  const IDIV = n("IDIV");
  const MATH = n("IDX");
  const RAWGET = n("RES");
  const PRESIZE = `${n("STATE")}A`;
  const PRESIZE_CACHE = `${n("STATE")}C`;

  // ------------------------------------------------------------------ header
  push(
    `local ${ENV} = _ENV or (getfenv and getfenv(1)) or _G`,
    `local ${SELECT} = select`,
    `local ${CONCAT} = table.concat`,
    `local ${BYTE} = string.byte`,
    `local ${CHAR} = string.char`,
    `local ${SUB} = string.sub`,
    `local ${FIND} = string.find`,
    `local ${FLOOR} = math.floor`,
    `local ${TYPE} = type`,
    `local ${RAWGET} = rawget`,
    `local ${MATH} = ${ENV}.math or math`,
    `local ${UNPACK} = table.unpack or unpack`,
    `local function ${PACK}(...)`,
    `  return {n = ${SELECT}("#", ...), ...}`,
    `end`,
    `local ${BITS}`,
    `local ${IDIV}`,
    `local function ${MUL}(a, b)`,
    `  local aHigh = ${FLOOR}(a / 65536) % 65536`,
    `  local aLow = a % 65536`,
    `  local bHigh = ${FLOOR}(b / 65536) % 65536`,
    `  local bLow = b % 65536`,
    `  return (((aHigh * bLow + aLow * bHigh) % 65536) * 65536 + aLow * bLow) % 4294967296`,
    `end`,
  );

  // ------------------------------------------------------------- base64 glue
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const alphabetPieces = splitPieces(alphabet, 11);
  push(
    `local ${B64REV} = {}`,
    `do`,
    `  local alphabet = ${alphabetPieces.map((piece) => luaQuote(piece)).join(" .. ")}`,
    `  for index = 1, #alphabet do`,
    `    ${B64REV}[${SUB}(alphabet, index, index)] = index - 1`,
    `  end`,
    `end`,
    `local function ${B64DEC}(text)`,
    `  local out = {}`,
    `  local accumulator = 0`,
    `  local bitsIn = 0`,
    `  for index = 1, #text do`,
    `    local value = ${B64REV}[${SUB}(text, index, index)]`,
    `    if value then`,
    `      accumulator = accumulator * 64 + value`,
    `      bitsIn = bitsIn + 6`,
    `      if bitsIn >= 8 then`,
    `        bitsIn = bitsIn - 8`,
    `        out[#out + 1] = ${CHAR}(${FLOOR}(accumulator / 2 ^ bitsIn) % 256)`,
    `        accumulator = accumulator % 2 ^ bitsIn`,
    `      end`,
    `    end`,
    `  end`,
    `  return ${CONCAT}(out)`,
    `end`,
  );

  // ------------------------------------------------------------------- LZW
  push(
    `local function ${LZW}(data)`,
    `  local out = {}`,
    `  local dict, nextCode, previous`,
    `  local function reset()`,
    `    dict = {}`,
    `    for index = 0, 255 do`,
    `      dict[index] = ${CHAR}(index)`,
    `    end`,
    `    nextCode = 258`,
    `    previous = nil`,
    `  end`,
    `  reset()`,
    `  for index = 1, #data - 1, 2 do`,
    `    local code = ${BYTE}(data, index) * 256 + ${BYTE}(data, index + 1)`,
    `    if code == 256 then`,
    `      reset()`,
    `    elseif code == 257 then`,
    `      break`,
    `    else`,
    `      local entry`,
    `      if code < nextCode and dict[code] then`,
    `        entry = dict[code]`,
    `      elseif previous then`,
    `        entry = previous .. ${SUB}(previous, 1, 1)`,
    `      else`,
    `        error("invalid instruction")`,
    `      end`,
    `      out[#out + 1] = entry`,
    `      if previous and nextCode <= 4095 then`,
    `        dict[nextCode] = previous .. ${SUB}(entry, 1, 1)`,
    `        nextCode = nextCode + 1`,
    `      end`,
    `      previous = entry`,
    `    end`,
    `  end`,
    `  return ${CONCAT}(out)`,
    `end`,
  );

  // ------------------------------------------------------------- decryption
  push(
    `local function ${UNMASK}(data, seed, phase, salt)`,
    `  local state = (${MUL}(seed, 40503) + 2654435761) % 4294967296`,
    `  for index = 1, #salt do`,
    `    state = (${MUL}(state, 31) + ${BYTE}(salt, index)) % 4294967296`,
    `  end`,
    `  state = (state + phase * 2246822519) % 4294967296`,
    `  if state == 0 then`,
    `    state = 2463534242`,
    `  end`,
    `  local key = state`,
    `  local out = {}`,
    `  for index = 1, #data do`,
    `    key = (${MUL}(key, 1664525) + 1013904223) % 4294967296`,
    `    local folded = (${FLOOR}(key / 65536) + key % 65536) % 256`,
    `    local mask = (folded + (index * 29) % 256 + phase) % 256`,
    `    out[index] = ${CHAR}((${BYTE}(data, index) - mask) % 256)`,
    `  end`,
    `  return ${CONCAT}(out)`,
    `end`,
    `local function ${CHECKSUM}(value)`,
    `  local hash = 2166136261`,
    `  for index = 1, #value do`,
    `    hash = (hash + ${BYTE}(value, index) + (index * 97) % 65521) % 4294967296`,
    `    hash = (${MUL}(hash, 16777619) + 2654435769) % 4294967296`,
    `  end`,
    `  return hash % 4294967296`,
    `end`,
  );

  // ---------------------------------------------------------- payload parser
  push(
    `local function ${PARSE}(text)`,
    `  local position = 1`,
    `  local function readNumber()`,
    `    local stop = ${FIND}(text, ";", position, true)`,
    `    local body = ${SUB}(text, position, stop - 1)`,
    `    position = stop + 1`,
    `    if body == "#I" then return ${MATH}.huge end`,
    `    if body == "#J" then return -${MATH}.huge end`,
    `    if body == "#K" then return 0 / 0 end`,
    `    return tonumber(body) or 0`,
    `  end`,
    `  local function readString()`,
    `    local stop = ${FIND}(text, ":", position, true)`,
    `    local length = tonumber(${SUB}(text, position, stop - 1)) or 0`,
    `    local value = ${SUB}(text, stop + 1, stop + length)`,
    `    position = stop + length + 1`,
    `    return value`,
    `  end`,
    `  local readValue`,
    `  readValue = function()`,
    `    local tag = ${SUB}(text, position, position)`,
    `    position = position + 1`,
    `    if tag == "S" then`,
    `      return readString()`,
    `    elseif tag == "N" then`,
    `      return readNumber()`,
    `    elseif tag == "A" then`,
    `      local stop = ${FIND}(text, "[", position, true)`,
    `      local count = tonumber(${SUB}(text, position, stop - 1)) or 0`,
    `      position = stop + 1`,
    `      local array = {}`,
    `      for index = 1, count do`,
    `        array[index] = readValue()`,
    `      end`,
    `      position = position + 1`,
    `      return array`,
    `    elseif tag == "T" then`,
    `      return true`,
    `    elseif tag == "F" then`,
    `      return false`,
    `    end`,
    `    return nil`,
    `  end`,
    `  return readValue()`,
    `end`,
  );

  // ----------------------------------------------------------- payload boot
  const [seedA, seedB, seedC] = profile.seedParts;
  const [phaseA, phaseB] = profile.phaseParts;
  const chunkLiterals = payload.chunks.map((chunk, index) => {
    // Each chunk is emitted as a concatenation of small literals: no long,
    // easily greppable base64 blobs survive in the output.
    const pieces = splitPieces(chunk, 96 + (index % 3) * 17);
    return `(${pieces.map((piece) => luaQuote(piece)).join(" .. ")})`;
  });

  push(
    `local ${CHUNKS} = {${chunkLiterals.join(", ")}}`,
    `local ${ORDER} = {${payload.order.map((value) => value + 1).join(", ")}}`,
    `local ${PARTS} = {}`,
    `for index = 1, #${ORDER} do`,
    `  ${PARTS}[index] = ${CHUNKS}[${ORDER}[index]]`,
    `end`,
    `local ${SEED} = (${MUL}(${seedA}, 31) + ${MUL}(${seedB}, 40503) + ${seedC}) % 4294967296`,
    `local ${PHASE} = (${phaseA} + ${phaseB}) % 256`,
    `local ${SALT} = ${splitPieces(profile.salt, 5).map((piece) => luaQuote(piece)).join(" .. ")}`,
    `local ${DATA} = ${B64DEC}(${CONCAT}(${PARTS}))`,
    `local ${PLAIN} = ${LZW}(${UNMASK}(${DATA}, ${SEED}, ${PHASE}, ${SALT}))`,
    `if ${CHECKSUM}(${PLAIN}) ~= ${payload.checksum} then error("invalid instruction") end`,
    `local ${PROGRAM} = ${PARSE}(${PLAIN})`,
    `local ${PROTOS} = ${PROGRAM}[1]`,
    `local ${STRINGS} = ${PROGRAM}[2]`,
    `local ${n("NUMBERS")} = ${PROGRAM}[3]`,
    `local ${ENTRY} = ${PROGRAM}[4]`,
  );

  if (options.toggles.antiTamper) {
    push(
      `if ${TYPE}(${CONCAT}) ~= "function" or ${TYPE}(${CHAR}) ~= "function" or ${TYPE}(${FLOOR}) ~= "function" then`,
      `  error("invalid instruction")`,
      `end`,
      `if ${CHAR}(65) ~= "A" or ${SUB}("abc", 2, 3) ~= "bc" or ${CONCAT}({${CHAR}(82), ${CHAR}(86)}) ~= "RV" then`,
      `  error("invalid instruction")`,
      `end`,
    );
  }
  if (options.toggles.decoys) {
    push(
      `local ${n("DECOY1")} = function(value) local out = {} for index = 1, #value do out[index] = ${CHAR}((${BYTE}(value, index) + index) % 256) end return ${CONCAT}(out) end`,
      `local ${n("DECOY2")} = function(value) return ${TYPE}(value) == "table" and #value or 0 end`,
    );
  }

  // ------------------------------------------------------------------- VM
  push(
    `local ${RUN}`,
    `local function ${MAKECL}(protoIndex, upvalues)`,
    `  return function(...)`,
    `    return ${RUN}(${PROTOS}, protoIndex, upvalues, ...)`,
    `  end`,
    `end`,
    `${RUN} = function(${P}, ${n("PROTO")}, ${UPS}, ...)`,
    `  local ${CODE} = ${P}[${n("PROTO")}][4]`,
    `  local params = ${P}[${n("PROTO")}][1]`,
    `  local args = ${PACK}(...)`,
    `  local ${ST} = {}`,
    `  local ${TOP} = params`,
    `  for index = 1, params do`,
    `    ${ST}[index] = args[index]`,
    `  end`,
    `  local ${VA} = {n = args.n - params}`,
    `  for index = 1, ${VA}.n do`,
    `    ${VA}[index] = args[index + params]`,
    `  end`,
    `  local ${PC} = 1`,
    `  local ${OP}`,
    `  while true do`,
    `    ${OP} = ${CODE}[${PC}]`,
    `    ${PC} = ${PC} + 1`,
    ...(process.env.REVEIL_TRACE
      ? [`    do local sink = ${RAWGET}(${ENV}, "__REVEIL_TRACE") if sink then local line = "op\\t" .. ${OP} .. "\\tpc\\t" .. ${PC} .. "\\ttop\\t" .. ${TOP} .. "\\n" if ${TYPE}(sink) == "function" then sink(line) else rawget(${ENV}, "io").write(line) end end end`]
      : []),
  );

  // Bit helpers are only emitted when the program actually uses them.
  if (profile.usesBitwise) {
    push(
      `    if ${OP} == ${op("BAND")} or ${OP} == ${op("BOR")} or ${OP} == ${op("BXOR")} or ${OP} == ${op("BNOT")} or ${OP} == ${op("SHL")} or ${OP} == ${op("SHR")} then`,
      `      if not ${BITS} then`,
      `        local lib = ${RAWGET}(${ENV}, "bit32") or ${RAWGET}(${ENV}, "bit")`,
      `        if lib and lib.band then`,
      `          ${BITS} = lib`,
      `        else`,
      `          local loader = ${RAWGET}(${ENV}, "loadstring") or ${RAWGET}(${ENV}, "load")`,
      `          if loader then`,
      `            local ok, chunk = pcall(loader, "return {band=function(a,b) return a & b end,bor=function(a,b) return a | b end,bxor=function(a,b) return a ~ b end,bnot=function(a) return ~a end,lshift=function(a,b) return a << b end,rshift=function(a,b) return a >> b end}")`,
      `            if ok and ${TYPE}(chunk) == "function" then`,
      `              local built, library = pcall(chunk)`,
      `              if built and ${TYPE}(library) == "table" then`,
      `                ${BITS} = library`,
      `              end`,
      `            end`,
      `          end`,
      `        end`,
      `      end`,
      `    end`,
    );
  }

  if (profile.usesPresize) {
    push(
      `local ${PRESIZE_CACHE} = {}`,
      `local ${PRESIZE} = function(count)`,
      `  if count <= 0 then return {} end`,
      `  local builder = ${PRESIZE_CACHE}[count]`,
      `  if builder == nil then`,
      `    local loader = ${RAWGET}(${ENV}, "loadstring") or ${RAWGET}(${ENV}, "load")`,
      `    local source = "return {"`,
      `    for index = 2, count do source = source .. "nil," end`,
      `    source = source .. "nil}"`,
      `    local ok, chunk = pcall(loader, source)`,
      `    builder = ok and ${TYPE}(chunk) == "function" and chunk or false`,
      `    ${PRESIZE_CACHE}[count] = builder`,
      `  end`,
      `  if builder then return builder() end`,
      `  return {}`,
      `end`,
    );
  }

  const dispatch = buildDispatch({
    profile,
    names: {
      OP, ST, TOP, PC, CODE, STRINGS, PROTOS, UPS, ENV, PACK, UNPACK, CONCAT, FLOOR, CHAR, TYPE, MAKECL, RUN, BITS, IDIV, VA, MATH,
      PRESIZE,
      NUMBERS: n("NUMBERS"),
    },
  });
  push(...dispatch);

  push(
    `    else`,
    `      error("invalid instruction")`,
    `    end`,
    `  end`,
    `end`,
    `local ${MAIN} = ${MAKECL}(${ENTRY}, {})`,
    `return ${MAIN}(...)`,
  );

  return lines.join("\n");
}

interface DispatchNames {
  OP: string;
  ST: string;
  TOP: string;
  PC: string;
  CODE: string;
  STRINGS: string;
  PROTOS: string;
  UPS: string;
  ENV: string;
  PACK: string;
  UNPACK: string;
  CONCAT: string;
  FLOOR: string;
  CHAR: string;
  TYPE: string;
  MAKECL: string;
  RUN: string;
  BITS: string;
  IDIV: string;
  VA: string;
  MATH: string;
  NUMBERS: string;
  PRESIZE: string;
}

function buildDispatch(input: { profile: LuaProfile; names: DispatchNames }): string[] {
  const { profile } = input;
  const N = input.names;
  const out: string[] = [];
  const op = (name: OpName): string => String(profile.opcodes[name]);

  const bodies: Record<string, string[]> = {
    LOADK: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.CODE}[${N.PC}]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    LOADF: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.NUMBERS}[${N.CODE}[${N.PC}]]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    LOADSTR: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.STRINGS}[${N.CODE}[${N.PC}]]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    LOADBOOL: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.CODE}[${N.PC}] == 1`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    LOADNIL: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = nil`,
    ],
    LOADL: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.ST}[${N.CODE}[${N.PC}]]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    STOREL: [
      `${N.ST}[${N.CODE}[${N.PC}]] = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    LOADC: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.ST}[${N.CODE}[${N.PC}]][1]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    STOREC: [
      `${N.ST}[${N.CODE}[${N.PC}]][1] = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    CELLNEW: [
      `${N.ST}[${N.CODE}[${N.PC}]] = {}`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    MAKEF: [
      `local slot = ${N.CODE}[${N.PC}]`,
      `local target = ${N.CODE}[${N.PC} + 1]`,
      `local boxed = ${N.CODE}[${N.PC} + 2] == 1`,
      `local descriptor = ${N.PROTOS}[target][3]`,
      `local captured = {}`,
      `for index = 1, #descriptor do`,
      `  local reference = descriptor[index]`,
      `  if reference > 0 then captured[index] = ${N.ST}[reference] else captured[index] = ${N.UPS}[-reference] end`,
      `end`,
      `local closure = ${N.MAKECL}(target, captured)`,
      `if boxed then ${N.ST}[slot][1] = closure else ${N.ST}[slot] = closure end`,
      `${N.PC} = ${N.PC} + 3`,
    ],
    CELLSET: [
      `local cellValue = ${N.ST}[${N.CODE}[${N.PC} + 1]]`,
      `${N.ST}[${N.CODE}[${N.PC}]] = {cellValue}`,
      `${N.PC} = ${N.PC} + 2`,
    ],
    LOADG: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.ENV}[${N.STRINGS}[${N.CODE}[${N.PC}]]]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    STOREG: [
      `${N.ENV}[${N.STRINGS}[${N.CODE}[${N.PC}]]] = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    LOADENV: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.ENV}`,
    ],
    LOADU: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.UPS}[${N.CODE}[${N.PC}]][1]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    STOREU: [
      `${N.UPS}[${N.CODE}[${N.PC}]][1] = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    NEWT: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = {}`,
    ],
    GETI: [
      `local key = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}][key]`,
    ],
    SETI: [
      `local value = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `local key = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.ST}[${N.TOP}][key] = value`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
    ],
    GETS: [
      `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}][${N.STRINGS}[${N.CODE}[${N.PC}]]]`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    SETS: [
      `local value = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.ST}[${N.TOP}][${N.STRINGS}[${N.CODE}[${N.PC}]]] = value`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    SETSAT: [
      `local value = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.ST}[${N.CODE}[${N.PC}]][${N.STRINGS}[${N.CODE}[${N.PC} + 1]]] = value`,
      `${N.PC} = ${N.PC} + 2`,
    ],
    SETIAT: [
      `local value = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `local key = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.ST}[${N.CODE}[${N.PC}]][key] = value`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    SELF: [
      `local object = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = object[${N.STRINGS}[${N.CODE}[${N.PC}]]]`,
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = object`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    APPENDAT: [
      `${N.ST}[${N.CODE}[${N.PC}]][${N.CODE}[${N.PC} + 1]] = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 2`,
    ],
    APPENDMAT: (() => {
      const lines = [
        `do`,
        `  local target = ${N.ST}[${N.CODE}[${N.PC}]]`,
        `  local base = ${N.CODE}[${N.PC}]`,
        `  local offset = ${N.CODE}[${N.PC} + 1] - 1`,
        `  local count = ${N.TOP} - base`,
      ];
      if (profile.usesPresize) {
        lines.push(
          `  if count > 0 then`,
          `    local fresh = ${N.PRESIZE}(offset + count)`,
          `    for key, value in next, target do fresh[key] = value end`,
          `    target = fresh`,
          `  end`,
        );
      }
      lines.push(
        `  for index = base + 1, ${N.TOP} do`,
        `    target[offset + index - base] = ${N.ST}[index]`,
        `    ${N.ST}[index] = nil`,
        `  end`,
        `  ${N.ST}[${N.CODE}[${N.PC}]] = target`,
        `  ${N.TOP} = base`,
        `  ${N.PC} = ${N.PC} + 2`,
        `end`,
      );
      return lines;
    })(),
    NEWA: [
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.PRESIZE}(${N.CODE}[${N.PC}])`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    ADD: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] + right`],
    SUB: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] - right`],
    MUL: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] * right`],
    DIV: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] / right`],
    MOD: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] % right`],
    POW: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] ^ right`],
    IDIV: [
      `local right = ${N.ST}[${N.TOP}]`,
      `${N.TOP} = ${N.TOP} - 1`,
      `if not ${N.IDIV} then`,
      `  local loader = rawget(${N.ENV}, "loadstring") or rawget(${N.ENV}, "load")`,
      `  local ok, chunk = pcall(loader, "return function(a, b) return a // b end")`,
      `  local helper`,
      `  if ok and type(chunk) == "function" then`,
      `    local built, compiled = pcall(chunk)`,
      `    if built and type(compiled) == "function" then helper = compiled end`,
      `  end`,
      `  ${N.IDIV} = helper or function(a, b) return ${N.FLOOR}(a / b) end`,
      `end`,
      `${N.ST}[${N.TOP}] = ${N.IDIV}(${N.ST}[${N.TOP}], right)`,
    ],
    CONCAT: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] .. right`],
    BAND: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.BITS}.band(${N.ST}[${N.TOP}], right)`],
    BOR: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.BITS}.bor(${N.ST}[${N.TOP}], right)`],
    BXOR: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.BITS}.bxor(${N.ST}[${N.TOP}], right)`],
    SHL: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.BITS}.lshift(${N.ST}[${N.TOP}], right)`],
    SHR: [`local right = ${N.ST}[${N.TOP}]`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.BITS}.rshift(${N.ST}[${N.TOP}], right)`],
    UNM: [`${N.ST}[${N.TOP}] = -${N.ST}[${N.TOP}]`],
    NOTOP: [`${N.ST}[${N.TOP}] = not ${N.ST}[${N.TOP}]`],
    LEN: [`${N.ST}[${N.TOP}] = #${N.ST}[${N.TOP}]`],
    BNOT: [`${N.ST}[${N.TOP}] = ${N.BITS}.bnot(${N.ST}[${N.TOP}])`],
    EQ: [`local right = ${N.ST}[${N.TOP}]`, `${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] == right`],
    NE: [`local right = ${N.ST}[${N.TOP}]`, `${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] ~= right`],
    LT: [`local right = ${N.ST}[${N.TOP}]`, `${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] < right`],
    LE: [`local right = ${N.ST}[${N.TOP}]`, `${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] <= right`],
    GT: [`local right = ${N.ST}[${N.TOP}]`, `${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] > right`],
    GE: [`local right = ${N.ST}[${N.TOP}]`, `${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP}] >= right`],
    JMP: [
      `local offset = ${N.CODE}[${N.PC}]`,
      `${N.PC} = ${N.PC} + 1 + offset`,
    ],
    JT: [
      `local condition = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
      `if condition then ${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1] end`,
    ],
    JF: [
      `local condition = ${N.ST}[${N.TOP}]`,
      `${N.ST}[${N.TOP}] = nil`,
      `${N.TOP} = ${N.TOP} - 1`,
      `${N.PC} = ${N.PC} + 1`,
      `if not condition then ${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1] end`,
    ],
    JTK: [
      `${N.PC} = ${N.PC} + 1`,
      `if ${N.ST}[${N.TOP}] then ${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1] end`,
    ],
    JFK: [
      `${N.PC} = ${N.PC} + 1`,
      `if not ${N.ST}[${N.TOP}] then ${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1] end`,
    ],
    POP: [`${N.ST}[${N.TOP}] = nil`, `${N.TOP} = ${N.TOP} - 1`],
    DUP: [`${N.TOP} = ${N.TOP} + 1`, `${N.ST}[${N.TOP}] = ${N.ST}[${N.TOP} - 1]`],
    SETTOP: [`${N.TOP} = ${N.CODE}[${N.PC}]`, `${N.PC} = ${N.PC} + 1`],
    CALL: [
      `local base = ${N.CODE}[${N.PC}]`,
      `local wanted = ${N.CODE}[${N.PC} + 1]`,
      `${N.PC} = ${N.PC} + 2`,
      `if wanted == 0 then`,
      `  ${N.ST}[base](${N.UNPACK}(${N.ST}, base + 1, ${N.TOP}))`,
      `  for index = base, ${N.TOP} do ${N.ST}[index] = nil end`,
      `  ${N.TOP} = base - 1`,
      `elseif wanted == 1 then`,
      `  ${N.ST}[base] = ${N.ST}[base](${N.UNPACK}(${N.ST}, base + 1, ${N.TOP}))`,
      `  for index = base + 1, ${N.TOP} do ${N.ST}[index] = nil end`,
      `  ${N.TOP} = base`,
      `else`,
      `  local results = ${N.PACK}(${N.ST}[base](${N.UNPACK}(${N.ST}, base + 1, ${N.TOP})))`,
      `  if wanted < 0 then wanted = results.n end`,
      `  for index = 1, wanted do ${N.ST}[base + index - 1] = results[index] end`,
      `  for index = base + wanted, ${N.TOP} do ${N.ST}[index] = nil end`,
      `  ${N.TOP} = base + wanted - 1`,
      `end`,
    ],
    RET: [
      `local base = ${N.CODE}[${N.PC}]`,
      `local mode = ${N.CODE}[${N.PC} + 1]`,
      `if base == 0 then return end`,
      `if mode < 0 then return ${N.UNPACK}(${N.ST}, base, ${N.TOP}) end`,
      `if mode == 0 then return end`,
      `return ${N.UNPACK}(${N.ST}, base, base + mode - 1)`,
    ],
    CLOSURE: [
      `local descriptor = ${N.PROTOS}[${N.CODE}[${N.PC}]][3]`,
      `local captured = {}`,
      `for index = 1, #descriptor do`,
      `  local slot = descriptor[index]`,
      `  if slot > 0 then captured[index] = ${N.ST}[slot] else captured[index] = ${N.UPS}[-slot] end`,
      `end`,
      `${N.TOP} = ${N.TOP} + 1`,
      `${N.ST}[${N.TOP}] = ${N.MAKECL}(${N.CODE}[${N.PC}], captured)`,
      `${N.PC} = ${N.PC} + 1`,
    ],
    VARARG: [
      `local base = ${N.CODE}[${N.PC}]`,
      `local mode = ${N.CODE}[${N.PC} + 1]`,
      `if mode < 0 then`,
      `  for index = 1, ${N.VA}.n do ${N.ST}[base + index - 1] = ${N.VA}[index] end`,
      `  ${N.TOP} = base + ${N.VA}.n - 1`,
      `else`,
      `  for index = 1, mode do ${N.ST}[base + index - 1] = ${N.VA}[index] end`,
      `  ${N.TOP} = base + mode - 1`,
      `end`,
      `${N.PC} = ${N.PC} + 2`,
    ],
    FORPREP: [
      `local loopVar = ${N.CODE}[${N.PC}]`,
      `local control = ${N.CODE}[${N.PC} + 1]`,
      `local init = tonumber(${N.ST}[control])`,
      `local limit = tonumber(${N.ST}[control + 1])`,
      `local step = tonumber(${N.ST}[control + 2])`,
      `if init == nil then error("'for' initial value must be a number", 0) end`,
      `if limit == nil then error("'for' limit must be a number", 0) end`,
      `if step == nil then error("'for' step must be a number", 0) end`,
      `if step == 0 then error("'for' step is zero", 0) end`,
      `${N.ST}[control] = init - step`,
      `${N.ST}[control + 1] = limit`,
      `${N.ST}[control + 2] = step`,
      `${N.PC} = ${N.PC} + 5`,
      `${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1]`,
    ],
    FORLOOP: [
      `local loopVar = ${N.CODE}[${N.PC}]`,
      `local control = ${N.CODE}[${N.PC} + 1]`,
      `local step = ${N.ST}[control + 2]`,
      `local nextValue = ${N.ST}[control] + step`,
      `local limit = ${N.ST}[control + 1]`,
      `${N.ST}[control] = nextValue`,
      `${N.PC} = ${N.PC} + 5`,
      `if (step > 0 and nextValue <= limit) or (step < 0 and nextValue >= limit) then`,
      `  ${N.ST}[loopVar] = nextValue`,
      `  ${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1]`,
      `end`,
    ],
    TF: [
      `local base = ${N.CODE}[${N.PC}]`,
      `local vars = ${N.CODE}[${N.PC} + 1]`,
      `local count = ${N.CODE}[${N.PC} + 2]`,
      `local results = ${N.PACK}(${N.ST}[base](${N.ST}[base + 1], ${N.ST}[base + 2]))`,
      `${N.ST}[base + 2] = results[1]`,
      `for index = 1, count do ${N.ST}[vars + index - 1] = results[index] end`,
      `${N.PC} = ${N.PC} + 4`,
      `if results[1] == nil then`,
      `  ${N.PC} = ${N.PC} + ${N.CODE}[${N.PC} - 1]`,
      `end`,
    ],
  };

  for (const name of profile.dispatchOrder) {
    const body = bodies[name];
    if (!body) {
      continue;
    }
    const keyword = out.length === 0 ? "if" : "elseif";
    out.push(`    ${keyword} ${N.OP} == ${op(name)} then`);
    for (const line of body) {
      out.push(`      ${line}`);
    }
  }
  return out;
}

function concatLiteral(value: string): string {
  return `(${splitPieces(value, 120).map((piece) => luaQuote(piece)).join(" .. ")})`;
}

function splitPieces(value: string, size: number): string[] {
  if (value.length <= size) {
    return [value];
  }
  const pieces: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    pieces.push(value.slice(index, index + size));
  }
  return pieces;
}

/** Entry point wrapper used by the Lua emitter. */
export function renderLuaModule(input: RuntimeInput): string {
  const body = renderRuntime(input);
  const banner = input.options.toggles.banner
    ? [
        `--[[`,
        `  ReVeil v2 • ${new Date().toISOString().slice(0, 10)} • preset: ${input.options.preset}`,
        input.options.watermark ? `  ${input.options.watermark}` : `  Reverse engineering is a breach of the license.`,
        `]]`,
      ].join("\n")
    : "";
  return `${banner}${banner ? "\n" : ""}return (function(...)\n${body}\nend)(...)`;
}
