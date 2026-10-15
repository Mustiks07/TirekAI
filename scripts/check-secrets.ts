import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// T053 / AC 17: no secrets in the repository and none in the client bundle. Scans every git-tracked
// file for known credential formats and the built `.next/static` bundle for server secret names,
// connection strings and — when set in this environment — the secret values themselves.
const exec = promisify(execFile);
const patterns: [string, RegExp][] = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  [
    "connection string with password",
    /postgres(?:ql)?:\/\/[^:\s/'"`$]+:[^@\s'"`${]+@/,
  ],
];
const serverSecrets = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "INTEGRATION_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "RESTORE_DATABASE_URL",
  "LOCAL_WORKER_SECRET",
];
async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }))
    if (e.isDirectory()) out.push(...(await files(join(dir, e.name))));
    else out.push(join(dir, e.name));
  return out;
}
async function main() {
  const problems: string[] = [];
  const tracked = (
    await exec("git", ["ls-files", "-z"], { maxBuffer: 64 * 2 ** 20 })
  ).stdout
    .split("\0")
    .filter(Boolean);
  for (const f of tracked) {
    if (/(^|\/)\.env(\.|$)/.test(f) && f !== ".env.example")
      problems.push(`tracked env file: ${f}`);
    if (/\.(png|jpe?g|pdf|ttf|woff2?|ico|zip|gz)$/i.test(f)) continue;
    let text: string;
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const [name, re] of patterns)
      if (re.test(text)) problems.push(`${name} in ${f}`);
  }
  let bundle: string[] = [];
  try {
    bundle = (await files(".next/static")).filter((f) =>
      /\.(js|css|html|json)$/.test(f),
    );
  } catch {
    problems.push("client bundle not built: run npm run build first");
  }
  const values = serverSecrets
    .map((n) => process.env[n])
    .filter((v): v is string => Boolean(v && v.length >= 12));
  for (const f of bundle) {
    const text = await readFile(f, "utf8");
    for (const n of serverSecrets)
      if (text.includes(n))
        problems.push(`server secret name ${n} in client bundle ${f}`);
    for (const [name, re] of patterns)
      if (re.test(text)) problems.push(`${name} in client bundle ${f}`);
    for (const v of values)
      if (text.includes(v))
        problems.push(`server secret value in client bundle ${f}`);
  }
  console.log(
    JSON.stringify(
      {
        trackedFiles: tracked.length,
        bundleFiles: bundle.length,
        checkedValues: values.length,
        problems,
      },
      null,
      2,
    ),
  );
  if (problems.length) process.exitCode = 1;
}
main().catch(() => {
  console.error("CHECK_SECRETS_FAILED");
  process.exitCode = 1;
});
