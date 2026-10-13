import jsQR from "jsqr";
import { qrcodegen } from "./vendor/qrcodegen";
import type { EccLevel, QrSettings, WireMode } from "./types";
import { base45Decode, base45Encode, base45EncodedLength, decimalWidthForBytes, numericDecodeFrame, numericEncodeFrame } from "./wire";

interface QrCapacity {
  maxFrameBytes: number;
  rawByteCapacity: number;
  alphanumericCapacity: number;
  numericCapacity: number;
}

const capacityCache = new Map<string, QrCapacity>();

export function getQrCapacity(settings: Pick<QrSettings, "version" | "ecc" | "wireMode">): QrCapacity {
  const cacheKey = `${settings.version}:${settings.ecc}:${settings.wireMode}`;
  const cached = capacityCache.get(cacheKey);
  if (cached != null) return cached;
  const ecc = toNayukiEcc(settings.ecc);
  const rawByteCapacity = binarySearchCapacity(0, 4096, (length) => {
    const bytes = new Array<number>(length).fill(0);
    qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeBytes(bytes)], ecc, settings.version, settings.version, -1, false);
  });
  const alphanumericCapacity = binarySearchCapacity(0, 9000, (length) => {
    qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeAlphanumeric("A".repeat(length))], ecc, settings.version, settings.version, -1, false);
  });
  const numericCapacity = binarySearchCapacity(0, 10000, (length) => {
    qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeNumeric("0".repeat(length))], ecc, settings.version, settings.version, -1, false);
  });
  const maxFrameBytes =
    settings.wireMode === "raw-byte"
      ? rawByteCapacity
      : settings.wireMode === "base45"
        ? binarySearchCapacity(0, rawByteCapacity + 512, (length) => {
            if (base45EncodedLength(length) > alphanumericCapacity) throw new Error("Too long");
          })
        : binarySearchCapacity(0, rawByteCapacity + 512, (length) => {
            if (decimalWidthForBytes(length) > numericCapacity) throw new Error("Too long");
          });
  const capacity = { maxFrameBytes, rawByteCapacity, alphanumericCapacity, numericCapacity };
  capacityCache.set(cacheKey, capacity);
  return capacity;
}

export function makeQrForFrame(frameBytes: Uint8Array, settings: QrSettings, maxFrameBytes: number): qrcodegen.QrCode {
  const ecc = toNayukiEcc(settings.ecc);
  const segment =
    settings.wireMode === "raw-byte"
      ? qrcodegen.QrSegment.makeBytes(Array.from(frameBytes))
      : settings.wireMode === "base45"
        ? qrcodegen.QrSegment.makeAlphanumeric(base45Encode(frameBytes))
        : qrcodegen.QrSegment.makeNumeric(numericEncodeFrame(frameBytes, maxFrameBytes));
  return qrcodegen.QrCode.encodeSegments([segment], ecc, settings.version, settings.version, -1, false);
}

export function drawQrToCanvas(qr: qrcodegen.QrCode, canvas: HTMLCanvasElement, cellWidth: number, cellHeight: number): void {
  const quietModules = 4;
  const moduleCount = qr.size + quietModules * 2;
  const modulePx = Math.max(1, Math.floor(Math.min(cellWidth, cellHeight) / moduleCount));
  const pixelSize = moduleCount * modulePx;
  canvas.width = pixelSize;
  canvas.height = pixelSize;
  canvas.style.width = `${pixelSize}px`;
  canvas.style.height = `${pixelSize}px`;
  const context = canvas.getContext("2d");
  if (context == null) throw new Error("Canvas 2D context is unavailable");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixelSize, pixelSize);
  context.fillStyle = "#000000";
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) {
        context.fillRect((x + quietModules) * modulePx, (y + quietModules) * modulePx, modulePx, modulePx);
      }
    }
  }
}

export function decodeQrCandidates(imageData: ImageData, inversionAttempts: "dontInvert" | "attemptBoth"): Uint8Array[] {
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts });
  if (code == null) return [];
  const candidates: Uint8Array[] = [];
  if (code.binaryData.length > 0) candidates.push(new Uint8Array(code.binaryData));
  const text = code.data;
  if (text) {
    try {
      candidates.push(base45Decode(text));
    } catch {
      // Not a Base45 QR frame.
    }
    if (/^\d+$/.test(text)) {
      try {
        candidates.push(numericDecodeFrame(text));
      } catch {
        // Not a numeric-b10 QR frame.
      }
    }
  }
  return candidates;
}

function binarySearchCapacity(min: number, max: number, attempt: (length: number) => void): number {
  let low = min;
  let high = max + 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      attempt(mid);
      low = mid;
    } catch {
      high = mid;
    }
  }
  return low;
}

function toNayukiEcc(ecc: EccLevel): qrcodegen.QrCode.Ecc {
  switch (ecc) {
    case "L":
      return qrcodegen.QrCode.Ecc.LOW;
    case "M":
      return qrcodegen.QrCode.Ecc.MEDIUM;
    case "Q":
      return qrcodegen.QrCode.Ecc.QUARTILE;
    case "H":
      return qrcodegen.QrCode.Ecc.HIGH;
  }
}

export function wireLabel(wireMode: WireMode): string {
  if (wireMode === "raw-byte") return "raw-byte";
  if (wireMode === "base45") return "base45";
  return "numeric-b10";
}
