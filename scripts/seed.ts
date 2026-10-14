import { mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { getDatabase } from "../src/server/db/database";
import { Platform } from "../src/server/platform";
async function main() {
  if (process.env.DATABASE_URL)
    throw new Error(
      "Fixture seed is restricted to the local synthetic database.",
    );
  try {
    await access(".local/fixture-accounts.json");
    throw new Error(
      "Fixture file already exists. Reuse the existing accounts.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_PREVIEW = "1";
  const db = await getDatabase();
  const platform = new Platform(db);
  try {
    const accounts = [];
    for (const [name, email] of [
      ["Taraz Market", "taraz-owner@example.test"],
      ["Alatau Store", "alatau-owner@example.test"],
    ]) {
      const password = randomBytes(24).toString("base64url");
      const account = await platform.register({ name, email, password });
      const org = await platform.createOrganization(account.token, {
        name,
        profile: "retail",
      });
      await platform.createBranch(account.token, org.id, { name: "02" });
      await platform.logout(account.token);
      accounts.push({ name, email, password, organizationId: org.id });
    }
    await mkdir(".local", { recursive: true });
    await writeFile(
      ".local/fixture-accounts.json",
      JSON.stringify(accounts, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Two isolated synthetic organizations created. Unique credentials are in ignored .local/fixture-accounts.json. Keep this file private.",
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seed failed");
  process.exitCode = 1;
});
