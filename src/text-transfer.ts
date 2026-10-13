import { deflateSync, Inflate } from "fflate";
import { crc16, crc32 } from "./checksums";
import { errorDetail, message, TransferError } from "./i18n";

export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const TEXT_HEADER_BYTES = 36;
const MAGIC = new Uint8Array([0x51, 0x4d, 0x54, 0x32]);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface DocumentMetadata {
  documentId: string;
  compression: 0 | 1;
  totalPages: number;
  originalLength: number;
  encodedLength: number;
  documentCrc: number;
}

export interface PreparedDocument extends DocumentMetadata {
  encoded: Uint8Array;
  payloadCapacity: number;
  characters: number;
}

export interface TextPage extends DocumentMetadata {
  index: number;
  payload: Uint8Array;
}

export interface ReceiveState {
  documentId?: string;
  totalPages: number;
  receivedPages: number;
  missingRanges: string;
  duplicates: number;
  complete: boolean;
  originalLength: number;
  text?: string;
  bytes?: Uint8Array;
}

export function decodeText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TransferError(message("文件不是有效的 UTF-8 文本，请先转换编码。"));
  }
}

export function prepareDocument(bytes: Uint8Array, payloadCapacity: number, id?: Uint8Array): PreparedDocument {
  if (bytes.length === 0) throw new TransferError(message("请输入文字或导入文本文件。"));
  if (bytes.length > MAX_TEXT_BYTES) throw new TransferError(message("文本超过 10 MiB 上限。"));
  if (!Number.isInteger(payloadCapacity) || payloadCapacity < 1 || payloadCapacity > 2917) {
    throw new TransferError(message("二维码容量无效。"));
  }
  const text = decodeText(bytes);
  const compressed = deflateSync(bytes, { level: 9 });
  const compression = compressed.length < bytes.length ? 1 : 0;
  const encoded = compression === 1 ? compressed : bytes.slice();
  const totalPages = Math.ceil(encoded.length / payloadCapacity);
  if (totalPages > 0xffff) throw new TransferError(message("二维码页数超过协议上限。"));
  const identifier = id ?? crypto.getRandomValues(new Uint8Array(8));
  if (identifier.length !== 8) throw new TransferError(message("文档标识无效。"));
  return {
    documentId: toHex(identifier), compression, totalPages,
    originalLength: bytes.length, encodedLength: encoded.length,
    documentCrc: crc32(bytes), encoded, payloadCapacity,
    characters: countCharacters(text)
  };
}

export function countCharacters(text: string): number {
  let count = 0;
  for (const _character of text) count++;
  return count;
}

export function encodePage(document: PreparedDocument, index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= document.totalPages) throw new TransferError(message("页码超出范围。"));
  const payload = document.encoded.subarray(index * document.payloadCapacity, (index + 1) * document.payloadCapacity);
  const frame = new Uint8Array(TEXT_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  frame.set(MAGIC);
  view.setUint8(4, 2);
  view.setUint8(5, document.compression);
  for (let offset = 0; offset < 8; offset++) frame[8 + offset] = Number.parseInt(document.documentId.slice(offset * 2, offset * 2 + 2), 16);
  view.setUint16(16, index);
  view.setUint16(18, document.totalPages);
  view.setUint32(20, document.originalLength);
  view.setUint32(24, document.encodedLength);
  view.setUint32(28, document.documentCrc);
  view.setUint32(32, crc32(payload));
  view.setUint16(6, crc16(frame.subarray(0, TEXT_HEADER_BYTES)));
  frame.set(payload, TEXT_HEADER_BYTES);
  return frame;
}

export function parsePage(frame: Uint8Array): TextPage {
  if (frame.length <= TEXT_HEADER_BYTES || frame.length > 2953 || !MAGIC.every((byte, index) => frame[index] === byte)) {
    throw new TransferError(message("这不是码上传 QMT2 文字二维码。"));
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint8(4) !== 2 || view.getUint8(5) > 1) throw new TransferError(message("不支持的文字二维码版本。"));
  const header = frame.slice(0, TEXT_HEADER_BYTES);
  header[6] = header[7] = 0;
  if (crc16(header) !== view.getUint16(6)) throw new TransferError(message("二维码头部损坏，请重新扫描这一页。"));
  const index = view.getUint16(16);
  const totalPages = view.getUint16(18);
  const originalLength = view.getUint32(20);
  const encodedLength = view.getUint32(24);
  const compression = view.getUint8(5) as 0 | 1;
  const payload = frame.slice(TEXT_HEADER_BYTES);
  if (totalPages === 0 || index >= totalPages || originalLength === 0 || originalLength > MAX_TEXT_BYTES ||
      encodedLength === 0 || encodedLength > MAX_TEXT_BYTES || totalPages > encodedLength ||
      encodedLength > totalPages * 2917 || payload.length > encodedLength ||
      (compression === 0 && originalLength !== encodedLength)) {
    throw new TransferError(message("二维码长度或页数无效。"));
  }
  if (crc32(payload) !== view.getUint32(32)) throw new TransferError(message("二维码正文损坏，请重新扫描这一页。"));
  return {
    documentId: toHex(frame.subarray(8, 16)), compression, index, totalPages,
    originalLength, encodedLength, documentCrc: view.getUint32(28), payload
  };
}

