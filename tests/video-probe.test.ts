import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  probeSource,
  redactSource,
  streamTrial,
} from "../src/server/video/probe";
import { judge, type ClipResult } from "../src/server/video/evaluate";
import { labClips, renderClip } from "../src/server/video/synthetic";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
it("T057: camera addresses are reported without credentials or tokens", () => {
  expect(
    redactSource("rtsp://admin:S3cret@10.0.0.7:554/Streaming/101?token=abc"),
  ).toBe("rtsp://***@10.0.0.7:554/Streaming/101?***");
  expect(redactSource("rtsp://10.0.0.7/live")).toBe("rtsp://10.0.0.7/live");
  expect(redactSource("C:\\video\\clip.mp4")).toBe("[local source]");
});
it("T057: only a permitted recorded set that meets the thresholds validates a detector; the same metrics on a synthetic set stay experimental", () => {
  const clip = (i: number): ClipResult => ({
    clip: `c${i}`,
    scenario: "recorded",
    truthCrossings: 40,
    detectedCrossings: 38,
    matched: 37,
    countError: 0.05,
    precision: 37 / 38,
    recall: 37 / 40,
    truthQueues: 4,
    detectedQueues: 4,
    queueMatched: 4,
    run: {
      frames: 900,
      unusable: 0,
      fps: 200,
      latencyMs: 5,
      ended: "end_of_stream",
    },
  });
  const set = [clip(1), clip(2), clip(3)];
  const recorded = judge(set, { name: "site", kind: "recorded" });
  expect(recorded.find((v) => v.detector === "line_crossing")).toMatchObject({
    status: "validated",
    reason: "thresholds_met",
  });
  expect(
    judge(set, { name: "lab", kind: "synthetic_lab" }).find(
      (v) => v.detector === "line_crossing",
    ),
  ).toMatchObject({
    status: "experimental",
    reason: "thresholds_met_on_synthetic_only",
  });
  // Two clips are not enough even with perfect numbers.
  expect(
    judge(set.slice(0, 2), { name: "site", kind: "recorded" })[0],
  ).toMatchObject({ status: "experimental", reason: "dataset_too_small" });
});
describe.skipIf(!hasFfmpeg)("T057 source probe with ffmpeg", () => {
  it("probes a recording: passport, processing speed, end of stream", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "taraz-probe-"));
    const file = path.join(dir, "clip.mp4");
    const clip = { ...labClips()[0], seconds: 6 };
    await renderClip(clip, file);
    const p = await probeSource(["-i", file]);
    expect(p).toMatchObject({
      ok: true,
      passport: { codec: "mpeg4", width: 320, height: 180 },
    });
    const t = await streamTrial({
      input: ["-i", file],
      seconds: 30,
      live: false,
    });
    expect(t.ended).toBe("end_of_stream");
    expect(t.frames).toBeGreaterThanOrEqual(50);
    expect(t.stopMs).toBeNull();
    expect(t.firstFrameWithinMs).not.toBeNull();
  });
  it("stops an endless live source on request and measures the stop time", async () => {
    // A generated test signal stands in for an endless stream; it is not a camera result.
    const t = await streamTrial({
      input: ["-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15"],
      seconds: 2,
      live: true,
    });
    expect(t.ended).toBe("aborted");
    expect(t.frames).toBeGreaterThan(5);
    expect(t.stopMs).toBeLessThan(2000);
    expect(t.deliveredFps).toBeGreaterThan(3);
  });
  it("an unreachable camera is reported by code, without the password", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const a = s.address() as { port: number };
        s.close(() => resolve(a.port));
      });
    });
    const url = `rtsp://admin:S3cret@127.0.0.1:${port}/live`;
    const p = await probeSource(["-rtsp_transport", "tcp", "-i", url], {
      timeoutMs: 10_000,
    });
    expect(p.ok).toBe(false);
    // Windows/firewalls may drop the connection instead of immediately rejecting it.
    if (!p.ok) expect(["connection_refused", "timeout"]).toContain(p.error);
    expect(JSON.stringify(p)).not.toContain("S3cret");
  });
});
