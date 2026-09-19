/** ReVeil — shared low level helpers. */

/** Lua escape sequences for a raw string value, safe to embed in `"` quotes. */
export function luaQuote(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === "\\") {
      out += "\\\\";
    } else if (char === '"') {
      out += '\\"';
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (code < 32 || code === 127) {
      out += `\\${code.toString().padStart(3, "0")}`;
    } else if (code > 126) {
      // Emit byte-wise escapes so the produced file stays pure ASCII and is
      // immune to encoding mangling by editors, copy/paste and Discord.
      const bytes = Buffer.from(char, "utf8");
      for (const byte of bytes) {
        out += `\\${byte.toString().padStart(3, "0")}`;
      }
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

export function luaByteStringEscapes(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = '"';
  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\${byte.toString().padStart(3, "0")}`;
    }
  }
  return `${out}"`;
}

export function jsQuote(value: string): string {
  return JSON.stringify(value);
}

export function pyQuote(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = 'b"';
  for (const byte of bytes) {
    if (byte === 34) {
      out += '\\"';
    } else if (byte === 92) {
      out += "\\\\";
    } else if (byte >= 32 && byte <= 126) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return `${out}"`;
}

export function base64Encode(bytes: Buffer): string {
  return bytes.toString("base64");
}

export function base64Decode(value: string): Buffer {
  return Buffer.from(value, "base64");
}

/** Splits a long string into chunks usable as separate Lua string literals. */
export function chunkString(value: string, rng: { range: (min: number, max: number) => number }): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < value.length) {
    const size = rng.range(48, 220);
    chunks.push(value.slice(index, index + size));
    index += size;
  }
  return chunks.length > 0 ? chunks : [""];
}

export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length;
}

export function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Percent-encodes bytes as `\ddd` for Lua literals, chunked for size. */
export function toHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

export function sha1(value: string): string {
  // Small, dependency free SHA-1 (used for integrity tags only, not security).
  const data = Buffer.from(value, "utf8");
  const bitLength = data.length * 8;
  const withPadding = Buffer.concat([
    data,
    Buffer.from([0x80]),
    Buffer.alloc((56 - ((data.length + 1) % 64) + 64) % 64),
    (() => {
      const lengthBuffer = Buffer.alloc(8);
      lengthBuffer.writeUInt32BE(Math.floor(bitLength / 0x100000000), 0);
      lengthBuffer.writeUInt32BE(bitLength >>> 0, 4);
      return lengthBuffer;
    })(),
  ]);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Array<number>(80);
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = withPadding.readUInt32BE(offset + index * 4);
    }
    for (let index = 16; index < 80; index += 1) {
      const value = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16];
      words[index] = ((value << 1) | (value >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f = 0;
      let k = 0;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
