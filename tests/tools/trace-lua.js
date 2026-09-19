const fs = require('fs');
const { LuaFactory } = require('wasmoon');
const { obfuscate } = require('/home/user/ReVeil/dist/engine.js');
const source = fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2], 'utf8') : process.argv[2];
const res = obfuscate(source, { filename: 'x.lua', seed: 12345, preset: 'heavy' });
if (!res.ok) { console.log('OBF FAILED', res.error); process.exit(1); }
const reverse = {};
for (const line of (res.stats.disassembly || '').split('\n')) {
  // not used; kept for future debugging
  void line;
}
(async () => {
  const lua = await new LuaFactory().createEngine();
  const out = [];
  lua.global.set('__cap', (line) => out.push(String(line)));
  await lua.doString(`
    print = function(...) local t = {} for i = 1, select('#', ...) do t[i] = tostring((select(i, ...))) end __cap(table.concat(t, '\\t')) end
    __TRACE = {}
    __REVEIL_TRACE = function(line) __TRACE[#__TRACE + 1] = line end
  `);
  try {
    await lua.doString(res.code);
    console.log('OUT ' + JSON.stringify(out.join('\n')));
  } catch (error) {
    console.log('ERR ' + error.message);
  }
  const trace = String(await lua.doString('return table.concat(__TRACE)'));
  const rmap = {};
  const raw = res.code;
  // opcode numbers are not exported; decode via the emitted profile map in stats if present
  for (const [name, value] of Object.entries(res.stats.opcodes || {})) rmap[value] = name;
  console.log(trace.split('\n').filter(Boolean).slice(-(Number(process.env.TRACE_LINES) || 30)).map((line) => {
    const parts = line.split('\t');
    if (parts.length < 6) return line;
    return `${(rmap[parts[1]] || 'op' + parts[1]).padEnd(10)} pc${parts[3]} top${parts[5]}`;
  }).join('\n'));
  void raw;
})();
