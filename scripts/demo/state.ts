// Demo baseline of the local PGlite database: a full copy of the data directory, taken and
// restored only while no process holds the database (.process-lock). Local synthetic data only.
import { cp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function localDatabase() {
  if (process.env.DATABASE_URL) throw new Error("LOCAL_ONLY");
  const dir = resolve(process.env.PGLITE_DATA_DIR || ".data/local");
  if (!dir.startsWith(resolve(".data") + sep))
    throw new Error("LOCAL_DATA_DIRECTORY_REQUIRED");
  return dir;
}
const baselineDir = () => `${localDatabase()}-demo-baseline`;
async function assertStopped(dir: string) {
  try {
    const pid = Number(await readFile(resolve(dir, ".process-lock"), "utf8"));
    try {
      process.kill(pid, 0);
    } catch {
      return; // stale lock of a finished process
    }
    throw new Error("STOP_THE_LOCAL_SERVER_FIRST");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
export async function saveBaseline() {
  const dir = localDatabase(),
    target = baselineDir();
  await assertStopped(dir);
  await rm(target, { recursive: true, force: true });
  await cp(dir, target, {
    recursive: true,
    filter: (p) => !p.endsWith(".process-lock"),
  });
  await writeFile(
    resolve(target, ".demo-baseline.json"),
    JSON.stringify({ savedAt: new Date().toISOString() }),
  );
}
export async function restoreBaseline() {
  const dir = localDatabase(),
    source = baselineDir();
  await stat(resolve(source, ".demo-baseline.json")).catch(() => {
    throw new Error("NO_DEMO_BASELINE_RUN_DEMO_PREPARE");
  });
  await assertStopped(dir);
  await rm(dir, { recursive: true, force: true });
  await cp(source, dir, {
    recursive: true,
    filter: (p) => !p.endsWith(".demo-baseline.json"),
  });
}
