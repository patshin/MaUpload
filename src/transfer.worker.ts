import { encodePage, prepareDocument, TextReceiver, TEXT_HEADER_BYTES, type PreparedDocument } from "./text-transfer";
import { decodeTextQr, encodeTextQr, textQrCapacity, type QrMatrix } from "./text-qr";
import { errorDetail, message, TransferError } from "./i18n";

export interface SendSummary {
  documentId: string;
  characters: number;
  originalLength: number;
  encodedLength: number;
  totalPages: number;
  compression: 0 | 1;
  payloadCapacity: number;
}

let document: PreparedDocument | undefined;
let easier = false;
const receiver = new TextReceiver();
const cache = new Map<number, QrMatrix>();

self.onmessage = (event: MessageEvent<{ id: number; type: string; payload: any }>) => {
  const { id, type, payload } = event.data;
  try {
    let result: unknown;
    switch (type) {
      case "prepare": {
        easier = payload.easier;
        document = prepareDocument(payload.bytes, textQrCapacity(easier) - TEXT_HEADER_BYTES);
        cache.clear();
        const { encoded: _encoded, ...summary } = document;
        result = summary;
        break;
      }
      case "qr": {
        if (!document || document.documentId !== payload.documentId) throw new TransferError(message("文档已更新。"));
        result = cache.get(payload.index);
        if (!result) {
          const matrix = encodeTextQr(encodePage(document, payload.index), easier);
          cache.set(payload.index, matrix);
          while (cache.size > 3) cache.delete(cache.keys().next().value!);
          result = matrix;
        }
        break;
      }
      case "resetSender": document = undefined; cache.clear(); result = null; break;
      case "decode": result = decodeTextQr(payload.data, payload.width, payload.height); break;
      case "accept": result = receiver.accept(payload.bytes); break;
      case "snapshot": result = receiver.snapshot(); break;
      case "clear": result = receiver.clear(); break;
      default: throw new TransferError(message("未知的处理请求。"));
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: errorDetail(error) });
  }
};
