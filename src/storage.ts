import type { StoredFrameRecord, TransferMeta, WireMode } from "./types";
import { toArrayBuffer } from "./utils";

const DB_NAME = "qrmax-transfer";
const DB_VERSION = 1;
const FRAME_STORE = "frames";
const SESSION_STORE = "sessions";

let dbPromise: Promise<IDBDatabase> | undefined;

export function openTransferDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FRAME_STORE)) {
        const frames = db.createObjectStore(FRAME_STORE, { keyPath: "key" });
        frames.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "sessionId" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

export async function putStoredFrame(input: {
  sessionId: string;
  frameIndex: number;
  totalFrames: number;
  header: Uint8Array;
  payload: Uint8Array;
  wireMode: WireMode;
}): Promise<void> {
  const db = await openTransferDb();
  const record: StoredFrameRecord = {
    key: `${input.sessionId}:${input.frameIndex}`,
    sessionId: input.sessionId,
    frameIndex: input.frameIndex,
    totalFrames: input.totalFrames,
    header: toArrayBuffer(input.header),
    payload: toArrayBuffer(input.payload),
    wireMode: input.wireMode,
    receivedAt: Date.now()
  };
  await txDone(writeStore(db, FRAME_STORE).put(record));
}

export async function getStoredFrames(sessionId: string): Promise<StoredFrameRecord[]> {
  const db = await openTransferDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FRAME_STORE, "readonly");
    const index = tx.objectStore(FRAME_STORE).index("sessionId");
    const request = index.getAll(sessionId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as StoredFrameRecord[]);
  });
}

export async function saveStoredSession(meta: TransferMeta): Promise<void> {
  const db = await openTransferDb();
  await txDone(
    writeStore(db, SESSION_STORE).put({
      sessionId: meta.sessionIdHex,
      meta,
      updatedAt: Date.now()
    })
  );
}

export async function clearStoredSession(sessionId: string): Promise<void> {
  const db = await openTransferDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([FRAME_STORE, SESSION_STORE], "readwrite");
    const frameStore = tx.objectStore(FRAME_STORE);
    const index = frameStore.index("sessionId");
    const cursorRequest = index.openCursor(sessionId);
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor == null) return;
      cursor.delete();
      cursor.continue();
    };
    tx.objectStore(SESSION_STORE).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function writeStore(db: IDBDatabase, storeName: string): IDBObjectStore {
  return db.transaction(storeName, "readwrite").objectStore(storeName);
}

function txDone(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = request.transaction;
    request.onerror = () => reject(request.error);
    if (tx == null) {
      request.onsuccess = () => resolve();
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
