import { AES_GCM_TAG_BITS, SESSION_ID_BYTES } from "./constants";
import { bytesToHex, toArrayBuffer, utf8Encode } from "./utils";

export async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (!passphrase) throw new Error("Passphrase is required");
  const keyMaterial = await crypto.subtle.importKey("raw", toArrayBuffer(utf8Encode(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export function makeFrameIv(sessionId: Uint8Array, frameIndex: number): Uint8Array {
  if (sessionId.byteLength !== SESSION_ID_BYTES) throw new Error("sessionId must be 8 bytes");
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > 0xffffffff) {
    throw new Error("frameIndex must fit uint32");
  }
  const iv = new Uint8Array(12);
  iv.set(sessionId, 0);
  const view = new DataView(iv.buffer);
  view.setUint32(8, frameIndex, false);
  return iv;
}

export async function encryptAesGcm(plain: Uint8Array, key: CryptoKey, iv: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
      tagLength: AES_GCM_TAG_BITS
    },
    key,
    toArrayBuffer(plain)
  );
  return new Uint8Array(encrypted);
}

export async function decryptAesGcm(payload: Uint8Array, key: CryptoKey, iv: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad),
        tagLength: AES_GCM_TAG_BITS
      },
      key,
      toArrayBuffer(payload)
    );
    return new Uint8Array(decrypted);
  } catch (error) {
    throw new Error("AES-GCM authentication failed", { cause: error });
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}
