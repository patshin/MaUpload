import "./styles.css";
import { BookOpen, Camera, ChevronLeft, ChevronRight, Copy, Download, FileUp, HardDrive, ImageUp, LockOpen, Maximize, Minimize, Pause, Play, QrCode, RefreshCw, Repeat2, ScanLine, ShieldCheck, Square, Trash2, createIcons } from "lucide";
import { countCharacters, decodeText, MAX_TEXT_BYTES, parsePage, parsePageRanges, type ReceiveState } from "./text-transfer";
import { drawTextQr, type QrMatrix } from "./text-qr";
import { decodeImageFile, TextScanner } from "./scanner";
import { WorkerClient } from "./worker-client";
import type { SendSummary } from "./transfer.worker";
import { errorDetail, message as m, TransferError, type Localized, type Message } from "./i18n";
import { applyLanguage, bindAttribute, bindText, currentLanguage, initializeLanguage, setText, t } from "./localization";

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
const icons = { BookOpen, Camera, ChevronLeft, ChevronRight, Copy, Download, FileUp, HardDrive, ImageUp, LockOpen, Maximize, Minimize, Pause, Play, QrCode, RefreshCw, Repeat2, ScanLine, ShieldCheck, Square, Trash2 };
const refreshIcons = () => createIcons({ icons });
const sendWorker = new WorkerClient();
const receiveWorker = new WorkerClient();
const textInput = get<HTMLTextAreaElement>("textInput");
const textFileInput = get<HTMLInputElement>("textFileInput");
const easierScan = get<HTMLInputElement>("easierScan");
const qrCanvas = get<HTMLCanvasElement>("qrCanvas");
const qrStage = get<HTMLElement>("qrStage");
const pageInput = get<HTMLInputElement>("pageInput");
const fullscreen = get<HTMLDialogElement>("fullscreenDialog");
const fullscreenStage = get<HTMLElement>("fullscreenStage");
const fullCanvas = get<HTMLCanvasElement>("fullscreenCanvas");
const cameraSelect = get<HTMLSelectElement>("cameraSelect");
const resultText = get<HTMLTextAreaElement>("resultText");
const imageInput = get<HTMLInputElement>("qrImageInput");
const confirmDialog = get<HTMLDialogElement>("confirmDialog");
let inputRevision = 0;
let importRevision = 0;
let estimateTimer = 0;
let currentDocument: SendSummary | undefined;
let originalFileBytes: Uint8Array | undefined;
let pageIndex = 0;
let pageSequence: number[] = [];
let playing = false;
let playTimer = 0;
let renderRevision = 0;
let currentMatrix: QrMatrix | undefined;
const qrCache = new Map<number, Promise<QrMatrix>>();
let receiveState: ReceiveState = { totalPages: 0, receivedPages: 0, missingRanges: "", duplicates: 0, complete: false, originalLength: 0 };
let receiveGeneration = 0;
let imageImporting = false;
const ignoredDocuments = new Set<string>();
let toastTimer = 0;
let confirmResolver: ((value: boolean) => void) | undefined;
let receiveError: Message | undefined;

initializeLanguage();
document.querySelectorAll<HTMLButtonElement>("[data-language]").forEach((button) => {
  button.addEventListener("click", () => {
    applyLanguage(button.dataset.language === "en" ? "en" : "zh");
    get("characterCount").textContent = (currentDocument?.characters ?? countCharacters(textInput.value)).toLocaleString(currentLanguage());
    updatePlayButtons();
    drawCurrentPage();
    renderReceive(receiveError);
  });
});

const scanner = new TextScanner(get<HTMLVideoElement>("cameraVideo"), get<HTMLCanvasElement>("scanCanvas"), receiveWorker, acceptFrame, (active, message, error) => {
  get<HTMLVideoElement>("cameraVideo").hidden = !active;
  get("cameraEmpty").hidden = active;
  get("scanGuide").hidden = !active;
  const button = get<HTMLButtonElement>("scanButton");
  button.innerHTML = `<i data-lucide="${active ? "square" : "camera"}"></i><span></span>`;
  bindText(button.querySelector("span")!, m(active ? "停止扫描" : "开始扫描"));
  setStatus("scanStatus", message, !!error);
  refreshIcons();
});

