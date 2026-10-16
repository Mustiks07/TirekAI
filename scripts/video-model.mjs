// T057: one-time download of the person detector for the processing device and the app's video
// check (no account needed). RF-DETR N/S and D-FINE S COCO checkpoints (Apache-2.0) as ONNX from
// onnx-community on Hugging Face, into VIDEO_MODEL_DIR (default .data/models). Behind a proxy run
// with NODE_USE_ENV_PROXY=1. 8-bit variants only with --int8 (slower than fp32 on tested CPUs).
//   npm run video:model [-- rfdetr-n rfdetr-s dfine-s] [--int8]
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
/* global fetch */

const repos = {
  "rfdetr-n": "onnx-community/rfdetr_nano-ONNX",
  "rfdetr-s": "onnx-community/rfdetr_small-ONNX",
  "dfine-s": "onnx-community/dfine_s_coco-ONNX",
};
const int8 = process.argv.includes("--int8");
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const kinds = named.length ? named : ["rfdetr-n"];
const dir = process.env.VIDEO_MODEL_DIR || ".data/models";
for (const kind of kinds) {
  const repo = repos[kind];
  if (!repo)
    throw new Error(
      kind === "dfine-n"
        ? "dfine-n is no longer offered (missed visible people in verification); use rfdetr-n"
        : `Unknown detector ${kind}`,
    );
  for (const file of [
    "config.json",
    "preprocessor_config.json",
    "onnx/model.onnx",
    ...(int8 ? ["onnx/model_int8.onnx"] : []),
  ]) {
    const target = join(dir, repo, file);
    if (
      await stat(target).then(
        (s) => s.size > 0,
        () => false,
      )
    )
      continue;
    const res = await fetch(
      `https://huggingface.co/${repo}/resolve/main/${file}`,
    );
    if (!res.ok)
      throw new Error(`Download failed ${res.status}: ${repo}/${file}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
  }
  console.log(`${kind}: ${join(dir, repo)}`);
}
