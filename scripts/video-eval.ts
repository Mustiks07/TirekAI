import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import {
  labClips,
  renderClip,
  LAB_CONFIG,
} from "../src/server/video/synthetic";
import {
  processVideo,
  PROCESSOR_VERSION,
  type VideoEvent,
} from "../src/server/video/processor";
import { judge, scoreClip } from "../src/server/video/evaluate";

// T037 lab evaluation: renders the labelled synthetic clips, processes them with the real
// processor and scores them against the protocol. Result: experimental at best (synthetic set).
const dir = ".data/video-lab";
await mkdir(dir, { recursive: true });
const results = [];
for (const clip of labClips()) {
  const file = `${dir}/${clip.name}.mp4`;
  const truth = await renderClip(clip, file);
  const start = new Date("2026-10-15T09:00:00Z");
  const events: VideoEvent[] = [];
  const run = await processVideo({
    input: ["-i", file],
    config: LAB_CONFIG,
    startTime: start,
    live: false,
    onEvents: async (e) => {
      events.push(...e);
    },
  });
  results.push(scoreClip(clip.name, clip.scenario, truth, events, run, start));
  console.log(`${clip.name}: ${JSON.stringify(results.at(-1))}`);
}
const evaluations = judge(results, {
  name: "taraz-lab-synthetic-v1",
  kind: "synthetic_lab",
});
const report = {
  checked: new Date().toISOString().slice(0, 10),
  processor: PROCESSOR_VERSION,
  hardware: {
    cpu: os.cpus()[0]?.model || "unknown",
    cores: os.cpus().length,
    platform: `${os.platform()} ${os.arch()}`,
  },
  note: "Rendered synthetic clips with renderer ground truth; not a substitute for permitted real recordings.",
  clips: results,
  evaluations,
};
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  `docs/evidence/video-eval-${report.checked}.json`,
  JSON.stringify(report, null, 2),
);
await writeFile(
  "src/server/video/lab-evaluation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(evaluations, null, 2));
