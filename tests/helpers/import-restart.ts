import { getDatabase } from "../../src/server/db/database";
import { Platform } from "../../src/server/platform";
import { ImportService } from "../../src/server/imports/service";
import { ImportWorker } from "../../src/server/jobs/worker";
const db = await getDatabase();
if (process.argv[2] === "prepare") {
  const platform = new Platform(db),
    imports = new ImportService(db);
  const owner = await platform.register({
    name: "Restart Test",
    email: "restart@example.test",
    password: "Synthetic-Restart-Password-921!",
  });
  const org = await platform.createOrganization(owner.token, {
    name: "Restart Test",
    profile: "retail",
  });
  const branch = (await platform.workspace(owner.token, org.id)).branches[0].id;
  const b = await imports.upload(owner.token, org.id, {
    branchId: branch,
    filename: "restart.csv",
    delimiter: ",",
    content:
      "external_id,name,email,phone\n" +
      Array.from(
        { length: 31 },
        (_, i) => `C${i},Клиент ${i},c${i}@example.test,\n`,
      ).join(""),
  });
  await imports.confirm(owner.token, org.id, b.batch.id, {
    version: b.batch.version,
  });
}
await new ImportWorker(db).runOnce();
const [result] = await db.query(
  "SELECT (SELECT count(*)::int FROM customers) AS customers,(SELECT state FROM import_batches LIMIT 1) AS state",
);
await db.close();
console.log(JSON.stringify(result));
