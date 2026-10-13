const BASE45_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const BASE45_LOOKUP = new Map(Array.from(BASE45_ALPHABET, (char, index) => [char, index]));
const DECIMAL_WIDTH_CACHE = new Map<number, number>();

export function base45EncodedLength(byteLength: number): number {
  return Math.floor(byteLength / 2) * 3 + (byteLength % 2 === 0 ? 0 : 2);
}

export function base45Encode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 2) {
    if (index + 1 < bytes.length) {
      let value = bytes[index] * 256 + bytes[index + 1];
      const c = value % 45;
      value = Math.floor(value / 45);
      const d = value % 45;
      const e = Math.floor(value / 45);
      output += BASE45_ALPHABET[c] + BASE45_ALPHABET[d] + BASE45_ALPHABET[e];
    } else {
      let value = bytes[index];
      const c = value % 45;
      const d = Math.floor(value / 45);
      output += BASE45_ALPHABET[c] + BASE45_ALPHABET[d];
    }
  }
  return output;
}

export function base45Decode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; ) {
    const remaining = value.length - index;
    if (remaining === 1) throw new Error("Invalid Base45 length");
    const c = decodeBase45Char(value[index]);
    const d = decodeBase45Char(value[index + 1]);
    if (remaining >= 3) {
      const e = decodeBase45Char(value[index + 2]);
      const combined = c + d * 45 + e * 45 * 45;
      if (combined > 0xffff) throw new Error("Invalid Base45 triplet");
      bytes.push(combined >> 8, combined & 0xff);
      index += 3;
    } else {
      const combined = c + d * 45;
      if (combined > 0xff) throw new Error("Invalid Base45 pair");
      bytes.push(combined);
      index += 2;
    }
  }
  return new Uint8Array(bytes);
}

function decodeBase45Char(char: string): number {
  const value = BASE45_LOOKUP.get(char);
  if (value == null) throw new Error(`Invalid Base45 character: ${char}`);
  return value;
}

export function decimalWidthForBytes(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 0) throw new Error("Invalid byte length");
  if (byteLength === 0) return 1;
  const cached = DECIMAL_WIDTH_CACHE.get(byteLength);
  if (cached != null) return cached;
  const maxValue = (1n << BigInt(byteLength * 8)) - 1n;
  const width = maxValue.toString(10).length;
  DECIMAL_WIDTH_CACHE.set(byteLength, width);
  return width;
}

export function numericEncodeFrame(frameBytes: Uint8Array, fixedByteLength: number): string {
  if (frameBytes.byteLength > fixedByteLength) throw new Error("Frame exceeds fixed numeric byte length");
  const padded = new Uint8Array(fixedByteLength);
  padded.set(frameBytes, 0);
  const value = bytesToBigInt(padded);
  return value.toString(10).padStart(decimalWidthForBytes(fixedByteLength), "0");
}

export function numericDecodeFrame(digits: string): Uint8Array {
  if (!/^\d+$/.test(digits)) throw new Error("Numeric frame contains non-digits");
  const byteLength = byteLengthForDecimalWidth(digits.length);
  return bigIntToBytes(BigInt(digits), byteLength);
}

function byteLengthForDecimalWidth(width: number): number {
  let estimate = Math.max(1, Math.floor(width / Math.log10(256)));
  while (decimalWidthForBytes(estimate) < width) estimate += 1;
  while (estimate > 1 && decimalWidthForBytes(estimate - 1) >= width) estimate -= 1;
  if (decimalWidthForBytes(estimate) !== width) throw new Error("Unknown numeric frame width");
  return estimate;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, byteLength: number): Uint8Array {
  if (value < 0n) throw new Error("Negative numeric frame value");
  const output = new Uint8Array(byteLength);
  let remaining = value;
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("Numeric frame does not fit target byte length");
  return output;
}
