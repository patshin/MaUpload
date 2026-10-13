import type { EccLevel, GridMode, QrSettings, WireMode, WireModeId } from "./types";

export const APP_NAME = "qrmax-transfer";
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 32;
export const AES_GCM_TAG_BYTES = 16;
export const AES_GCM_TAG_BITS = 128;
export const SESSION_ID_BYTES = 8;
export const SALT_BYTES = 16;
export const DEFAULT_ITERATIONS = 600_000;
export const DEFAULT_SAFETY_MARGIN = 24;
export const META_REPEAT_COUNT = 10;
export const META_INSERT_INTERVAL = 50;
export const LARGE_SELECTION_BYTES = 200 * 1024 * 1024;
export const MAGIC = new Uint8Array([0x51, 0x52, 0x54, 0x31]);

export const WIRE_MODE_TO_ID: Record<WireMode, WireModeId> = {
  "raw-byte": 0,
  "numeric-b10": 1,
  base45: 2
};

export const ID_TO_WIRE_MODE: Record<WireModeId, WireMode> = {
  0: "raw-byte",
  1: "numeric-b10",
  2: "base45"
};

export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "target",
  ".DS_Store",
  "Thumbs.db"
];

export const PROFILE_SETTINGS: Record<string, Omit<QrSettings, "wireMode" | "safetyMargin">> = {
  safe: {
    version: 30,
    ecc: "M",
    grid: "1x1",
    frameMs: 400
  },
  fast: {
    version: 40,
    ecc: "L",
    grid: "2x1",
    frameMs: 200
  },
  extreme: {
    version: 40,
    ecc: "L",
    grid: "2x2",
    frameMs: 150
  }
};

export function gridCellCount(grid: GridMode): number {
  if (grid === "1x1") return 1;
  if (grid === "2x1") return 2;
  return 4;
}

export function assertEcc(value: string): EccLevel {
  if (value === "L" || value === "M" || value === "Q" || value === "H") return value;
  throw new Error(`Unsupported ECC level: ${value}`);
}

export function assertGrid(value: string): GridMode {
  if (value === "1x1" || value === "2x1" || value === "2x2") return value;
  throw new Error(`Unsupported grid: ${value}`);
}

export function assertWireMode(value: string): WireMode {
  if (value === "raw-byte" || value === "base45" || value === "numeric-b10") return value;
  throw new Error(`Unsupported wire mode: ${value}`);
}
