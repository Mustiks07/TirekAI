// T057 live view of a camera that is processed on another device. The processing device sends
// the frame it has just analyzed (JPEG at the detector's size) with the boxes found on it, and
// only while someone in the app is watching that source. The latest frame per source is kept in
// this server's memory for a few seconds; nothing is written to disk or the database, and frames
// are returned only through the authorized, branch-scoped app API (never by URL or token).
export type PreviewFrame = {
  org: string;
  runId: string;
  at: string;
  received: number;
  image: string;
  width: number;
  height: number;
  visible: number;
  people: {
    id: number;
    box: [number, number, number, number] | null;
    counted: boolean;
    seen: boolean;
  }[];
  zones: Record<string, number>;
  crossings: Record<string, { in: number; out: number }>;
};
// A viewer asks again at least every few seconds; after this the device stops sending.
export const VIEW_HOLD_MS = 15_000;
// An older frame is not shown as "now".
export const FRAME_FRESH_MS = 10_000;
class PreviewStore {
  private frames = new Map<string, PreviewFrame>();
  private viewers = new Map<string, number>();
  watch(source: string) {
    this.viewers.set(source, Date.now() + VIEW_HOLD_MS);
  }
  unwatch(source: string) {
    this.viewers.delete(source);
    this.frames.delete(source);
  }
  wanted(source: string) {
    const until = this.viewers.get(source) ?? 0;
    if (until > Date.now()) return true;
    // Nobody watches: the last frame is dropped too.
    this.viewers.delete(source);
    this.frames.delete(source);
    return false;
  }
  put(source: string, frame: PreviewFrame) {
    if (!this.wanted(source)) return false;
    this.frames.set(source, frame);
    return true;
  }
  get(source: string, org: string) {
    const f = this.frames.get(source);
    if (!f || f.org !== org || Date.now() - f.received > FRAME_FRESH_MS)
      return null;
    return f;
  }
}
const g = globalThis as unknown as { videoPreviewStore?: PreviewStore };
export function previewStore() {
  g.videoPreviewStore ??= new PreviewStore();
  return g.videoPreviewStore;
}
