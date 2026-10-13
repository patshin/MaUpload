import {
  AES_GCM_TAG_BYTES,
  APP_NAME,
  HEADER_SIZE,
  ID_TO_WIRE_MODE,
  MAGIC,
  PROTOCOL_VERSION,
  WIRE_MODE_TO_ID
} from "./constants";
import { crc16, crc32 } from "./checksums";
import { decryptAesGcm, encryptAesGcm, makeFrameIv } from "./crypto";
import type { FrameKind, FrameKindId, ParsedFrame, RawFrame, TransferMeta, WireMode } from "./types";
import { bytesToHex, concatBytes, invariant, utf8Decode, utf8Encode } from "./utils";

export function makeMetaFrame(meta: TransferMeta, sessionId: Uint8Array): RawFrame {
  invariant(meta.app === APP_NAME, "Invalid app name");
  const payload = utf8Encode(JSON.stringify(meta));
  const header = createHeader({
    type: 0,
    wireMode: meta.qr.wireMode,
    sessionId,
    frameIndex: 0,
    totalFrames: meta.totalFrames,
    payload
  });
  return {
    bytes: concatBytes([header, payload]),
    type: "meta",
    frameIndex: 0,
    totalFrames: meta.totalFrames,
    sessionIdHex: bytesToHex(sessionId),
    wireMode: meta.qr.wireMode
  };
}

export async function makeDataFrame(
  chunk: Uint8Array,
  key: CryptoKey,
  sessionId: Uint8Array,
  frameIndex: number,
  totalFrames: number,
  wireMode: WireMode
): Promise<RawFrame> {
  const predictedPayloadLen = chunk.byteLength + AES_GCM_TAG_BYTES;
  const aadHeader = createHeader({
    type: 1,
    wireMode,
    sessionId,
    frameIndex,
    totalFrames,
    payloadLen: predictedPayloadLen,
    payloadCrc32: 0,
    writeHeaderCrc: false
  });
  const aad = aadHeader.slice(0, 26);
  const payload = await encryptAesGcm(chunk, key, makeFrameIv(sessionId, frameIndex), aad);
  invariant(payload.byteLength === predictedPayloadLen, "Unexpected AES-GCM payload length");
  const header = createHeader({
    type: 1,
    wireMode,
    sessionId,
    frameIndex,
    totalFrames,
    payload
  });
  return {
    bytes: concatBytes([header, payload]),
    type: "data",
    frameIndex,
    totalFrames,
    sessionIdHex: bytesToHex(sessionId),
    wireMode
  };
}

export function parseFrame(candidate: Uint8Array): ParsedFrame {
  if (candidate.byteLength < HEADER_SIZE) throw new Error("Frame is shorter than header");
  const header = candidate.slice(0, HEADER_SIZE);
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (header[index] !== MAGIC[index]) throw new Error("Frame magic mismatch");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const version = view.getUint8(4);
  if (version !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${version}`);
  const typeId = view.getUint8(5) as FrameKindId;
  if (typeId !== 0 && typeId !== 1) throw new Error(`Unsupported frame type: ${typeId}`);
  const wireModeId = view.getUint8(7);
  if (wireModeId !== 0 && wireModeId !== 1 && wireModeId !== 2) throw new Error(`Unsupported wire mode id: ${wireModeId}`);
  const payloadLen = view.getUint16(24, false);
  const expectedLength = HEADER_SIZE + payloadLen;
  if (candidate.byteLength < expectedLength) throw new Error("Frame payload is truncated");
  const rawBytes = candidate.slice(0, expectedLength);
  const rawHeader = rawBytes.slice(0, HEADER_SIZE);
  const payload = rawBytes.slice(HEADER_SIZE);
  const expectedHeaderCrc = view.getUint16(30, false);
  const headerForCrc = rawHeader.slice();
  headerForCrc[30] = 0;
  headerForCrc[31] = 0;
  if (crc16(headerForCrc) !== expectedHeaderCrc) throw new Error("Header CRC16 mismatch");
  const expectedPayloadCrc = view.getUint32(26, false);
  if (crc32(payload) !== expectedPayloadCrc) throw new Error("Payload CRC32 mismatch");
  const sessionId = rawHeader.slice(8, 16);
  return {
    bytes: rawBytes,
    header: rawHeader,
    payload,
    type: typeId === 0 ? "meta" : "data",
    frameIndex: view.getUint32(16, false),
    totalFrames: view.getUint32(20, false),
    sessionIdHex: bytesToHex(sessionId),
    wireMode: ID_TO_WIRE_MODE[wireModeId]
  };
}

export function parseMetaPayload(frame: ParsedFrame): TransferMeta {
  if (frame.type !== "meta") throw new Error("Not a meta frame");
  const value = JSON.parse(utf8Decode(frame.payload)) as TransferMeta;
  if (value.app !== APP_NAME || value.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported meta frame");
  if (value.sessionIdHex !== frame.sessionIdHex) throw new Error("Meta session mismatch");
  return value;
}

export async function decryptDataFrame(frame: ParsedFrame, key: CryptoKey): Promise<Uint8Array> {
  if (frame.type !== "data") throw new Error("Not a data frame");
  const sessionId = frame.header.slice(8, 16);
  const aad = frame.header.slice(0, 26);
  return decryptAesGcm(frame.payload, key, makeFrameIv(sessionId, frame.frameIndex), aad);
}

interface HeaderInput {
  type: FrameKindId;
  wireMode: WireMode;
  sessionId: Uint8Array;
  frameIndex: number;
  totalFrames: number;
  payload?: Uint8Array;
  payloadLen?: number;
  payloadCrc32?: number;
  writeHeaderCrc?: boolean;
}

function createHeader(input: HeaderInput): Uint8Array {
  const payloadLen = input.payload?.byteLength ?? input.payloadLen;
  if (payloadLen == null) throw new Error("payloadLen is required");
  if (payloadLen > 0xffff) throw new Error("Payload is too large for FrameHeaderV1");
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  const view = new DataView(header.buffer);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, input.type);
  view.setUint8(6, 0);
  view.setUint8(7, WIRE_MODE_TO_ID[input.wireMode]);
  header.set(input.sessionId, 8);
  view.setUint32(16, input.frameIndex, false);
  view.setUint32(20, input.totalFrames, false);
  view.setUint16(24, payloadLen, false);
  view.setUint32(26, input.payload == null ? input.payloadCrc32 ?? 0 : crc32(input.payload), false);
  if (input.writeHeaderCrc !== false) {
    view.setUint16(30, 0, false);
    view.setUint16(30, crc16(header), false);
  }
  return header;
}

export function frameKindFromType(type: FrameKind): FrameKindId {
  return type === "meta" ? 0 : 1;
}
