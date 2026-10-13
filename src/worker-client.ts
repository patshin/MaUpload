import { message, TransferError } from "./i18n";

export class WorkerClient {
  private worker = new Worker(new URL("./transfer.worker.ts", import.meta.url), { type: "module" });
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  private failure?: Error;

  constructor() {
    this.worker.onmessage = (event) => {
      const { id, result, error } = event.data;
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (error) request?.reject(new TransferError(error));
      else request?.resolve(result);
    };
    this.worker.onerror = () => {
      this.failure = new TransferError(message("后台处理器无法启动，请刷新页面重试。"));
      for (const request of this.pending.values()) request.reject(this.failure);
      this.pending.clear();
    };
  }

  request<T>(type: string, payload: unknown = {}, transfer: Transferable[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  destroy(): void {
    this.failure = new TransferError(message("处理器已关闭。"));
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }
}
