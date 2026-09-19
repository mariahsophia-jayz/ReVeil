/**
 * Runs Lua source inside a sandboxed Lua 5.4 interpreter (wasmoon) and returns
 * everything the chunk printed. Used by the test suite and the CLI self-check.
 */

let factory = null;

function getFactory() {
  if (!factory) {
    const { LuaFactory } = require("wasmoon");
    factory = new LuaFactory();
  }
  return factory;
}

/**
 * Virtual machines and instrumented runtimes produce error positions that
 * point into ReVeil's own runtime. The message text is preserved, only the
 * `[string "..."]:line:` prefix is normalised so results stay comparable.
 */
function normalize(text) {
  return text.replace(/\[string ".*?"\]:\d+:/g, "[chunk]:");
}

async function runLua(source, { pinGlobals = true } = {}) {
  const lua = await getFactory().createEngine();
  const captured = [];
  try {
    lua.global.set("__reveil_capture", (line) => {
      captured.push(String(line));
    });
    lua.global.set("os", undefined);
    lua.global.set("io", undefined);
    if (pinGlobals) {
      await lua.doString(
        [
          "local sink = __reveil_capture",
          "print = function(...)",
          "  local parts = {}",
          "  for index = 1, select('#', ...) do",
          "    parts[index] = tostring((select(index, ...)))",
          "  end",
          "  sink(table.concat(parts, '\\t'))",
          "end",
        ].join("\n"),
      );
    }
    const result = await lua.doString(source);
    return { ok: true, out: normalize(captured.join("\n")), result, err: null };
  } catch (error) {
    return {
      ok: false,
      out: normalize(captured.join("\n")),
      result: undefined,
      err: normalize(String(error && error.message ? error.message : error)),
    };
  } finally {
    try {
      lua.global.close();
    } catch (_) {
      /* engine already closed */
    }
  }
}

module.exports = { runLua };
