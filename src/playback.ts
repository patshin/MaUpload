import { gridCellCount, META_INSERT_INTERVAL, META_REPEAT_COUNT } from "./constants";
import { drawQrToCanvas, makeQrForFrame } from "./qr";
import type { GridMode, PackageBuild, QrSettings, RawFrame } from "./types";

interface PlaybackElements {
  overlay: HTMLElement;
  grid: HTMLElement;
  status: HTMLElement;
}

interface PlaybackItem {
  frame: RawFrame;
  label: string;
}

export class PlaybackController {
  private build: PackageBuild | undefined;
  private settings: QrSettings | undefined;
  private items: PlaybackItem[] = [];
  private timer: number | undefined;
  private pointer = 0;
  private loopCount = 0;
  private paused = false;
  private startedAt = 0;
  private ticks = 0;

  public constructor(private readonly elements: PlaybackElements) {}

  public load(build: PackageBuild, settings: QrSettings): void {
    this.build = build;
    this.settings = settings;
  }

  public async start(frameIndexes?: readonly number[]): Promise<void> {
    if (this.build == null || this.settings == null) throw new Error("Build a package first");
    this.stopTimer();
    this.items = this.makeSchedule(frameIndexes);
    this.pointer = 0;
    this.loopCount = 0;
    this.paused = false;
    this.startedAt = performance.now();
    this.ticks = 0;
    this.elements.overlay.hidden = false;
    this.elements.overlay.classList.add("active");
    this.configureGrid(this.settings.grid);
    await this.elements.overlay.requestFullscreen?.().catch(() => undefined);
    this.tick();
  }

  public stop(): void {
    this.stopTimer();
    this.elements.overlay.hidden = true;
    this.elements.overlay.classList.remove("active");
    if (document.fullscreenElement === this.elements.overlay) void document.exitFullscreen();
  }

  public togglePause(): boolean {
    this.paused = !this.paused;
    if (!this.paused) this.tick();
    return this.paused;
  }

  public updateFrameMs(frameMs: number): void {
    if (this.settings != null) this.settings.frameMs = frameMs;
  }

  private tick(): void {
    if (this.paused || this.settings == null || this.build == null) return;
    const cellCount = gridCellCount(this.settings.grid);
    const canvases = Array.from(this.elements.grid.querySelectorAll("canvas"));
    const gridRect = this.elements.grid.getBoundingClientRect();
    const columns = this.settings.grid === "1x1" ? 1 : 2;
    const rows = this.settings.grid === "2x2" ? 2 : 1;
    const cellWidth = Math.max(160, gridRect.width / columns);
    const cellHeight = Math.max(160, gridRect.height / rows);
    const labels: string[] = [];
    for (let cell = 0; cell < cellCount; cell += 1) {
      const item = this.items[(this.pointer + cell) % this.items.length];
      const canvas = canvases[cell] as HTMLCanvasElement | undefined;
      if (canvas == null) continue;
      const qr = makeQrForFrame(item.frame.bytes, this.settings, this.build.qrCapacityBytes);
      drawQrToCanvas(qr, canvas, cellWidth, cellHeight);
      labels.push(item.label);
    }
    this.pointer += cellCount;
    if (this.pointer >= this.items.length) {
      this.pointer %= this.items.length;
      this.loopCount += 1;
    }
    this.ticks += 1;
    const elapsed = Math.max(1, performance.now() - this.startedAt);
    const fps = (this.ticks * 1000) / elapsed;
    this.elements.status.textContent = `session ${this.build.meta.sessionIdHex} | ${labels.join(" + ")} | total ${this.build.meta.totalFrames} | loop ${this.loopCount} | ${fps.toFixed(1)} FPS | grid ${this.settings.grid}`;
    this.stopTimer();
    this.timer = window.setTimeout(() => this.tick(), this.settings.frameMs);
  }

  private makeSchedule(frameIndexes?: readonly number[]): PlaybackItem[] {
    if (this.build == null) throw new Error("No package loaded");
    const selected =
      frameIndexes == null || frameIndexes.length === 0
        ? this.build.dataFrames
        : frameIndexes.map((index) => {
            const frame = this.build?.dataFrames[index];
            if (frame == null) throw new Error(`Missing frame index ${index}`);
            return frame;
          });
    const items: PlaybackItem[] = [];
    for (let index = 0; index < META_REPEAT_COUNT; index += 1) {
      items.push({ frame: this.build.metaFrame, label: "meta" });
    }
    selected.forEach((frame, index) => {
      if (index > 0 && index % META_INSERT_INTERVAL === 0) items.push({ frame: this.build!.metaFrame, label: "meta" });
      items.push({ frame, label: `frame ${frame.frameIndex + 1}` });
    });
    return items;
  }

  private configureGrid(grid: GridMode): void {
    this.elements.grid.className = `qr-grid grid-${grid}`;
    this.elements.grid.replaceChildren();
    const cells = gridCellCount(grid);
    for (let index = 0; index < cells; index += 1) {
      const canvas = document.createElement("canvas");
      canvas.className = "qr-canvas";
      this.elements.grid.append(canvas);
    }
  }

  private stopTimer(): void {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
