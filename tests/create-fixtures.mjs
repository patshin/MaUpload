import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const directory = process.argv[2] ?? "/tmp/maupload-fixtures";
const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, hmr: false }, appType: "custom" });
try {
  const core = await server.ssrLoadModule("/src/text-transfer.ts");
  const qr = await server.ssrLoadModule("/src/text-qr.ts");
  const { crc32 } = await server.ssrLoadModule("/src/checksums.ts");
  let seed = 0x12345678;
  let content = "\uFEFF# 文档导出测试\r\n中文、Emoji 😀、代码与尾部空格。  \r\n";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-={}[];:,.?";
  for (let i = 0; i < 12000; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    content += alphabet[(seed >>> 0) % alphabet.length];
    if (i % 100 === 99) content += "\r\n";
  }
  content += "\r\n最后一行  \r\n";
  await mkdir(directory, { recursive: true });
  const bytes = new TextEncoder().encode(content);
  await writeFile(`${directory}/original.md`, bytes);
  await writeFile(`${directory}/invalid-utf8.txt`, new Uint8Array([0xc3, 0x28]));
  await writeFile(`${directory}/empty.txt`, new Uint8Array());
  const document = core.prepareDocument(bytes, qr.textQrCapacity(false) - 36, new Uint8Array(8).fill(7));
  for (let index = 0; index < document.totalPages; index++) {
    const matrix = qr.encodeTextQr(core.encodePage(document, index), false);
    const scale = 4;
    const width = (matrix.size + 8) * scale;
    const pixels = Buffer.alloc((width * 4 + 1) * width, 255);
    for (let y = 0; y < width; y++) pixels[y * (width * 4 + 1)] = 0;
    for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) {
      if (!matrix.modules[y * matrix.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const offset = ((y + 4) * scale + dy) * (width * 4 + 1) + 1 + ((x + 4) * scale + dx) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
    const chunk = (name, data) => {
      const type = Buffer.from(name);
      const output = Buffer.alloc(data.length + 12);
      output.writeUInt32BE(data.length, 0); type.copy(output, 4); data.copy(output, 8);
      output.writeUInt32BE(crc32(Buffer.concat([type, data])), output.length - 4);
      return output;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(width, 4);
    header[8] = 8; header[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
    await writeFile(`${directory}/page-${index + 1}.png`, png);
  }
  console.log(JSON.stringify({ directory, originalLength: bytes.length, encodedLength: document.encodedLength, totalPages: document.totalPages }));
} finally { await server.close(); }
