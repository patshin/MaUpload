import { DEFAULT_EXCLUDES } from "./constants";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex length");
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${remainingSeconds}s`;
  return `${hours}h ${remainingMinutes}m`;
}

export function timestampForPath(date = new Date()): string {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];
  return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}-${parts[5]}`;
}

export function normalizeArchivePath(path: string): string {
  const clean = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return clean
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[\u0000-\u001f]/g, "_"))
    .join("/");
}

export function readExcludePatterns(value: string): string[] {
  const custom = value
    .split(/\r?\n|,/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  return custom.length > 0 ? custom : DEFAULT_EXCLUDES;
}

export function matchesExclude(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizeArchivePath(path);
  const segments = normalized.split("/");
  return patterns.some((pattern) => {
    const clean = normalizeArchivePath(pattern);
    if (!clean) return false;
    if (clean.includes("*")) return wildcardToRegExp(clean).test(normalized);
    return normalized === clean || segments.includes(clean) || normalized.startsWith(`${clean}/`) || normalized.includes(`/${clean}/`);
  });
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`(^|/)${escaped}($|/)`);
}

export function compactRanges(indexes: readonly number[]): string {
  if (indexes.length === 0) return "";
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let offset = 1; offset < sorted.length; offset += 1) {
    const current = sorted[offset];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = current;
    previous = current;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(",");
}

export function parseRanges(value: string, totalFrames: number): number[] {
  const selected = new Set<number>();
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(trimmed);
    if (!rangeMatch) throw new Error(`Invalid range token: ${trimmed}`);
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] == null ? start : Number(rangeMatch[2]);
    if (start > end) throw new Error(`Invalid descending range: ${trimmed}`);
    if (start < 0 || end >= totalFrames) throw new Error(`Range out of bounds: ${trimmed}`);
    for (let index = start; index <= end; index += 1) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b);
}

export function setButtonBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.classList.toggle("busy", busy);
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
