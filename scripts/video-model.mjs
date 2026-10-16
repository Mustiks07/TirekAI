// T057: one-time download of the person detector for the processing device (no account needed).
// D-FINE COCO checkpoints (Apache-2.0) as ONNX from onnx-community on Hugging Face, into
// VIDEO_MODEL_DIR (default .data/models). Behind a proxy run with NODE_USE_ENV_PROXY=1.
//   npm run video:model [-- dfine-n dfine-s]
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
/* global fetch */

const repos = {
  "dfine-n": "onnx-community/dfine_n_coco-ONNX",
  "dfine-s": "onnx-community/dfine_s_coco-ONNX",
};
const kinds = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["dfine-n"];
const dir = process.env.VIDEO_MODEL_DIR || ".data/models";
for (const kind of kinds) {
  const repo = repos[kind];
  if (!repo) throw new Error(`Unknown detector ${kind}`);
  for (const file of [
    "config.json",
    "preprocessor_config.json",
    "onnx/model.onnx",
    "onnx/model_int8.onnx",
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
