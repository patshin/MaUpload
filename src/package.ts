import { zipSync } from "fflate";
import {
  AES_GCM_TAG_BYTES,
  AES_GCM_TAG_BITS,
  APP_NAME,
  HEADER_SIZE,
  LARGE_SELECTION_BYTES,
  PROTOCOL_VERSION,
  SALT_BYTES,
  SESSION_ID_BYTES
} from "./constants";
import { deriveAesKey, sha256Hex } from "./crypto";
import { makeDataFrame, makeMetaFrame } from "./protocol";
import { getQrCapacity } from "./qr";
import type { PackageBuild, QrSettings, SourceEntry, SourcePlan, TransferMeta } from "./types";
import {
  bytesToBase64,
  humanBytes,
  matchesExclude,
  normalizeArchivePath,
  timestampForPath,
  utf8Encode
} from "./utils";

export interface DryRunStats {
  fileCount: number;
  excludedCount: number;
  totalBytes: number;
  estimatedZipBytes: number;
  estimatedFrames: number;
  estimatedLoopMs: number;
  chunkPlainSize: number;
  capacityBytes: number;
  warning?: string;
}

export async function collectSources(input: {
  files: FileList | null;
  folderFiles: FileList | null;
  pastedText: string;
  excludePatterns: readonly string[];
}): Promise<SourcePlan> {
  const entries: SourceEntry[] = [];
  for (const file of fileListToArray(input.files)) entries.push(makeSourceEntry(file));
  for (const file of fileListToArray(input.folderFiles)) entries.push(makeSourceEntry(file));
  if (input.pastedText.length > 0) {
    const path = `pasted/${timestampForPath()}.txt`;
    const file = new File([input.pastedText], path, { type: "text/plain" });
    entries.push({ path, file, size: utf8Encode(input.pastedText).byteLength });
  }
  const uniqueEntries = dedupeEntries(entries);
  const included: SourceEntry[] = [];
  const excluded: SourceEntry[] = [];
  for (const entry of uniqueEntries) {
    if (matchesExclude(entry.path, input.excludePatterns)) excluded.push(entry);
    else included.push(entry);
  }
  return {
    included,
    excluded,
    pastedTextBytes: utf8Encode(input.pastedText).byteLength,
    totalBytes: included.reduce((sum, entry) => sum + entry.size, 0)
  };
}

export function estimateDryRun(plan: SourcePlan, settings: QrSettings): DryRunStats {
  const capacity = getQrCapacity(settings);
  const chunkPlainSize = capacity.maxFrameBytes - HEADER_SIZE - AES_GCM_TAG_BYTES - settings.safetyMargin;
  if (chunkPlainSize <= 0) throw new Error("QR capacity is too small for encrypted frames");
  const estimatedZipBytes = Math.ceil(plan.totalBytes * 0.92 + Math.max(256, plan.included.length * 96));
  const estimatedFrames = Math.max(1, Math.ceil(estimatedZipBytes / chunkPlainSize));
  const gridCells = settings.grid === "1x1" ? 1 : settings.grid === "2x1" ? 2 : 4;
  const metaFramesPerLoop = 10 + Math.ceil(estimatedFrames / 50);
  const estimatedLoopMs = Math.ceil((estimatedFrames + metaFramesPerLoop) / gridCells) * settings.frameMs;
  const warning =
    plan.totalBytes > LARGE_SELECTION_BYTES
      ? `Selected data is ${humanBytes(plan.totalBytes)}. Split batches above 200 MB to avoid browser memory pressure.`
      : plan.totalBytes > 64 * 1024 * 1024
        ? "Large in-memory zip build. Keep other browser tabs quiet while packaging."
        : undefined;
  return {
    fileCount: plan.included.length,
    excludedCount: plan.excluded.length,
    totalBytes: plan.totalBytes,
    estimatedZipBytes,
    estimatedFrames,
    estimatedLoopMs,
    chunkPlainSize,
    capacityBytes: capacity.maxFrameBytes,
    warning
  };
}

