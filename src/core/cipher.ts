/**
 * ReVeil payload cipher.
 *
 * The runtime mirror of everything in this file lives in `src/lua/runtime.ts`
 * (and the JS/Python emitters). Both sides must agree bit for bit, therefore
 * every operation is written with exact double precision arithmetic — no
 * bitwise operators, so the same code works on Lua 5.1 … 5.4, LuaJIT, Luau and
 * any sandbox that only ships `string`, `table` and `math`.
 */

/** Exact 32-bit modular multiplication (avoids float rounding above 2^53). */
export function mul32(a: number, b: number): number {
  const aHi = Math.floor(a / 65536) % 65536;
  const aLo = a % 65536;
  const bHi = Math.floor(b / 65536) % 65536;
  const bLo = b % 65536;
  const low = aLo * bLo;
  const mid = (aHi * bLo + aLo * bHi) % 65536;
  return (mid * 65536 + low) % 4294967296;
}

export interface CipherParams {
  seed: number;
  /** Extra key material mixed into the state initialisation. */
  salt: string;
  /** Additive byte mask phase. */
  phase: number;
}

export function deriveCipherState(params: CipherParams): number {
  // Keep this in sync with the Lua runtime: arithmetic only, no XOR, so the
  // same key schedule works on every Lua dialect.
  let state = (mul32(params.seed, 40503) + 2654435761) % 4294967296;
  for (let index = 0; index < params.salt.length; index += 1) {
    state = (mul32(state, 31) + params.salt.charCodeAt(index)) % 4294967296;
  }
  state = (state + params.phase * 2246822519) % 4294967296;
  if (state === 0) {
    state = 2463534242;
  }
  return state;
}

/**
 * Position dependent additive stream mask. Encryption adds the keystream,
 * decryption subtracts it — both directions are pure modular arithmetic.
 */
export function maskBytes(data: Uint8Array, params: CipherParams, decrypt = false): Uint8Array {
  const out = new Uint8Array(data.length);
  let state = deriveCipherState(params);
  for (let index = 0; index < data.length; index += 1) {
    state = (mul32(state, 1664525) + 1013904223) % 4294967296;
    const folded = (Math.floor(state / 65536) + (state % 65536)) % 256;
    const key = (folded + (((index + 1) * 29) % 256) + params.phase) % 256;
    out[index] = decrypt ? (data[index] - key + 256) % 256 : (data[index] + key) % 256;
  }
  return out;
}

/** LZW compression (16-bit codes) — decoded by the bundled Lua runtime. */
export function lzwCompress(input: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const END = 257;
  const LIMIT = 4095;

  const dictionary = new Map<string, number>();
  const reset = (): void => {
    dictionary.clear();
    for (let index = 0; index < 256; index += 1) {
      dictionary.set(String.fromCharCode(index), index);
    }
  };
  reset();

  const codes: number[] = [CLEAR];
  let nextCode = 258;
  let phrase = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = String.fromCharCode(input[index]);
    const combined = phrase + char;
    if (dictionary.has(combined)) {
      phrase = combined;
      continue;
    }
    if (phrase.length > 0) {
      codes.push(dictionary.get(phrase) as number);
    }
    dictionary.set(combined, nextCode);
    nextCode += 1;
    if (nextCode > LIMIT) {
      codes.push(CLEAR);
      reset();
      nextCode = 258;
    }
    phrase = char;
  }
  if (phrase.length > 0) {
    codes.push(dictionary.get(phrase) as number);
  }
  codes.push(END);

  const bytes = new Uint8Array(codes.length * 2);
  for (let index = 0; index < codes.length; index += 1) {
    bytes[index * 2] = (codes[index] >>> 8) & 0xff;
    bytes[index * 2 + 1] = codes[index] & 0xff;
  }
  return bytes;
}

