import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { deflateSync } from "fflate";

let server;
let core;
let qr;
let checksums;
let i18n;
const encoder = new TextEncoder();
const identifier = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, hmr: false }, appType: "custom" });
  core = await server.ssrLoadModule("/src/text-transfer.ts");
  qr = await server.ssrLoadModule("/src/text-qr.ts");
  checksums = await server.ssrLoadModule("/src/checksums.ts");
  i18n = await server.ssrLoadModule("/src/i18n.ts");
});
after(async () => { await server?.close(); });

function documentFor(text, capacity = 2917, id = identifier) {
  return core.prepareDocument(encoder.encode(text), capacity, id);
}
function receiveAll(document, order) {
  const receiver = new core.TextReceiver();
  for (const index of order ?? Array.from({ length: document.totalPages }, (_, i) => i)) receiver.accept(core.encodePage(document, index));
  return receiver.snapshot();
}
function seededText(length) {
  let seed = 0x12345678;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-={}[];:,.?";
  let text = "";
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    text += alphabet[(seed >>> 0) % alphabet.length];
  }
  return text;
}
function rewriteHeader(frame, modify) {
  const result = frame.slice();
  const view = new DataView(result.buffer);
  modify(view);
  view.setUint16(6, 0);
  view.setUint16(6, checksums.crc16(result.subarray(0, 36)));
  return result;
}
function raster(matrix, scale = 3) {
  const width = (matrix.size + 8) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) {
    if (!matrix.modules[y * matrix.size + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 0;
    }
  }
  return { data, width };
}

test("all translations retain the same named placeholders", () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [chinese, english] of Object.entries(i18n.english)) {
    assert.ok(english.trim());
    assert.deepEqual(placeholders(chinese), placeholders(english), chinese);
    assert.equal(/\p{Script=Han}/u.test(english), false, chinese);
  }
  assert.equal(i18n.detectLanguage(["zh-TW", "en"]), "zh");
  assert.equal(i18n.detectLanguage(["en-GB", "zh-CN"]), "en");
});

test("structured worker errors localize after cloning, including nested messages", () => {
  let error;
  try { core.parsePageRanges("11", 10); } catch (caught) { error = caught; }
  const detail = structuredClone(i18n.errorDetail(error));
  assert.equal(i18n.translate(detail, "en"), "Page numbers must be between 1 and 10.");
  assert.equal(i18n.translate(detail, "zh"), "页码必须在 1 到 10 之间。");
  const nested = i18n.message("{count} 张图片未能识别：{error}", { count: 1, error: detail });
  assert.equal(i18n.translate(nested, "en"), "Could not decode 1 images: Page numbers must be between 1 and 10.");
});

test("language changes cannot alter document bytes or receiver progress", () => {
  const document = documentFor("品牌与语言不改变原文 😀\r\n" + seededText(12000));
  const receiver = new core.TextReceiver();
  receiver.accept(core.encodePage(document, 0));
  const before = receiver.snapshot();
  for (const language of ["en", "zh", "en"]) {
    i18n.translate(i18n.message("已收到 {received}/{total} 页", { received: before.receivedPages, total: before.totalPages }), language);
    assert.deepEqual(receiver.snapshot(), before);
  }
  for (let i = 1; i < document.totalPages; i++) receiver.accept(core.encodePage(document, i));
  assert.deepEqual(receiver.snapshot().bytes, encoder.encode("品牌与语言不改变原文 😀\r\n" + seededText(12000)));
});

test("capacity is 2953 bytes in V40-L and easier mode has a lower capacity", () => {
  assert.equal(qr.textQrCapacity(false), 2953);
  assert.ok(qr.textQrCapacity(true) < 2953);
  assert.throws(() => qr.encodeTextQr(new Uint8Array(2954), false));
  const matrix = qr.encodeTextQr(new Uint8Array(2953), false);
  assert.equal(matrix.version, 40);
  assert.equal(matrix.size, 177);
});

