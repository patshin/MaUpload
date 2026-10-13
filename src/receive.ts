import { base64ToBytes, compactRanges, concatBytes, humanBytes, toArrayBuffer } from "./utils";
import { decryptDataFrame, parseFrame, parseMetaPayload } from "./protocol";
import { decodeQrCandidates } from "./qr";
import { deriveAesKey, sha256Hex } from "./crypto";
import { clearStoredSession, getStoredFrames, putStoredFrame, saveStoredSession } from "./storage";
import type { ParsedFrame, ReceiveGridMode, StoredFrameRecord, TransferMeta } from "./types";

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{
        description: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle>;
  }
}

interface FileSystemFileHandle {
  createWritable: () => Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream {
  write: (data: BlobPart) => Promise<void>;
  close: () => Promise<void>;
}

export interface ReceiveSnapshot {
  sessionId: string | undefined;
  meta: TransferMeta | undefined;
  totalFrames: number;
  receivedFrames: number;
  missingRanges: string;
  duplicateCount: number;
  errorCount: number;
  decodeFps: number;
  status: string;
  complete: boolean;
}

export class ReceiveController {
  private stream: MediaStream | undefined;
  private raf = 0;
  private running = false;
  private activeSessionId: string | undefined;
  private meta: TransferMeta | undefined;
  private totalFrames = 0;
  private readonly frames = new Map<number, StoredFrameRecord>();
  private readonly loadedSessions = new Set<string>();
  private duplicateCount = 0;
  private errorCount = 0;
  private decodeTicks: number[] = [];
  private status = "Waiting";

  public constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly getGridMode: () => ReceiveGridMode,
    private readonly getInversionMode: () => "dontInvert" | "attemptBoth",
    private readonly onUpdate: (snapshot: ReceiveSnapshot) => void
  ) {}

  public async start(deviceId: string | undefined): Promise<void> {
    this.stop();
    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.status = "Scanning";
    this.emit();
    this.scanLoop();
  }

