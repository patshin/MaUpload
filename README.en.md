# MaUpload / 码上传

**Pack text into QR. Move documents through light.**

`LOCAL-FIRST` · `OPTICAL TEXT RELAY` · `QMT2` · `中文 / ENGLISH`

MaUpload is a QR text workstation for **authorized document transcription in isolated environments**. Paste text, compress it automatically, and generate as few QR pages as the actual data allows. Scan on another device, verify the complete document, and restore the original text. No account, password, cloud drive or document upload service is required.

Warm paper, near-black consoles, golden navigation, orange actions and teal verification give it a restrained Y2K / Warm Workstation identity. The first screen is a working tool, not a marketing page.

[Open workstation](https://patshin.github.io/MaUpload/) · [User guide](https://patshin.github.io/MaUpload/guide.html?lang=en) · [Download offline bundle](https://patshin.github.io/MaUpload/maupload-offline.zip) · [简体中文](README.md)

![MaUpload QR text workstation](docs/workstation.png)

## Intended use

Transcribe approved operating notes, Markdown, configuration snippets, code and plain-text records where cloud services are unavailable, network separation is required, and **screen display and camera capture are explicitly permitted**.

**Designed for restricted environments does not mean authorized to export any document.** MaUpload does not bypass DLP, endpoint policy, camera restrictions or approval workflows. It provides no enterprise security certification, access controls or audit trail. Your organization must approve the document classification, destination device, capture method and storage location. Do not use it where such transfers are prohibited.

## Core capabilities

| Stage | Behavior |
| --- | --- |
| Input | Paste text or import one valid UTF-8 text file, up to 10 MiB |
| Compress | Whole-document raw DEFLATE; original bytes when compression does not reduce size |
| Display | One static page by default; previous/next, page jump, fullscreen and optional one-second autoplay |
| Receive | Camera scanning or QR image import; unordered pages, duplicates and missing-page retransmission |
| Restore | Length and CRC32 checks; export is available only after complete verification |
| Language | Switch Chinese / English without changing documents or receive progress; preference stays in memory |

## Five steps

1. **Input.** On the sending device, choose Generate QR and paste text or Import text. TXT, Markdown, CSV, JSON and source code are supported if encoded as UTF-8. Word / PDF extraction is not supported.
2. **Display.** Once the automatic estimate finishes, try scanning the static first page. For longer documents, step through pages, enter a page number, use fullscreen, or enable autoplay.
3. **Receive.** Open the same tool on the receiving device. Choose Receive QR, select a camera and start scanning, or import several original QR images. Ordinary phone QR readers cannot directly restore QMT2 documents.
4. **Resend.** Copy Missing pages from the receiver and enter the same range in Resend on the sender, for example `2, 5-8`. Play just those pages. All pages restores the full playlist.
5. **Export.** After Verified appears, copy the text or download `document.txt`. Downloads preserve original UTF-8 bytes, including an imported file's BOM, CRLF and trailing spaces. Editing an imported file uses the editor's current text instead.

Do not reload during a transfer. Switching documents and clearing a session require confirmation. The two devices may use different interface languages.

## Capacity and scanning

The default prioritizes capacity: QR Byte mode, up to Version 40 with ECC L. Each page uses the smallest version that fits. Version 40-L holds **2,953 bytes**, leaving **2,917 payload bytes per page** after the 36-byte header. Bytes are not characters. Actual page count depends on UTF-8 encoding and compression.

Easier scanning uses up to Version 30 with ECC M, trading more pages for lower density and stronger error correction. Changing this switch creates a new document session; clear the receiver and start again.

- Use fullscreen first. Keep the entire white border visible, avoid glare and maintain focus.
- Below 3 pixels per module, the app prompts you to enlarge the display. QR rendering is black and white, with integer pixels and a four-module quiet zone.
- Autoplay changes pages once per second. Pause and step manually if your camera cannot keep up.
- Camera access needs HTTPS or localhost, browser permission and organization approval. Image import needs no camera permission. Each image is limited to 32 MiB / 16 megapixels.
- Image decode tests do not replace a physical screen-to-camera acceptance test. Validate with the actual screen, camera and representative documents before relying on it.

## Privacy and limits

**Compression is not encryption. CRC32 is not authentication.** Anyone who captures the QR pages can restore the document with a compatible decoder. QR transfer does not guarantee confidentiality, trusted origin or resistance to deliberate tampering.

- Document processing runs in the current browser. There is no upload endpoint, CDN, remote font or analytics service.
- Documents and received pages stay in memory. They are not written to URLs, localStorage, sessionStorage, IndexedDB or console logs. Reloading or closing the page loses the session.
- Online visits request static files from GitHub Pages. The hosting provider may record normal access metadata; document contents are not uploaded. Use an approved local offline bundle where external access is also restricted.
- Downloads, clipboard contents, screenshots and recordings create copies outside the page. Handle them under your organization's data policy. MaUpload cannot manage or delete those copies.
- The former encrypted-file protocol is no longer exposed in the UI and old transfer packages are not supported. Legacy modules are excluded from the current production dependency graph.

## Fully offline use

1. Download `maupload-offline.zip` on an approved connected device and bring it into the target environment only through an authorized process.
2. Extract it without changing the contents of `MaUpload/`.
3. From the folder's **parent directory**, run an existing local static server, for example:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

4. Open `http://127.0.0.1:8080/MaUpload/`. Each device can use its own local server. Runtime use needs neither npm nor internet, but a suitable static server must already be available.

Do not double-click the HTML file: module workers require HTTP(S). Binding to `127.0.0.1` keeps the server local to the device. A loaded online workstation can keep processing after disconnection; **there is no Service Worker and reopening the remote URL while offline is not guaranteed**.

## Development and deployment

```bash
npm ci
npm test
npm run build
npm run dev
```

The build produces the static site in `dist/` and `dist/maupload-offline.zip`. Tests cover multilingual text, Unicode, line endings, capacity boundaries, missing and duplicate pages, corruption, bounded decompression and real QR raster decoding.

GitHub Pages uses `.github/workflows/pages.yml`. Pushes to `main` / `master` run tests, build and deploy static files. Set the repository's Pages source to **GitHub Actions**. If the repository path changes, update `base` in `vite.config.ts`. Browser-entered or received documents are not part of a deployment.

## QMT2 protocol

Each page contains a 36-byte binary header followed by a payload slice. No Base64, JSON wrapper or standalone metadata page is used. Integers are big-endian; protocol page indexes are zero-based, UI pages are one-based.

| Field | Bytes |
| --- | ---: |
| `QMT2` magic / version 2 / compression flag | 4 / 1 / 1 |
| Header CRC16 / random document ID | 2 / 8 |
| Page index / total pages | 2 / 2 |
| Original length / encoded length | 4 / 4 |
| Original CRC32 / page payload CRC32 | 4 / 4 |

Compression is `0` for original bytes or `1` for raw DEFLATE. The header CRC16 field is zeroed during calculation; the algorithm is CCITT-FALSE. CRC32 uses IEEE. The receiver validates page counts, lengths and checksums and bounds decompressed output to 10 MiB.