for (const [name, text] of [
  ["Chinese", "内网文档\n这是需要完整保存的原文。\n".repeat(500)],
  ["English", "Project notes: keep every line and space.\n".repeat(200)],
  ["code", "function exportText() {\n  return '<script>not HTML</script>';\n}\n".repeat(100)],
  ["Unicode and emoji", "中文 café e\u0301 😀 🧑‍💻 \t\n".repeat(100)],
  ["CRLF, BOM and trailing spaces", "\uFEFF第一行  \r\n第二行\r第三行\n\n\t "]
]) {
  test(`exact byte round trip: ${name}`, () => {
    const document = documentFor(text);
    const state = receiveAll(document);
    assert.equal(state.complete, true);
    assert.equal(state.text, text);
    assert.deepEqual(state.bytes, encoder.encode(text));
  });
}

test("compression is used only if it is smaller", () => {
  assert.equal(documentFor("abc").compression, 0);
  const raw = documentFor(seededText(32));
  assert.equal(raw.compression, 0);
  assert.deepEqual(raw.encoded, encoder.encode(seededText(32)));
  const document = documentFor("文字压缩测试".repeat(1000));
  assert.equal(document.compression, 1);
  assert.ok(document.encodedLength < document.originalLength);
});

test("short text chooses a small QR, not a forced V40", () => {
  const matrix = qr.encodeTextQr(core.encodePage(documentFor("简短文字"), 0), false);
  assert.ok(matrix.version < 10);
});

test("pagination around payload boundary retains every byte", () => {
  for (const capacity of [1, 2, 35, 36, 37, 100, 2917]) {
    const document = documentFor(seededText(4096), capacity);
    assert.equal(document.totalPages, Math.ceil(document.encodedLength / capacity));
    for (let i = 0; i < document.totalPages; i++) assert.ok(core.encodePage(document, i).length <= capacity + 36);
    assert.equal(receiveAll(document).text, seededText(4096));
  }
});

test("unordered pages, missing ranges and duplicates", () => {
  const document = documentFor(seededText(15000));
  assert.ok(document.totalPages > 2);
  const receiver = new core.TextReceiver();
  receiver.accept(core.encodePage(document, document.totalPages - 1));
  receiver.accept(core.encodePage(document, document.totalPages - 1));
  assert.equal(receiver.snapshot().duplicates, 1);
  assert.equal(receiver.snapshot().complete, false);
  assert.equal(receiver.snapshot().missingRanges, `1-${document.totalPages - 1}`);
  for (let i = document.totalPages - 2; i >= 0; i--) receiver.accept(core.encodePage(document, i));
  assert.equal(receiver.snapshot().text, seededText(15000));
});

test("foreign documents never replace an active session", () => {
  const receiver = new core.TextReceiver();
  const first = documentFor("first");
  const second = documentFor("second", 2917, new Uint8Array(8).fill(9));
  receiver.accept(core.encodePage(first, 0));
  assert.equal(receiver.accept(core.encodePage(second, 0)).foreign, true);
  assert.equal(receiver.snapshot().text, "first");
  receiver.clear();
  assert.equal(receiver.accept(core.encodePage(second, 0)).foreign, false);
  assert.equal(receiver.snapshot().text, "second");
});

test("header, payload and document corruption fail closed", () => {
  const document = documentFor("正文校验".repeat(500));
  const frame = core.encodePage(document, 0);
  const badHeader = frame.slice(); badHeader[20] ^= 1;
  assert.throws(() => core.parsePage(badHeader), /头部损坏/);
  const badPayload = frame.slice(); badPayload[36] ^= 1;
  assert.throws(() => core.parsePage(badPayload), /正文损坏/);
  const badCrc = rewriteHeader(frame, (view) => view.setUint32(28, 42));
  const receiver = new core.TextReceiver();
  assert.throws(() => receiver.accept(badCrc), /全文校验失败/);
  assert.equal(receiver.snapshot().complete, false);
  assert.equal(receiver.snapshot().text, undefined);
});