  public stop(): void {
    this.running = false;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.stream != null) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = undefined;
    }
    this.video.srcObject = null;
    if (this.status === "Scanning") this.status = "Stopped";
    this.emit();
  }

  public async clearCurrentSession(): Promise<void> {
    if (this.activeSessionId != null) await clearStoredSession(this.activeSessionId);
    this.activeSessionId = undefined;
    this.meta = undefined;
    this.totalFrames = 0;
    this.frames.clear();
    this.loadedSessions.clear();
    this.duplicateCount = 0;
    this.errorCount = 0;
    this.status = "Session cleared";
    this.emit();
  }

  public async recover(passphrase: string): Promise<void> {
    if (this.meta == null || this.activeSessionId == null) throw new Error("Meta frame is required before recovery");
    if (this.frames.size < this.meta.totalFrames) throw new Error("Not all frames are present");
    this.status = "Deriving key";
    this.emit();
    const key = await deriveAesKey(passphrase, base64ToBytes(this.meta.kdf.saltBase64), this.meta.kdf.iterations);
    const parts: Uint8Array[] = [];
    for (let index = 0; index < this.meta.totalFrames; index += 1) {
      const record = this.frames.get(index);
      if (record == null) throw new Error(`Missing frame ${index}`);
      const parsed = storedRecordToParsedFrame(record);
      parts.push(await decryptDataFrame(parsed, key));
      if (index % 12 === 0) {
        this.status = `Decrypting ${index + 1}/${this.meta.totalFrames}`;
        this.emit();
      }
    }
    const zipBytes = concatBytes(parts);
    if (zipBytes.byteLength !== this.meta.totalZipPlainBytes) {
      throw new Error(`Recovered zip size mismatch: ${humanBytes(zipBytes.byteLength)}`);
    }
    this.status = "Verifying SHA-256";
    this.emit();
    const hash = await sha256Hex(zipBytes);
    if (hash !== this.meta.zipSha256Hex) throw new Error("Recovered zip SHA-256 mismatch");
    await saveRecoveredZip(zipBytes);
    this.status = "Recovered recovered.zip";
    this.emit();
  }

  private scanLoop(): void {
    if (!this.running) return;
    this.scanOnce();
    this.raf = requestAnimationFrame(() => this.scanLoop());
  }

  private scanOnce(): void {
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (context == null) return;
    context.drawImage(this.video, 0, 0, width, height);
    for (const rect of cropRects(this.getGridMode(), width, height)) {
      const imageData = context.getImageData(rect.x, rect.y, rect.width, rect.height);
      const candidates = decodeQrCandidates(imageData, this.getInversionMode());
      for (const candidate of candidates) {
        try {
          const frame = parseFrame(candidate);
          void this.processFrame(frame);
          this.noteDecodeTick();
        } catch {
          this.errorCount += 1;
        }
      }
    }
    this.emit();
  }

  private async processFrame(frame: ParsedFrame): Promise<void> {
    if (this.activeSessionId != null && frame.sessionIdHex !== this.activeSessionId) return;
    if (this.activeSessionId == null) this.activeSessionId = frame.sessionIdHex;
    this.totalFrames = Math.max(this.totalFrames, frame.totalFrames);
    if (frame.type === "meta") {
      const meta = parseMetaPayload(frame);
      this.meta = meta;
      this.totalFrames = meta.totalFrames;
      await saveStoredSession(meta);
      await this.loadStoredFrames(meta.sessionIdHex);
      this.status = "Meta received";
      this.emit();
      return;
    }
    if (this.frames.has(frame.frameIndex)) {
      this.duplicateCount += 1;
      return;
    }
    const record: StoredFrameRecord = {
      key: `${frame.sessionIdHex}:${frame.frameIndex}`,
      sessionId: frame.sessionIdHex,
      frameIndex: frame.frameIndex,
      totalFrames: frame.totalFrames,
      header: toArrayBuffer(frame.header),
      payload: toArrayBuffer(frame.payload),
      wireMode: frame.wireMode,
      receivedAt: Date.now()
    };
    this.frames.set(frame.frameIndex, record);
    await putStoredFrame({
      sessionId: frame.sessionIdHex,
      frameIndex: frame.frameIndex,
      totalFrames: frame.totalFrames,
      header: frame.header,
      payload: frame.payload,
      wireMode: frame.wireMode
    });
    this.status = this.frames.size >= this.totalFrames && this.meta != null ? "All frames received" : "Receiving";
    this.emit();
  }

  private async loadStoredFrames(sessionId: string): Promise<void> {
    if (this.loadedSessions.has(sessionId)) return;
    this.loadedSessions.add(sessionId);
    const records = await getStoredFrames(sessionId);
    for (const record of records) {
      if (!this.frames.has(record.frameIndex)) this.frames.set(record.frameIndex, record);
    }
  }

  private noteDecodeTick(): void {
    const now = performance.now();
    this.decodeTicks.push(now);
    this.decodeTicks = this.decodeTicks.filter((tick) => now - tick < 2000);
  }

  private emit(): void {
    const missing: number[] = [];
    const total = this.meta?.totalFrames ?? this.totalFrames;
    for (let index = 0; index < total; index += 1) {
      if (!this.frames.has(index)) missing.push(index);
    }
    this.onUpdate({
      sessionId: this.activeSessionId,
      meta: this.meta,
      totalFrames: total,
      receivedFrames: this.frames.size,
      missingRanges: compactRanges(missing),
      duplicateCount: this.duplicateCount,
      errorCount: this.errorCount,
      decodeFps: this.decodeTicks.length / 2,
      status: this.status,
      complete: total > 0 && this.frames.size >= total && this.meta != null
    });
  }
}

export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}

function cropRects(mode: ReceiveGridMode, width: number, height: number): Array<{ x: number; y: number; width: number; height: number }> {
  const rects = [{ x: 0, y: 0, width, height }];
  const add2x1 = mode === "auto" || mode === "2x1";
  const add2x2 = mode === "auto" || mode === "2x2";
  if (add2x1) {
    const cellWidth = Math.floor(width / 2);
    rects.push({ x: 0, y: 0, width: cellWidth, height });
    rects.push({ x: cellWidth, y: 0, width: width - cellWidth, height });
  }
  if (add2x2) {
    const cellWidth = Math.floor(width / 2);
    const cellHeight = Math.floor(height / 2);
    rects.push({ x: 0, y: 0, width: cellWidth, height: cellHeight });
    rects.push({ x: cellWidth, y: 0, width: width - cellWidth, height: cellHeight });
    rects.push({ x: 0, y: cellHeight, width: cellWidth, height: height - cellHeight });
    rects.push({ x: cellWidth, y: cellHeight, width: width - cellWidth, height: height - cellHeight });
  }
  return rects;
}

function storedRecordToParsedFrame(record: StoredFrameRecord): ParsedFrame {
  const header = new Uint8Array(record.header);
  const payload = new Uint8Array(record.payload);
  return parseFrame(concatBytes([header, payload]));
}

async function saveRecoveredZip(bytes: Uint8Array): Promise<void> {
  if (window.showSaveFilePicker != null) {
    const handle = await window.showSaveFilePicker({
      suggestedName: "recovered.zip",
      types: [
        {
          description: "ZIP archive",
          accept: { "application/zip": [".zip"] }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([toArrayBuffer(bytes)], { type: "application/zip" }));
    await writable.close();
    return;
  }
  const blob = new Blob([toArrayBuffer(bytes)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "recovered.zip";
  anchor.click();
  URL.revokeObjectURL(url);
}
