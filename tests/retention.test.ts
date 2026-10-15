import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryDatabase, migrate } from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import {
  defaultPolicy,
  policyFromEnv,
  retention,
} from "../src/server/ops/retention";

// T053: retention trims operational data only; dry-run changes nothing; business history stays.
it("T053: retention policy dry-run and apply touch only expired operational rows", async () => {
  const db = await createMemoryDatabase();
  try {
    await migrate(db);
    const p = new Platform(db);
    const a = await p.register({
      name: "Retention",
      email: `${randomUUID()}@example.test`,
      password: "Synthetic-Retention-661!",
    });
    const org = (
      await p.createOrganization(a.token, {
        name: "Retention",
        profile: "retail",
      })
    ).id;
    // Fixture: one expired and one live session; an old and a fresh read notification.
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '1 day')",
      [randomUUID(), a.user.id],
    );
    for (const age of ["120 days", "1 day"])
      await db.query(
        `INSERT INTO notifications(id,organization_id,user_id,kind,entity_type,entity_id,dedupe_key,read_at,created_at) VALUES($1,$2,$3,'k','task',$1,$4,now()-interval '${age}',now()-interval '${age}')`,
        [randomUUID(), org, a.user.id, randomUUID()],
      );
    const auditBefore = await db.query(
      "SELECT id FROM audit_events WHERE organization_id=$1",
      [org],
    );
    const dry = await retention(db, defaultPolicy, false);
    expect(dry).toMatchObject({ expired_sessions: 1, read_notifications: 1 });
    expect((await retention(db, defaultPolicy, false)).expired_sessions).toBe(
      1,
    );
    const applied = await retention(db, defaultPolicy, true);
    expect(applied).toMatchObject({
      expired_sessions: 1,
      read_notifications: 1,
    });
    expect(await retention(db, defaultPolicy, false)).toMatchObject({
      expired_sessions: 0,
      read_notifications: 0,
    });
    // The live session still works and the audit history is intact.
    expect((await p.session(a.token)).user?.id).toBe(a.user.id);
    expect(
      await db.query("SELECT id FROM audit_events WHERE organization_id=$1", [
        org,
      ]),
    ).toEqual(auditBefore);
    expect(policyFromEnv({ RETENTION_SYNC_RUN_DAYS: "30" }).syncRunDays).toBe(
      30,
    );
    expect(() => policyFromEnv({ RETENTION_SYNC_RUN_DAYS: "0" })).toThrow(
      "RETENTION_SYNC_RUN_DAYS_INVALID",
    );
  } finally {
    await db.close();
  }
});