test("invalid and excessive lengths, indexes and protocol versions are rejected", () => {
  const frame = core.encodePage(documentFor("sample"), 0);
  for (const modify of [
    (view) => view.setUint8(4, 3),
    (view) => view.setUint8(5, 2),
    (view) => view.setUint16(16, 1),
    (view) => view.setUint16(18, 0),
    (view) => view.setUint32(20, core.MAX_TEXT_BYTES + 1),
    (view) => view.setUint32(24, 0),
    (view) => view.setUint32(24, 10)
  ]) assert.throws(() => core.parsePage(rewriteHeader(frame, modify)));
  assert.throws(() => core.parsePage(new Uint8Array(35)));
  assert.throws(() => core.parsePage(new Uint8Array(2954)));
});

test("metadata disagreement and conflicting duplicate are rejected", () => {
  const document = documentFor(seededText(10000));
  const receiver = new core.TextReceiver();
  receiver.accept(core.encodePage(document, 0));
  const next = rewriteHeader(core.encodePage(document, 1), (view) => view.setUint32(28, document.documentCrc ^ 1));
  assert.throws(() => receiver.accept(next), /信息不一致/);
  const conflicting = core.encodePage(document, 0); conflicting[36] ^= 1;
  const duplicate = rewriteHeader(conflicting, (view) => view.setUint32(32, checksums.crc32(conflicting.subarray(36))));
  assert.throws(() => receiver.accept(duplicate), /不同内容/);
});

test("decompression cannot exceed declared output length", () => {
  const encoded = deflateSync(new Uint8Array(500000).fill(65));
  const document = {
    documentId: "0102030405060708", compression: 1, totalPages: 1,
    originalLength: 10, encodedLength: encoded.length, documentCrc: 0,
    encoded, payloadCapacity: 2917, characters: 10
  };
  const receiver = new core.TextReceiver();
  assert.throws(() => receiver.accept(core.encodePage(document, 0)), /超过声明长度/);
  assert.equal(receiver.snapshot().complete, false);
});

test("empty, invalid UTF-8 and over-limit inputs fail", () => {
  assert.throws(() => core.prepareDocument(new Uint8Array(), 2917));
  assert.throws(() => core.prepareDocument(new Uint8Array([0xc3, 0x28]), 2917), /UTF-8/);
  assert.throws(() => core.prepareDocument(new Uint8Array(core.MAX_TEXT_BYTES + 1), 2917), /10 MiB/);
  assert.throws(() => core.prepareDocument(encoder.encode("x"), 0));
  assert.equal(core.countCharacters("😀中a"), 3);
});

test("1-based missing-page input is strict, sorted and deduplicated", () => {
  assert.deepEqual(core.parsePageRanges("5-7, 2，5", 10), [1, 4, 5, 6]);
  for (const value of ["", "0", "11", "4-2", "x", "1.5", "1--3"]) assert.throws(() => core.parsePageRanges(value, 10));
});

for (const easier of [false, true]) {
  test(`actual QR pixels -> decoder -> reordered assembly -> original bytes (${easier ? "scan-friendly" : "capacity"})`, () => {
    const text = "中文与 Emoji 😀\r\n" + seededText(12000) + "\n尾行  ";
    const document = documentFor(text, qr.textQrCapacity(easier) - 36);
    const receiver = new core.TextReceiver();
    for (let i = document.totalPages - 1; i >= 0; i--) {
      const frame = core.encodePage(document, i);
      const matrix = qr.encodeTextQr(frame, easier);
      assert.ok(matrix.version <= (easier ? 30 : 40));
      const { data, width } = raster(matrix);
      const decoded = qr.decodeTextQr(data, width, width);
      assert.ok(decoded, `page ${i + 1} decoded`);
      assert.deepEqual(decoded, frame);
      receiver.accept(decoded);
    }
    assert.equal(receiver.snapshot().text, text);
    assert.deepEqual(receiver.snapshot().bytes, encoder.encode(text));
  });
}