refreshIcons();
const navButtons = [...document.querySelectorAll<HTMLButtonElement>(".nav-button")];
navButtons.forEach((button, index) => {
  button.addEventListener("click", () => switchView(button.dataset.view === "receive"));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
    navButtons[next].focus();
    navButtons[next].click();
  });
});
textInput.addEventListener("input", () => {
  importRevision++;
  originalFileBytes = undefined;
  setText("sourceLabel", m("UTF-8 文本"));
  schedulePrepare();
});
easierScan.addEventListener("change", schedulePrepare);
get("importTextButton").addEventListener("click", () => textFileInput.click());
textFileInput.addEventListener("change", () => void importText());
get("clearTextButton").addEventListener("click", () => {
  importRevision++;
  textInput.value = "";
  originalFileBytes = undefined;
  setText("sourceLabel", m("UTF-8 文本"));
  schedulePrepare();
  textInput.focus();
});
get("previousPage").addEventListener("click", () => manualStep(-1));
get("nextPage").addEventListener("click", () => manualStep(1));
get("fullPrevious").addEventListener("click", () => manualStep(-1));
get("fullNext").addEventListener("click", () => manualStep(1));
pageInput.addEventListener("change", () => {
  stopPlayback();
  const index = Number(pageInput.value) - 1;
  if (!currentDocument || !Number.isInteger(index) || index < 0 || index >= currentDocument.totalPages) {
    pageInput.value = String(pageIndex + 1);
    notify(m("页码超出范围。"));
    return;
  }
  if (!pageSequence.includes(index)) useAllPages();
  void showPage(index);
});
get("autoPlay").addEventListener("click", togglePlayback);
get("fullPlay").addEventListener("click", togglePlayback);
get("fullscreenButton").addEventListener("click", () => void openFullscreen());
get("exitFullscreen").addEventListener("click", () => void closeFullscreen());
fullscreen.addEventListener("cancel", (event) => { event.preventDefault(); void closeFullscreen(); });
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && fullscreen.open) void closeFullscreen();
});
fullscreen.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === " " && event.target instanceof HTMLButtonElement) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); manualStep(event.key === "ArrowLeft" ? -1 : 1); }
  if (event.key === " ") { event.preventDefault(); togglePlayback(); }
});
get<HTMLFormElement>("retransmitForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!currentDocument) return;
  try {
    pageSequence = parsePageRanges(get<HTMLInputElement>("missingInput").value, currentDocument.totalPages);
    stopPlayback();
    get("allPagesButton").hidden = false;
    setStatus("retransmitStatus", m("补页模式 · {count} 页", { count: pageSequence.length }));
    get("retransmitStatus").hidden = false;
    const revision = inputRevision;
    void showPage(pageSequence[0]).then((shown) => {
      if (shown && revision === inputRevision) startPlayback();
    });
  } catch (error) {
    get("retransmitStatus").hidden = false;
    setStatus("retransmitStatus", errorMessage(error), true);
  }
});
get("allPagesButton").addEventListener("click", () => { stopPlayback(); useAllPages(); void showPage(0); });
get("scanButton").addEventListener("click", () => {
  if (scanner.running) scanner.stop();
  else void scanner.start(cameraSelect.value).then(refreshCameras);
});
cameraSelect.addEventListener("change", () => { if (scanner.running) void scanner.start(cameraSelect.value); });
get("refreshCameras").addEventListener("click", () => void refreshCameras());
get("importQrButton").addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => void importImages());
get("copyMissing").addEventListener("click", () => void copyValue(receiveState.missingRanges, get<HTMLInputElement>("missingOutput")));
get("copyText").addEventListener("click", () => { if (receiveState.complete) void copyValue(receiveState.text ?? "", resultText); });
get("downloadText").addEventListener("click", downloadText);
get("clearSession").addEventListener("click", () => void clearReceiver());
get("confirmCancel").addEventListener("click", () => finishConfirm(false));
get("confirmAccept").addEventListener("click", () => finishConfirm(true));
confirmDialog.addEventListener("cancel", (event) => { event.preventDefault(); finishConfirm(false); });
new ResizeObserver(drawCurrentPage).observe(qrStage);
new ResizeObserver(drawCurrentPage).observe(fullscreenStage);
window.addEventListener("pagehide", () => { scanner.stop(); stopPlayback(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { scanner.stop(); stopPlayback(); } });
renderReceive();

function switchView(receive: boolean): void {
  stopPlayback();
  if (!receive) scanner.stop();
  get("sendPanel").hidden = receive;
  get("receivePanel").hidden = !receive;
  navButtons.forEach((button) => {
    const active = (button.dataset.view === "receive") === receive;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (receive) void refreshCameras(); else drawCurrentPage();
}

function schedulePrepare(): void {
  inputRevision++;
  clearTimeout(estimateTimer);
  stopPlayback();
  currentDocument = undefined;
  currentMatrix = undefined;
  renderRevision++;
  qrCache.clear();
  qrCanvas.hidden = true;
  qrStage.removeAttribute("aria-busy");
  bindText(get("qrEmpty").querySelector("span")!, m("暂无二维码"));
  get("qrEmpty").hidden = false;
  get("moduleWarning").hidden = true;
  get("qrInfo").textContent = "—";
  setText("compressionInfo", "—");
  get("allPagesButton").hidden = true;
  get("retransmitStatus").hidden = true;
  if (fullscreen.open) void closeFullscreen();
  updateSendControls();
  const bytes = originalFileBytes ?? new TextEncoder().encode(textInput.value);
  get("originalSize").textContent = humanBytes(bytes.length);
  get("characterCount").textContent = countCharacters(textInput.value).toLocaleString(currentLanguage());
  get("encodedSize").textContent = bytes.length ? "…" : "0 B";
  get("pageCount").textContent = bytes.length ? "…" : "0";
  get<HTMLButtonElement>("clearTextButton").disabled = bytes.length === 0;
  if (!bytes.length) {
    setStatus("sendStatus", m("等待输入"));
    setBadge("sendBadge", m("待输入"));
    void sendWorker.request("resetSender").catch(() => {});
    return;
  }
  if (bytes.length > MAX_TEXT_BYTES) {
    setStatus("sendStatus", m("文本超过 10 MiB 上限。"), true);
    setBadge("sendBadge", m("超出上限"), "error");
    return;
  }
  setStatus("sendStatus", m("正在计算容量…"));
  setBadge("sendBadge", m("处理中"));
  const revision = inputRevision;
  estimateTimer = window.setTimeout(() => void prepare(bytes, revision), 300);
}

async function prepare(bytes: Uint8Array, revision: number): Promise<void> {
  try {
    const summary = await sendWorker.request<SendSummary>("prepare", { bytes, easier: easierScan.checked });
    if (revision !== inputRevision) return;
    currentDocument = summary;
    pageIndex = 0;
    useAllPages();
    get("characterCount").textContent = summary.characters.toLocaleString(currentLanguage());
    get("originalSize").textContent = humanBytes(summary.originalLength);
    get("encodedSize").textContent = humanBytes(summary.encodedLength);
    get("pageCount").textContent = String(summary.totalPages);
    setText("compressionInfo", summary.compression ? m("压缩至 {percent}%", { percent: Math.round(summary.encodedLength / summary.originalLength * 100) }) : m("原文传输"));
    setStatus("sendStatus", m(summary.compression ? "已压缩，二维码就绪" : "压缩未减小体积，已使用原文传输"));
    setBadge("sendBadge", m("已就绪"), "ready");
    updateSendControls();
    await showPage(0);
  } catch (error) {
    if (revision !== inputRevision) return;
    setStatus("sendStatus", errorMessage(error), true);
    setBadge("sendBadge", m("处理失败"), "error");
    get("encodedSize").textContent = "—";
    get("pageCount").textContent = "—";
  }
}

async function importText(): Promise<void> {
  const file = textFileInput.files?.[0];
  textFileInput.value = "";
  if (!file) return;
  const revision = ++importRevision;
  try {
    if (file.size > MAX_TEXT_BYTES) throw new TransferError(m("文本超过 10 MiB 上限。"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const value = decodeText(bytes);
    if (revision !== importRevision) return;
    originalFileBytes = bytes;
    textInput.value = value;
    setText("sourceLabel", file.name);
    schedulePrepare();
  } catch (error) {
    if (revision === importRevision) { setStatus("sendStatus", errorMessage(error), true); notify(errorMessage(error)); }
  }
}

function getMatrix(index: number): Promise<QrMatrix> {
  if (!currentDocument) return Promise.reject(new TransferError(m("没有可播放的文档。")));
  let pending = qrCache.get(index);
  if (!pending) {
    pending = sendWorker.request<QrMatrix>("qr", { documentId: currentDocument.documentId, index });
    qrCache.set(index, pending);
  }
  return pending;
}

async function showPage(index: number): Promise<boolean> {
  if (!currentDocument) return false;
  const id = currentDocument.documentId;
  const revision = ++renderRevision;
  currentMatrix = undefined;
  qrCanvas.hidden = true;
  fullCanvas.hidden = true;
  bindText(get("qrEmpty").querySelector("span")!, m("正在生成二维码…"));
  get("qrEmpty").hidden = false;
  setText("fullQrInfo", m("正在生成二维码…"));
  pageIndex = index;
  updateSendControls();
  qrStage.setAttribute("aria-busy", "true");
  try {
    const matrix = await getMatrix(index);
    if (currentDocument?.documentId !== id || revision !== renderRevision) return false;
    currentMatrix = matrix;
    qrCanvas.hidden = false;
    fullCanvas.hidden = false;
    get("qrEmpty").hidden = true;
    updateSendControls();
    drawCurrentPage();
    const position = pageSequence.indexOf(index);
    const neighbors = [
      pageSequence[(position - 1 + pageSequence.length) % pageSequence.length],
      pageSequence[(position + 1) % pageSequence.length]
    ];
    const keep = new Set([index, ...neighbors]);
    for (const key of qrCache.keys()) if (!keep.has(key)) qrCache.delete(key);
    for (const neighbor of neighbors) void getMatrix(neighbor).catch(() => {});
    return true;
  } catch (error) {
    if (currentDocument?.documentId === id && revision === renderRevision) {
      stopPlayback();
      bindText(get("qrEmpty").querySelector("span")!, m("二维码生成失败"));
      setText("fullQrInfo", m("二维码生成失败"));
      setStatus("sendStatus", errorMessage(error), true);
    }
    return false;
  } finally {
    if (revision === renderRevision) qrStage.removeAttribute("aria-busy");
  }
}

function drawCurrentPage(): void {
  if (!currentMatrix || !currentDocument) return;
  const width = qrStage.clientWidth - 24;
  const height = qrStage.clientHeight - 24;
  if (width > 0 && height > 0) {
    const scale = drawTextQr(currentMatrix, qrCanvas, Math.min(width, height));
    get("qrInfo").textContent = `V${currentMatrix.version} / ${easierScan.checked ? "M" : "L"} / ${scale} px`;
    get("moduleWarning").hidden = scale >= 3;
  }
  if (fullscreen.open) {
    const scale = drawTextQr(currentMatrix, fullCanvas, Math.min(fullscreenStage.clientWidth, fullscreenStage.clientHeight) - 16);
    setText("fullQrInfo", `V${currentMatrix.version} / ${scale} px${scale < 3 ? ` · ${t(m("请扩大显示"))}` : ""}`);
  }
}

function updateSendControls(): void {
  const ready = !!currentDocument;
  const count = currentDocument?.totalPages ?? 0;
  const position = pageSequence.indexOf(pageIndex);
  for (const id of ["previousPage", "fullPrevious"]) get<HTMLButtonElement>(id).disabled = !ready || position <= 0;
  for (const id of ["nextPage", "fullNext"]) get<HTMLButtonElement>(id).disabled = !ready || position >= pageSequence.length - 1;
  for (const id of ["autoPlay", "fullPlay"]) get<HTMLButtonElement>(id).disabled = !ready || pageSequence.length < 2;
  get<HTMLButtonElement>("fullscreenButton").disabled = !ready || !currentMatrix;
  get<HTMLButtonElement>("retransmitButton").disabled = !ready;
  get<HTMLInputElement>("missingInput").disabled = !ready;
  pageInput.disabled = !ready;
  pageInput.value = String(ready ? pageIndex + 1 : 1);
  pageInput.max = String(count || 1);
  get("totalPages").textContent = String(count);
  get("fullPageLabel").textContent = `${pageIndex + 1} / ${count}`;
}

function manualStep(direction: number): void {
  stopPlayback();
  const position = pageSequence.indexOf(pageIndex) + direction;
  if (position >= 0 && position < pageSequence.length) void showPage(pageSequence[position]);
}
function useAllPages(): void {
  pageSequence = Array.from({ length: currentDocument?.totalPages ?? 0 }, (_, index) => index);
  get("allPagesButton").hidden = true;
  get("retransmitStatus").hidden = true;
  updateSendControls();
}
function togglePlayback(): void { if (playing) stopPlayback(); else startPlayback(); }
function startPlayback(): void {
  if (!currentDocument || pageSequence.length < 2) return;
  playing = true;
  updatePlayButtons();
  scheduleNextPage();
}
function scheduleNextPage(): void {
  clearTimeout(playTimer);
  const documentId = currentDocument?.documentId;
  playTimer = window.setTimeout(() => {
    if (!playing || !currentDocument || currentDocument.documentId !== documentId) return;
    const position = (pageSequence.indexOf(pageIndex) + 1) % pageSequence.length;
    void showPage(pageSequence[position]).then(() => {
      if (playing && currentDocument?.documentId === documentId) scheduleNextPage();
    });
  }, 1000);
}
function stopPlayback(): void { playing = false; clearTimeout(playTimer); updatePlayButtons(); }
function updatePlayButtons(): void {
  for (const id of ["autoPlay", "fullPlay"]) {
    const button = get<HTMLButtonElement>(id);
    button.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}"></i>`;
    bindAttribute(button, "aria-label", m(playing ? "暂停自动播放" : "开始自动播放"));
    button.setAttribute("aria-pressed", String(playing));
    bindAttribute(button, "data-tooltip", m(playing ? "暂停自动播放" : "自动播放 · 1 秒/页"));
  }
  refreshIcons();
}
async function openFullscreen(): Promise<void> {
  if (!currentMatrix) return;
  fullscreen.showModal();
  drawCurrentPage();
  try { await fullscreen.requestFullscreen?.(); } catch { /* The modal remains a usable full-window fallback. */ }
  drawCurrentPage();
  get("exitFullscreen").focus();
}
async function closeFullscreen(): Promise<void> {
  if (fullscreen.open) fullscreen.close();
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* Already exited. */ } }
  get("fullscreenButton").focus();
}

async function refreshCameras(): Promise<void> {
  const button = get<HTMLButtonElement>("refreshCameras");
  button.disabled = true;
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const selected = cameraSelect.value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
    const defaultOption = new Option("", "");
    bindText(defaultOption, m("默认摄像头"));
    cameraSelect.replaceChildren(defaultOption);
    devices.forEach((device, index) => {
      const option = new Option("", device.deviceId);
      bindText(option, device.label || m("摄像头 {number}", { number: index + 1 }));
      cameraSelect.add(option);
    });
    if (devices.some((device) => device.deviceId === selected)) cameraSelect.value = selected;
  } catch { setStatus("scanStatus", m("无法列出摄像头，可直接开始扫描或导入图片。"), true); }
  finally { button.disabled = false; }
}

async function acceptFrame(bytes: Uint8Array): Promise<void> {
  const generation = receiveGeneration;
  try {
    const page = parsePage(bytes);
    if (ignoredDocuments.has(page.documentId)) return;
    let result = await receiveWorker.request<{ foreign: boolean; state: ReceiveState }>("accept", { bytes });
    if (generation !== receiveGeneration) return;
    if (result.foreign) {
      const accepted = await confirmAction(m("切换接收文档"), m("当前文档已收到 {received}/{total} 页。切换会丢弃当前会话，是否接收新的文档？", { received: receiveState.receivedPages, total: receiveState.totalPages }));
      if (generation !== receiveGeneration) return;
      if (!accepted) { ignoredDocuments.add(page.documentId); return; }
      await receiveWorker.request("clear");
      result = await receiveWorker.request("accept", { bytes });
      if (generation !== receiveGeneration) return;
      ignoredDocuments.clear();
    }
    receiveState = result.state;
    renderReceive();
    if (receiveState.complete) scanner.stop(m("已收齐并通过全文校验"));
  } catch (error) {
    if (generation !== receiveGeneration) return;
    receiveState = await receiveWorker.request<ReceiveState>("snapshot").catch(() => receiveState);
    if (generation !== receiveGeneration) return;
    renderReceive(errorMessage(error));
  }
}

function renderReceive(error?: Message): void {
  receiveError = error;
  get("receivedPages").textContent = String(receiveState.receivedPages);
  get("receiveTotal").textContent = String(receiveState.totalPages);
  get("receiveSize").textContent = receiveState.originalLength ? humanBytes(receiveState.originalLength) : "—";
  get("duplicatePages").textContent = String(receiveState.duplicates);
  get<HTMLInputElement>("missingOutput").value = receiveState.totalPages ? receiveState.missingRanges || t(m("无")) : "—";
  const progress = get<HTMLProgressElement>("receiveProgress");
  progress.max = receiveState.totalPages || 1;
  progress.value = receiveState.receivedPages;
  get<HTMLButtonElement>("copyMissing").disabled = !receiveState.missingRanges;
  get<HTMLButtonElement>("clearSession").disabled = !receiveState.documentId;
  get<HTMLButtonElement>("copyText").disabled = !receiveState.complete;
  get<HTMLButtonElement>("downloadText").disabled = !receiveState.complete;
  resultText.value = receiveState.text ?? "";
  get("resultStamp").textContent = receiveState.complete ? "VERIFIED / CRC32" : error ? "ERROR" : "WAITING";
  setBadge("receiveBadge", m(receiveState.complete ? "校验通过" : error ? "接收错误" : receiveState.totalPages ? "接收中" : "待接收"), receiveState.complete ? "ready" : error ? "error" : "");
  setText("receiveStatus", error ?? (receiveState.complete ? m("已收齐，全文校验通过") : receiveState.totalPages ? m("已收到 {received}/{total} 页", { received: receiveState.receivedPages, total: receiveState.totalPages }) : m("等待二维码")));
}

async function importImages(): Promise<void> {
  const files = [...(imageInput.files ?? [])];
  imageInput.value = "";
  if (!files.length || imageImporting) return;
  scanner.stop();
  imageImporting = true;
  const generation = receiveGeneration;
  get<HTMLButtonElement>("importQrButton").disabled = true;
  get<HTMLButtonElement>("scanButton").disabled = true;
  get("importQrButton").setAttribute("aria-busy", "true");
  let count = 0;
  const errors: Message[] = [];
  try {
    for (const file of files) {
      if (generation !== receiveGeneration) break;
      setStatus("scanStatus", m("正在识别图片 {current}/{total}…", { current: ++count, total: files.length }));
      try {
        const bytes = await decodeImageFile(file, receiveWorker);
        if (generation !== receiveGeneration) break;
        if (!bytes) throw new TransferError(m("未找到可识别的二维码，请使用清晰的原图。"));
        await acceptFrame(bytes);
      } catch (error) { errors.push(errorMessage(error)); }
    }
    if (generation === receiveGeneration) setStatus("scanStatus", errors.length ? m("{count} 张图片未能识别：{error}", { count: errors.length, error: errors[0] }) : m("已处理 {count} 张图片", { count }), errors.length > 0);
  } finally {
    imageImporting = false;
    get<HTMLButtonElement>("importQrButton").disabled = false;
    get<HTMLButtonElement>("scanButton").disabled = false;
    get("importQrButton").removeAttribute("aria-busy");
  }
}

async function clearReceiver(): Promise<void> {
  if (!await confirmAction(m("清空接收会话"), m("已收到的页面和还原文字将被清空。是否继续？"))) return;
  scanner.stop();
  receiveGeneration++;
  ignoredDocuments.clear();
  try { receiveState = await receiveWorker.request<ReceiveState>("clear"); renderReceive(); }
  catch (error) { notify(errorMessage(error)); }
}
function confirmAction(title: Localized, message: Localized): Promise<boolean> {
  if (confirmResolver) return Promise.resolve(false);
  setText("confirmTitle", title);
  setText("confirmMessage", message);
  confirmDialog.showModal();
  get("confirmCancel").focus();
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function finishConfirm(accepted: boolean): void {
  confirmDialog.close();
  confirmResolver?.(accepted);
  confirmResolver = undefined;
}

async function copyValue(value: string, fallback: HTMLTextAreaElement | HTMLInputElement): Promise<void> {
  try { await navigator.clipboard.writeText(value); notify(m("已复制")); }
  catch {
    fallback.focus(); fallback.select();
    notify(m("浏览器未允许复制，已选中内容，请手动复制。"));
  }
}
function downloadText(): void {
  if (!receiveState.complete || !receiveState.bytes) return;
  const bytes = new Uint8Array(receiveState.bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = "document.txt";
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function setStatus(id: string, message: Localized, error = false): void {
  setText(id, message);
  get(id).classList.toggle("error", error);
}
function setBadge(id: string, label: Localized, state = ""): void { const badge = get(id); setText(id, label); badge.className = `stamp ${state}`; }
function notify(message: Localized): void {
  const toast = get("toast"); setText("toast", message); toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toast.hidden = true; setText("toast", ""); }, 4000);
}
function errorMessage(error: unknown): Message { return errorDetail(error); }
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
