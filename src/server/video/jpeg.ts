import { spawn, type ChildProcess } from "node:child_process";

// T057 live view on the processing device: encodes the analyzed frame to JPEG in memory with a
// long-lived ffmpeg (no extra image library). Frames are only encoded while someone watches; the
// output is read from the pipe and never written to disk.
// Length of the first complete JPEG in the buffer, or -1. Header segments are skipped by their
// declared length; in the entropy-coded data a marker byte is always stuffed (FF 00), so the
// first FF D9 after the scan header is the end of the image.
export function jpegEnd(b: Buffer) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return -1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return -1;
    const marker = b[i + 1];
    const length = b.readUInt16BE(i + 2);
    if (marker === 0xda) {
      for (let k = i + 2 + length; k + 1 < b.length; k++)
        if (b[k] === 0xff && b[k + 1] === 0xd9) return k + 2;
      return -1;
    }
    i += 2 + length;
  }
  return -1;
}
export class JpegEncoder {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private waiting: ((jpeg: Buffer | null) => void)[] = [];
  constructor(
    private width: number,
    private height: number,
    private format: "rgb24" | "gray",
    private ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  ) {}
  private start() {
    const child = spawn(
      this.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        // No input probing: the format is given, and probing would wait for several frames.
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        this.format,
        "-s",
        `${this.width}x${this.height}`,
        "-i",
        "pipe:0",
        // Each image is written out as soon as it is encoded (no output buffering).
        "-flush_packets",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        // One encoder thread: frame threading would hold each image until the next arrives.
        "-threads",
        "1",
        "-q:v",
        "6",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = jpegEnd(this.buffer);
        if (end < 0) break;
        const jpeg = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        this.waiting.shift()?.(Buffer.from(jpeg));
      }
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      for (const w of this.waiting.splice(0)) w(null);
      this.buffer = Buffer.alloc(0);
    });
    this.child = child;
    return child;
  }
  encode(frame: Uint8Array): Promise<Buffer | null> {
    const child = this.child ?? this.start();
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      child.stdin!.write(frame);
    });
  }
  close() {
    const child = this.child;
    this.child = null;
    child?.stdin?.end();
    child?.kill();
  }
}
