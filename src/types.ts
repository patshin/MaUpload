export type WireMode = "raw-byte" | "numeric-b10" | "base45";
export type WireModeId = 0 | 1 | 2;
export type FrameKind = "meta" | "data";
export type FrameKindId = 0 | 1;
export type EccLevel = "L" | "M" | "Q" | "H";
export type GridMode = "1x1" | "2x1" | "2x2";
export type ReceiveGridMode = GridMode | "auto";

export interface QrSettings {
  wireMode: WireMode;
  version: number;
  ecc: EccLevel;
  grid: GridMode;
  frameMs: number;
  safetyMargin: number;
}

export interface TransferMeta {
  app: "qrmax-transfer";
  protocolVersion: 1;
  sessionIdHex: string;
  createdAt: string;
  package: "zip";
  archiveName: "recovered.zip";
  zipCipherMode: "AES-GCM";
  zipSha256Hex: string;
  totalZipPlainBytes: number;
  totalFrames: number;
  chunkPlainSize: number;
  kdf: {
    name: "PBKDF2-SHA256";
    hash: "SHA-256";
    iterations: number;
    saltBase64: string;
  };
  cipher: {
    name: "AES-GCM";
    keyBits: 256;
    tagLength: 128;
    iv: "sessionId8bytes + frameIndexUint32BE";
  };
  qr: {
    wireMode: WireMode;
    version: number;
    ecc: EccLevel;
    grid: GridMode;
    frameMs: number;
  };
}

export interface RawFrame {
  bytes: Uint8Array;
  type: FrameKind;
  frameIndex: number;
  totalFrames: number;
  sessionIdHex: string;
  wireMode: WireMode;
}

export interface ParsedFrame extends RawFrame {
  payload: Uint8Array;
  header: Uint8Array;
}

export interface PackageBuild {
  meta: TransferMeta;
  metaFrame: RawFrame;
  dataFrames: RawFrame[];
  sessionId: Uint8Array;
  chunkPlainSize: number;
  qrCapacityBytes: number;
  zipBytes: Uint8Array;
}

export interface SourceEntry {
  path: string;
  file: File;
  size: number;
}

export interface SourcePlan {
  included: SourceEntry[];
  excluded: SourceEntry[];
  pastedTextBytes: number;
  totalBytes: number;
}

export interface StoredFrameRecord {
  key: string;
  sessionId: string;
  frameIndex: number;
  totalFrames: number;
  header: ArrayBuffer;
  payload: ArrayBuffer;
  wireMode: WireMode;
  receivedAt: number;
}