export async function buildPackage(input: {
  plan: SourcePlan;
  settings: QrSettings;
  passphrase: string;
  iterations: number;
  onProgress?: (label: string, value: number) => void;
}): Promise<PackageBuild> {
  if (input.plan.included.length === 0) throw new Error("Select files, a folder, or pasted text first");
  const capacity = getQrCapacity(input.settings);
  const chunkPlainSize = capacity.maxFrameBytes - HEADER_SIZE - AES_GCM_TAG_BYTES - input.settings.safetyMargin;
  if (chunkPlainSize <= 0) throw new Error("QR capacity is too small for encrypted frames");
  input.onProgress?.("Reading files", 8);
  const zipBytes = await makeZip(input.plan.included);
  input.onProgress?.("Hashing zip", 20);
  const zipSha256Hex = await sha256Hex(zipBytes);
  const sessionId = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const totalFrames = Math.max(1, Math.ceil(zipBytes.byteLength / chunkPlainSize));
  const meta: TransferMeta = {
    app: APP_NAME,
    protocolVersion: PROTOCOL_VERSION,
    sessionIdHex: Array.from(sessionId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    createdAt: new Date().toISOString(),
    package: "zip",
    archiveName: "recovered.zip",
    zipCipherMode: "AES-GCM",
    zipSha256Hex,
    totalZipPlainBytes: zipBytes.byteLength,
    totalFrames,
    chunkPlainSize,
    kdf: {
      name: "PBKDF2-SHA256",
      hash: "SHA-256",
      iterations: input.iterations,
      saltBase64: bytesToBase64(salt)
    },
    cipher: {
      name: "AES-GCM",
      keyBits: 256,
      tagLength: AES_GCM_TAG_BITS,
      iv: "sessionId8bytes + frameIndexUint32BE"
    },
    qr: {
      wireMode: input.settings.wireMode,
      version: input.settings.version,
      ecc: input.settings.ecc,
      grid: input.settings.grid,
      frameMs: input.settings.frameMs
    }
  };
  const metaFrame = makeMetaFrame(meta, sessionId);
  if (metaFrame.bytes.byteLength > capacity.maxFrameBytes) {
    throw new Error("Meta frame is too large for selected QR settings");
  }
  input.onProgress?.("Deriving encryption key", 35);
  const key = await deriveAesKey(input.passphrase, salt, input.iterations);
  const dataFrames = [];
  for (let index = 0; index < totalFrames; index += 1) {
    const start = index * chunkPlainSize;
    const end = Math.min(zipBytes.byteLength, start + chunkPlainSize);
    const frame = await makeDataFrame(zipBytes.slice(start, end), key, sessionId, index, totalFrames, input.settings.wireMode);
    if (frame.bytes.byteLength > capacity.maxFrameBytes) throw new Error(`Frame ${index} exceeds selected QR capacity`);
    dataFrames.push(frame);
    if (index % 8 === 0 || index === totalFrames - 1) {
      input.onProgress?.(`Encrypting frame ${index + 1}/${totalFrames}`, 35 + Math.round(((index + 1) / totalFrames) * 60));
    }
  }
  input.onProgress?.("Package ready", 100);
  return {
    meta,
    metaFrame,
    dataFrames,
    sessionId,
    chunkPlainSize,
    qrCapacityBytes: capacity.maxFrameBytes,
    zipBytes
  };
}

async function makeZip(entries: readonly SourceEntry[]): Promise<Uint8Array> {
  const zippable: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const buffer = await entry.file.arrayBuffer();
    zippable[entry.path] = new Uint8Array(buffer);
  }
  return zipSync(zippable, { level: 6 });
}

function makeSourceEntry(file: File): SourceEntry {
  const withPath = file as File & { webkitRelativePath?: string };
  const rawPath = withPath.webkitRelativePath && withPath.webkitRelativePath.length > 0 ? withPath.webkitRelativePath : file.name;
  return {
    path: normalizeArchivePath(rawPath),
    file,
    size: file.size
  };
}

function fileListToArray(fileList: FileList | null): File[] {
  return fileList == null ? [] : Array.from(fileList);
}

function dedupeEntries(entries: readonly SourceEntry[]): SourceEntry[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = seen.get(entry.path) ?? 0;
    seen.set(entry.path, count + 1);
    if (count === 0) return entry;
    const dot = entry.path.lastIndexOf(".");
    const suffix = `-${count + 1}`;
    const path =
      dot > 0
        ? `${entry.path.slice(0, dot)}${suffix}${entry.path.slice(dot)}`
        : `${entry.path}${suffix}`;
    return { ...entry, path };
  });
}
