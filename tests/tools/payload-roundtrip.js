#!/usr/bin/env node
/**
 * Verifies that a compiled program survives serialisation: this mirrors the
 * `PARSE` function the Lua runtime uses, then re-serialises the decoded
 * structure and compares it with the original program.
 */
const path = require("path");
const { parseLua } = require(path.join(__dirname, "..", "..", "dist", "lua", "parser.js"));
const { resolveChunk } = require(path.join(__dirname, "..", "..", "dist", "lua", "resolve.js"));
const { compileChunk } = require(path.join(__dirname, "..", "..", "dist", "lua", "compiler.js"));
const { serializeProgram, OP_ARITY } = require(path.join(__dirname, "..", "..", "dist", "lua", "bytecode.js"));
const { ReVeilRandom } = require(path.join(__dirname, "..", "..", "dist", "core", "rng.js"));

/** Decoder mirroring the runtime PARSE. */
function decode(text) {
  let position = 0;
  const readNumber = () => {
    const stop = text.indexOf(";", position);
    const body = text.slice(position, stop);
    position = stop + 1;
    if (body === "#I") return Infinity;
    if (body === "#J") return -Infinity;
    if (body === "#K") return NaN;
    return Number(body);
  };
  const readString = () => {
    const stop = text.indexOf(":", position);
    const length = Number(text.slice(position, stop));
    const value = text.slice(stop + 1, stop + 1 + length);
    position = stop + length + 1;
    return value;
  };
  const readValue = () => {
    const tag = text[position];
    position += 1;
    if (tag === "S") return readString();
    if (tag === "N") return readNumber();
    if (tag === "A") {
      const stop = text.indexOf("[", position);
      const count = Number(text.slice(position, stop));
      position = stop + 1;
      const array = [];
      for (let index = 0; index < count; index += 1) array.push(readValue());
      position += 1;
      return array;
    }
    if (tag === "T") return true;
    if (tag === "F") return false;
    return null;
  };
  return readValue();
}

function main() {
  const source = process.argv[2] || "local a, b = 10, 3.5 local t = {1, 2, a} print(#t, a // 2, b, a .. b)";
  const rng = new ReVeilRandom(12345, "lua", 0x1111);
  const chunk = parseLua(source, { allowLuau: true });
  const resolve = resolveChunk(chunk, rng);
  const { program } = compileChunk(chunk, resolve, rng, { allowGoto: true });
  const encoded = serializeProgram(program, (name) => name.length);
  const text = Buffer.from(encoded).toString("latin1");
  const decoded = decode(text);
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    console.log("✗ payload is not a four element array", decoded && decoded.length);
    process.exit(1);
  }
  const [protos, strings, numbers, entry] = decoded;
  const problems = [];
  if (protos.length !== program.protos.length) problems.push(`protos ${protos.length} != ${program.protos.length}`);
  if (strings.length !== program.strings.length) problems.push(`strings ${strings.length} != ${program.strings.length}`);
  if (numbers.length !== program.numbers.length) problems.push(`numbers ${numbers.length} != ${program.numbers.length}`);
  if (entry !== program.entry) problems.push(`entry ${entry} != ${program.entry}`);
  program.protos.forEach((proto, index) => {
    const [params, vararg, updesc, code, maxSlots] = protos[index];
    if (params !== proto.params) problems.push(`proto ${index} params`);
    if ((vararg === 1) !== proto.vararg) problems.push(`proto ${index} vararg`);
    if (JSON.stringify(updesc) !== JSON.stringify(proto.updesc)) problems.push(`proto ${index} updesc`);
    if (maxSlots !== proto.maxSlots) problems.push(`proto ${index} maxSlots`);
    const expectedWords = proto.code.reduce((total, instruction) => total + 1 + OP_ARITY[instruction[0]], 0);
    if (code.length !== expectedWords) problems.push(`proto ${index} code words ${code.length} != ${expectedWords}`);
  });
  if (problems.length > 0) {
    console.log("✗ roundtrip mismatch:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`✓ payload roundtrip ok (${program.protos.length} protos, ${program.numbers.length} floats, ${text.length} chars)`);
}

main();
