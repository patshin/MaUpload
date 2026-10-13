import jsQR from "jsqr";
import { message, TransferError } from "./i18n";
import { qrcodegen } from "./vendor/qrcodegen";

export interface QrMatrix {
  size: number;
  version: number;
  modules: Uint8Array;
}

const capacities = new Map<boolean, number>();

export function textQrCapacity(easier: boolean): number {
  const cached = capacities.get(easier);
  if (cached !== undefined) return cached;
  let low = 0;
  let high = 2954;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      encodeTextQr(new Uint8Array(mid), easier);
      low = mid;
    } catch {
      high = mid;
    }
  }
  capacities.set(easier, low);
  return low;
}

export function encodeTextQr(frame: Uint8Array, easier: boolean): QrMatrix {
  const qr = qrcodegen.QrCode.encodeSegments(
    [qrcodegen.QrSegment.makeBytes(Array.from(frame))],
    easier ? qrcodegen.QrCode.Ecc.MEDIUM : qrcodegen.QrCode.Ecc.LOW,
    1, easier ? 30 : 40, -1, false
  );
  const modules = new Uint8Array(qr.size * qr.size);
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) modules[y * qr.size + x] = qr.getModule(x, y) ? 1 : 0;
  return { size: qr.size, version: qr.version, modules };
}

export function drawTextQr(matrix: QrMatrix, canvas: HTMLCanvasElement, availableSize: number): number {
  const scale = Math.max(1, Math.floor(availableSize / (matrix.size + 8)));
  const width = (matrix.size + 8) * scale;
  canvas.width = canvas.height = width;
  canvas.style.width = canvas.style.height = `${width}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new TransferError(message("无法绘制二维码。"));
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, width);
  context.fillStyle = "#000000";
  for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) {
    if (matrix.modules[y * matrix.size + x]) context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
  }
  return scale;
}

export function decodeTextQr(data: Uint8ClampedArray, width: number, height: number): Uint8Array | null {
  const qr = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
  return qr ? new Uint8Array(qr.binaryData) : null;
}