function restoreBytes(encoded: Uint8Array, meta: DocumentMetadata): Uint8Array {
  if (encoded.length !== meta.encodedLength) throw new TransferError(message("接收数据长度不一致，请清空后重新扫描。"));
  let bytes = encoded;
  if (meta.compression === 1) {
    const output = new Uint8Array(meta.originalLength);
    let offset = 0;
    const inflater = new Inflate((chunk) => {
      if (offset + chunk.length > output.length) throw new TransferError(message("解压结果超过声明长度，已拒绝此文档。"));
      output.set(chunk, offset);
      offset += chunk.length;
    });
    // Small compressed chunks bound transient expansion before the output-length check.
    for (let index = 0; index < encoded.length; index += 512) {
      inflater.push(encoded.subarray(index, index + 512), index + 512 >= encoded.length);
    }
    if (offset !== output.length) throw new TransferError(message("解压结果长度不一致。"));
    bytes = output;
  }
  if (bytes.length !== meta.originalLength || crc32(bytes) !== meta.documentCrc) {
    throw new TransferError(message("全文校验失败，请清空后重新扫描。"));
  }
  return bytes;
}

export class TextReceiver {
  private meta?: DocumentMetadata;
  private pages = new Map<number, Uint8Array>();
  private duplicates = 0;
  private result?: { bytes: Uint8Array; text: string };
  private failure?: TransferError;
  private storedLength = 0;

  accept(frame: Uint8Array): { foreign: boolean; state: ReceiveState } {
    const page = parsePage(frame);
    if (this.meta && this.meta.documentId !== page.documentId) return { foreign: true, state: this.snapshot() };
    if (!this.meta) this.meta = page;
    if (["compression", "totalPages", "originalLength", "encodedLength", "documentCrc"].some((key) =>
      page[key as keyof DocumentMetadata] !== this.meta?.[key as keyof DocumentMetadata])) {
      throw new TransferError(message("同一文档的页面信息不一致，已拒绝此页。"));
    }
    const existing = this.pages.get(page.index);
    if (existing) {
      if (existing.length !== page.payload.length || existing.some((byte, index) => byte !== page.payload[index])) {
        throw new TransferError(message("同一页出现不同内容，已拒绝此页。"));
      }
      this.duplicates++;
    } else {
      if (this.storedLength + page.payload.length > this.meta.encodedLength) throw new TransferError(message("接收数据超过声明长度。"));
      this.pages.set(page.index, page.payload);
      this.storedLength += page.payload.length;
    }
    if (this.pages.size === this.meta.totalPages && !this.result) {
      if (this.failure) throw this.failure;
      try {
        const encoded = new Uint8Array(this.storedLength);
        let offset = 0;
        for (let index = 0; index < this.meta.totalPages; index++) {
          const payload = this.pages.get(index)!;
          encoded.set(payload, offset);
          offset += payload.length;
        }
        const bytes = restoreBytes(encoded, this.meta);
        this.result = { bytes, text: decodeText(bytes) };
      } catch (error) {
        this.failure = new TransferError(errorDetail(error, "文档恢复失败。"));
        throw this.failure;
      }
    }
    return { foreign: false, state: this.snapshot() };
  }

  snapshot(): ReceiveState {
    const missing: number[] = [];
    for (let index = 0; index < (this.meta?.totalPages ?? 0); index++) if (!this.pages.has(index)) missing.push(index + 1);
    return {
      documentId: this.meta?.documentId, totalPages: this.meta?.totalPages ?? 0,
      receivedPages: this.pages.size, missingRanges: formatRanges(missing),
      duplicates: this.duplicates, complete: !!this.result,
      originalLength: this.meta?.originalLength ?? 0,
      text: this.result?.text, bytes: this.result?.bytes
    };
  }

  clear(): ReceiveState {
    this.meta = undefined;
    this.pages.clear();
    this.duplicates = this.storedLength = 0;
    this.result = undefined;
    this.failure = undefined;
    return this.snapshot();
  }
}

export function formatRanges(values: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = values[i];
    while (i + 1 < values.length && values[i + 1] === values[i] + 1) i++;
    ranges.push(start === values[i] ? String(start) : `${start}-${values[i]}`);
  }
  return ranges.join(", ");
}

export function parsePageRanges(value: string, totalPages: number): number[] {
  if (!value.trim()) throw new TransferError(message("请输入缺失页码，例如 2, 5-8。"));
  const indexes = new Set<number>();
  for (const part of value.split(/[,，\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new TransferError(message("页码格式无效，例如 2, 5-8。"));
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > totalPages) throw new TransferError(message("页码必须在 1 到 {total} 之间。", { total: totalPages }));
    for (let index = start; index <= end; index++) indexes.add(index - 1);
  }
  if (indexes.size === 0) throw new TransferError(message("请输入缺失页码。"));
  return [...indexes].sort((a, b) => a - b);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
