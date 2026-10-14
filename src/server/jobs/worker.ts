import { randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import { actorAccess, audit } from "../access";
import { AppError } from "../../domain/errors";
import type { ImportRow } from "../../domain/import-contracts";
export type Claim = {
  id: string;
  organization_id: string;
  branch_id: string;
  batch_id: string;
  actor_id: string;
  lease_token: string;
  attempts: number;
};
export class ImportWorker {
  constructor(private db: Database) {}
  async dispatch() {
    return this.db.transaction(async (tx) => {
      const events = await tx.query<{
        id: string;
        organization_id: string;
        branch_id: string;
        batch_id: string;
        actor_id: string;
      }>(
        "SELECT * FROM outbox_events WHERE topic='import.requested' AND dispatched_at IS NULL ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED",
      );
      for (const e of events) {
        await tx.query(
          "INSERT INTO jobs(id,organization_id,branch_id,batch_id,event_id,actor_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [
            randomUUID(),
            e.organization_id,
            e.branch_id,
            e.batch_id,
            e.id,
            e.actor_id,
          ],
        );
        await tx.query(
          "UPDATE outbox_events SET dispatched_at=now() WHERE id=$1",
          [e.id],
        );
      }
      return events.length;
    });
  }
  async claim(): Promise<Claim | undefined> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx.query<Claim>(
        "SELECT * FROM jobs WHERE (state='queued' AND available_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!job) return;
      const token = randomUUID();
      const [claimed] = await tx.query<Claim>(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
        [job.id, token],
      );
      return claimed;
    });
  }
  async process(claim: Claim, afterInsert?: () => void) {
    try {
      return await this.db.transaction(async (tx) => {
        // All processing/retry paths lock the batch before the job.
        await tx.query("SELECT id FROM import_batches WHERE id=$1 FOR UPDATE", [
          claim.batch_id,
        ]);
        const [job] = await tx.query<Claim>(
          "SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
          [claim.id, claim.lease_token],
        );
        if (!job) return false;
        try {
          await actorAccess(
            tx,
            job.actor_id,
            job.organization_id,
            "imports:write",
            job.branch_id,
          );
        } catch (error) {
          if (error instanceof AppError && error.status === 403) {
            await tx.query(
              "UPDATE jobs SET state='cancelled',error_code='ACCESS_REVOKED',lease_token=NULL,lease_until=NULL WHERE id=$1",
              [job.id],
            );
            await tx.query(
              "UPDATE import_batches SET state='cancelled',error_code='ACCESS_REVOKED',version=version+1 WHERE id=$1",
              [job.batch_id],
            );
            await audit(
              tx,
              job.organization_id,
              job.actor_id,
              "import.cancelled",
              job.branch_id,
            );
            return true;
          }
          throw error;
        }
        if (job.attempts > 3) throw new AppError("RETRY_EXHAUSTED", 500);
        const rows = await tx.query<{
          row_number: number;
          data: ImportRow["values"];
        }>(
          "SELECT row_number,data FROM import_rows WHERE organization_id=$1 AND batch_id=$2 AND status='ready' ORDER BY row_number LIMIT 25 FOR UPDATE",
          [job.organization_id, job.batch_id],
        );
        for (const row of rows) {
          const v = row.data;
          const [inserted] = await tx.query<{ id: string }>(
            "INSERT INTO customers(id,organization_id,branch_id,external_id,name,email,phone,source_batch_id,source_row) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id,branch_id,external_id) DO NOTHING RETURNING id",
            [
              randomUUID(),
              job.organization_id,
              job.branch_id,
              v.external_id,
              v.name,
              v.email,
              v.phone,
              job.batch_id,
              row.row_number,
            ],
          );
          afterInsert?.();
          let status = "imported",
            errors: string[] = [],
            customerId = inserted?.id;
          if (!inserted) {
            const [existing] = await tx.query<
              ImportRow["values"] & { id: string }
            >(
              "SELECT * FROM customers WHERE organization_id=$1 AND branch_id=$2 AND external_id=$3",
              [job.organization_id, job.branch_id, v.external_id],
            );
            const same =
              existing.name === v.name &&
              existing.email === v.email &&
              existing.phone === v.phone;
            status = same ? "duplicate" : "conflict";
            errors = [same ? "ALREADY_IMPORTED" : "EXISTING_CONFLICT"];
            customerId = existing.id;
          }
          await tx.query(
            "UPDATE import_rows SET status=$4,errors=$5,customer_id=$6 WHERE organization_id=$1 AND batch_id=$2 AND row_number=$3",
            [
              job.organization_id,
              job.batch_id,
              row.row_number,
              status,
              JSON.stringify(errors),
              customerId,
            ],
          );
        }
        const [counts] = await tx.query<{
          ready: number;
          bad: number;
          imported: number;
        }>(
          "SELECT count(*) FILTER(WHERE status='ready')::int ready,count(*) FILTER(WHERE status IN ('invalid','conflict'))::int bad,count(*) FILTER(WHERE status='imported')::int imported FROM import_rows WHERE organization_id=$1 AND batch_id=$2",
          [job.organization_id, job.batch_id],
        );
        if (counts.ready) {
          await tx.query(
            "UPDATE jobs SET state='queued',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",
            [job.id],
          );
          await tx.query(
            "UPDATE import_batches SET state='running',version=version+1 WHERE id=$1",
            [job.batch_id],
          );
        } else {
          await tx.query(
            "UPDATE jobs SET state='completed',error_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",
            [job.id],
          );
          await tx.query(
            "UPDATE import_batches SET state=$2,completed_at=now(),error_code=NULL,version=version+1 WHERE id=$1",
            [job.batch_id, counts.bad ? "partial" : "completed"],
          );
          await audit(
            tx,
            job.organization_id,
            job.actor_id,
            "import.completed",
            job.branch_id,
            { imported: String(counts.imported) },
          );
          await tx.query(
            "INSERT INTO outbox_events(id,organization_id,branch_id,batch_id,actor_id,topic,event_key) VALUES($1,$2,$3,$4,$5,'import.completed',$6) ON CONFLICT DO NOTHING",
            [
              randomUUID(),
              job.organization_id,
              job.branch_id,
              job.batch_id,
              job.actor_id,
              `${job.batch_id}:completed`,
            ],
          );
        }
        return true;
      });
    } catch {
      await this.db.transaction(async (tx) => {
        await tx.query("SELECT id FROM import_batches WHERE id=$1 FOR UPDATE", [
          claim.batch_id,
        ]);
        const [job] = await tx.query<Claim>(
          "SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
          [claim.id, claim.lease_token],
        );
        if (!job) return;
        const failed = job.attempts >= 3;
        await tx.query(
          "UPDATE jobs SET state=$2,error_code='WORKER_FAILURE',lease_token=NULL,lease_until=NULL,available_at=now()+interval '2 seconds' WHERE id=$1",
          [job.id, failed ? "failed" : "queued"],
        );
        await tx.query(
          "UPDATE import_batches SET state=$2,error_code='WORKER_FAILURE',version=version+1 WHERE id=$1",
          [job.batch_id, failed ? "failed" : "queued"],
        );
      });
      return true;
    }
  }
  async runOnce() {
    await this.db.query(
      "INSERT INTO worker_heartbeat(id,seen_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at",
    );
    await this.dispatch();
    const claim = await this.claim();
    return { worked: claim ? await this.process(claim) : false };
  }
}