/** Reference LZW decoder — used by the tests to validate emitted payloads. */
export function lzwDecompress(input: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const END = 257;
  const output: number[] = [];
  const dictionary: string[] = [];
  const reset = (): void => {
    dictionary.length = 0;
    for (let index = 0; index < 256; index += 1) {
      dictionary[index] = String.fromCharCode(index);
    }
  };
  reset();
  let nextCode = 258;
  let previous: string | null = null;

  for (let index = 0; index + 1 < input.length; index += 2) {
    const code = (input[index] << 8) | input[index + 1];
    if (code === CLEAR) {
      reset();
      nextCode = 258;
      previous = null;
      continue;
    }
    if (code === END) {
      break;
    }
    let entry: string;
    if (code < nextCode && dictionary[code] !== undefined) {
      entry = dictionary[code];
    } else if (previous !== null) {
      entry = previous + previous.charAt(0);
    } else {
      throw new Error("corrupt LZW stream");
    }
    for (let offset = 0; offset < entry.length; offset += 1) {
      output.push(entry.charCodeAt(offset) & 0xff);
    }
    if (previous !== null && nextCode <= 4095) {
      dictionary[nextCode] = previous + entry.charAt(0);
      nextCode += 1;
    }
    previous = entry;
  }
  return Uint8Array.from(output);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64FromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : -1;
    const c = index + 2 < bytes.length ? bytes[index + 2] : -1;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 3) << 4) | (b === -1 ? 0 : b >> 4)];
    out += b === -1 ? "=" : BASE64_ALPHABET[((b & 15) << 2) | (c === -1 ? 0 : c >> 6)];
    out += c === -1 ? "=" : BASE64_ALPHABET[c & 63];
  }
  return out;
}

export function bytesFromBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === "=") {
      break;
    }
    const index = BASE64_ALPHABET.indexOf(char);
    if (index === -1) {
      continue;
    }
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export interface PackedPayload {
  /** Scrambled base64 chunks exactly as they must appear in the output. */
  chunks: string[];
  /** Inverse permutation: `order[j]` is the file index of original chunk `j`. */
  order: number[];
  /** Cipher parameters the runtime needs. */
  params: CipherParams;
  /** Rolling checksum of the plain payload, verified by the runtime. */
  checksum: number;
  /** Size of the encoded payload in bytes. */
  encodedBytes: number;
  /** Size of the plain payload in bytes. */
  plainBytes: number;
}

export function checksumOf(value: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash + (value[index] & 0xffff) + ((index + 1) * 97) % 65521) % 4294967296;
    hash = (mul32(hash, 16777619) + 0x9e3779b9) % 4294967296;
  }
  return hash >>> 0;
}

export function packPayload(
  plain: Uint8Array,
  params: CipherParams,
  rng: { range: (min: number, max: number) => number; shuffle: <T>(values: T[]) => T[]; int: (max: number) => number },
): PackedPayload {
  const plainBytes = Buffer.from(plain);
  const compressed = lzwCompress(plainBytes);
  const masked = maskBytes(compressed, params, false);
  const base64 = base64FromBytes(masked);

  // Split into chunks, then scramble the chunk order; the runtime is told which
  // index to concatenate first, so a naive reader cannot even rebuild the blob.
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < base64.length) {
    const size = rng.range(160, 420);
    chunks.push(base64.slice(cursor, cursor + size));
    cursor += size;
  }
  if (chunks.length === 0) {
    chunks.push("");
  }
  // Scramble the file order of the chunks, and hand the runtime the inverse
  // permutation it needs to rebuild the original base64 text.
  const indices = chunks.map((_, index) => index);
  rng.shuffle(indices);
  const scrambled = indices.map((index) => chunks[index]);
  const inverse: number[] = new Array(chunks.length);
  indices.forEach((original, fileIndex) => {
    inverse[original] = fileIndex;
  });

  return {
    chunks: scrambled,
    order: inverse,
    params,
    checksum: checksumOf(plain),
    encodedBytes: base64.length,
    plainBytes: plainBytes.length,
  };
}
