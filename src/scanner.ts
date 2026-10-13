import { WorkerClient } from "./worker-client";
import { errorDetail, message, TransferError, type Message } from "./i18n";

export class TextScanner {
  private stream?: MediaStream;
  private generation = 0;
  private raf = 0;
  private active = false;

  constructor(
    private video: HTMLVideoElement,
    private canvas: HTMLCanvasElement,
    private worker: WorkerClient,
    private onFrame: (bytes: Uint8Array) => Promise<void>,
    private onStatus: (active: boolean, message: Message, error?: boolean) => void
  ) {}

  get running(): boolean { return this.active; }

  async start(deviceId: string): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.active = true;
    this.onStatus(true, message("正在请求摄像头…"));
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new TransferError(message("摄像头需要 HTTPS 或 localhost，请使用安全地址打开网站。"));
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : { ideal: "environment" },
          width: { ideal: 1920 }, height: { ideal: 1080 }
        }, audio: false
      });
      if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return;
      for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => {
        if (generation === this.generation) this.stop(message("摄像头已断开，请重新开始扫描。"), true);
      });
      this.onStatus(true, message("正在扫描"));
      void this.tick(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      let detail = errorDetail(error, "摄像头启动失败。");
      if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") detail = message("摄像头权限被拒绝，请允许访问后重试，或导入二维码图片。");
        if (error.name === "NotFoundError") detail = message("未找到摄像头，可改用二维码图片导入。");
        if (error.name === "NotReadableError") detail = message("摄像头正被占用，请关闭其他使用摄像头的应用。");
      }
      this.stop(detail, true);
    }
  }

  stop(detail = message("摄像头已关闭"), error = false): void {
    this.generation++;
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.onStatus(false, detail, error);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) return;
    try {
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const side = Math.min(this.video.videoWidth, this.video.videoHeight);
        if (side > 0) {
          const crop = Math.max(1, Math.floor(side * .88));
          this.canvas.width = this.canvas.height = crop;
          const context = this.canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new TransferError(message("无法读取摄像头图像。"));
          context.drawImage(this.video, (this.video.videoWidth - crop) / 2, (this.video.videoHeight - crop) / 2, crop, crop, 0, 0, crop, crop);
          const image = context.getImageData(0, 0, crop, crop);
          const bytes = await this.worker.request<Uint8Array | null>("decode", { data: image.data, width: crop, height: crop }, [image.data.buffer]);
          if (bytes && this.active && generation === this.generation) await this.onFrame(bytes);
        }
      }
    } catch (error) {
      if (generation === this.generation) this.onStatus(true, errorDetail(error, "扫描失败，请重试。"), true);
    }
    if (this.active && generation === this.generation) this.raf = requestAnimationFrame(() => void this.tick(generation));
  }
}

export async function decodeImageFile(file: File, worker: WorkerClient): Promise<Uint8Array | null> {
  if (file.size > 32 * 1024 * 1024) throw new TransferError(message("图片超过 32 MiB 上限。"));
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new TransferError(message("无法打开这张图片，请选择 PNG、JPEG 或 WebP。")); }
  try {
    if (bitmap.width * bitmap.height > 16_000_000) throw new TransferError(message("图片超过 1600 万像素，请裁剪到二维码区域后导入。"));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new TransferError(message("无法读取图片。"));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return await worker.request<Uint8Array | null>("decode", { data: image.data, width: image.width, height: image.height }, [image.data.buffer]);
  } finally { bitmap.close(); }
}
