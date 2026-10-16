import { randomUUID, createHash } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { audit, sessionAccess } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import {
  uploadSchema,
  versionSchema,
  pageQuery,
  pagination,
  customerUpdate,
  type ImportBatch,
  type ImportRow,
  type Customer,
  type BatchView,
  type PageQuery,
} from "../../domain/import-contracts";
import { parseCustomers } from "./csv";
import {
  erasedImportValues,
  importFingerprint,
  lockImportPrivacy,
} from "../privacy/import-erasure";

export async function workerAvailable(tx: Sql) {
  return Boolean(
    (
      await tx.query(
        "SELECT id FROM worker_heartbeat WHERE seen_at>now()-interval '10 seconds'",
      )
    ).length,
  );
}
const batchColumns = `b.id,b.branch_id,b.filename,b.state,b.version,b.created_at,b.completed_at,b.error_code,
 (SELECT count(*)::integer FROM import_rows r WHERE r.batch_id=b.id AND r.organization_id=b.organization_id) AS total,
 (SELECT count(*)::integer FROM import_rows r WHERE r.batch_id=b.id AND r.organization_id=b.organization_id AND r.status='ready') AS ready,
 (SELECT count(*)::integer FROM import_rows r WHERE r.batch_id=b.id AND r.organization_id=b.organization_id AND r.status='invalid') AS invalid,
 (SELECT count(*)::integer FROM import_rows r WHERE r.batch_id=b.id AND r.organization_id=b.organization_id AND r.status='duplicate') AS duplicate,
 (SELECT count(*)::integer FROM import_rows r WHERE r.batch_id=b.id AND r.organization_id=b.organization_id AND r.status='conflict') AS conflict,
 (SELECT count(*)::integer FROM import_rows r WHERE r.batch_id=b.id AND r.organization_id=b.organization_id AND r.status='imported') AS imported`;
type BatchInternal = {
  id: string;
  organization_id: string;
  branch_id: string;
  state: string;
  version: number;
  created_by: string;
  confirmed_by: string | null;
};

export class ImportService {
  constructor(private db: Database) {}
  private async accessBatch(
    tx: Sql,
    secret: string,
    org: string,
    id: string,
    write = false,
  ) {
    idSchema.parse(id);
    const access = await sessionAccess(
      tx,
      secret,
      org,
      write ? "imports:write" : "customers:read",
    );
    const [batch] = await tx.query<BatchInternal>(
      "SELECT id,organization_id,branch_id,state,version,created_by,confirmed_by FROM import_batches WHERE id=$1 AND organization_id=$2 AND ($3::uuid IS NULL OR branch_id=$3)",
      [id, org, access.branchId],
    );
    if (!batch) throw new AppError("NOT_FOUND", 404);
    return { batch, ...access };
  }
  private async view(
    tx: Sql,
    org: string,
    id: string,
    query: PageQuery,
  ): Promise<BatchView> {
    const [batch] = await tx.query<ImportBatch>(
      `SELECT ${batchColumns} FROM import_batches b WHERE b.id=$1 AND b.organization_id=$2`,
      [id, org],
    );
    const rows = await tx.query<ImportRow>(
      'SELECT row_number,data AS "values",status,errors FROM import_rows WHERE batch_id=$1 AND organization_id=$2 ORDER BY row_number LIMIT $3 OFFSET $4',
      [id, org, query.limit, (query.page - 1) * query.limit],
    );
    return {
      batch,
      rows,
      pagination: pagination(query.page, query.limit, batch.total),
      workerAvailable: await workerAvailable(tx),
    };
  }
  async upload(secret: string, org: string, input: unknown) {
    const data = uploadSchema.parse(input);
    // Authenticate before parsing user content, then recheck under the write transaction.
    await this.db.transaction((tx) =>
      sessionAccess(tx, secret, org, "imports:write", data.branchId),
    );
    const rows = parseCustomers(data.content, data.delimiter);
    const hash = createHash("sha256")
      .update(data.delimiter)
      .update("\0")
      .update(data.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"))
      .digest("hex");
    return this.db.transaction(async (tx) => {
      const { actorId } = await sessionAccess(
        tx,
        secret,
        org,
        "imports:write",
        data.branchId,
      );
      const id = randomUUID();
      await lockImportPrivacy(tx, org);
      const tombstones = new Set(
        (
          await tx.query<{ external_hash: string }>(
            "SELECT external_hash FROM privacy_import_tombstones WHERE organization_id=$1 AND branch_id=$2 AND external_hash=ANY($3::text[])",
            [
              org,
              data.branchId,
              rows.map((r) =>
                importFingerprint(org, data.branchId, r.values.external_id),
              ),
            ],
          )
        ).map((r) => r.external_hash),
      );
      let redacted = false;
      for (const row of rows) {
        if (
          tombstones.has(
            importFingerprint(org, data.branchId, row.values.external_id),
          )
        ) {
          row.values = { ...erasedImportValues };
          row.status = "invalid";
          row.errors = ["SUBJECT_ERASED"];
          redacted = true;
        }
      }
      const inserted = await tx.query(
        "INSERT INTO import_batches(id,organization_id,branch_id,created_by,filename,file_hash,source_content) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,branch_id,file_hash) DO NOTHING RETURNING id",
        [
          id,
          org,
          data.branchId,
          actorId,
          data.filename,
          hash,
          redacted ? "" : data.content,
        ],
      );
      if (!inserted.length) {
        const [previous] = await tx.query<{ id: string }>(
          "SELECT id FROM import_batches WHERE organization_id=$1 AND branch_id=$2 AND file_hash=$3",
          [org, data.branchId, hash],
        );
        return {
          ...(await this.view(tx, org, previous.id, pageQuery.parse({}))),
          reused: true,
        };
      }
      const existing = await tx.query<{
        external_id: string;
        name: string;
        email: string;
        phone: string;
      }>(
        "SELECT external_id,name,email,phone FROM customers WHERE organization_id=$1 AND branch_id=$2 AND external_id=ANY($3::text[])",
        [
          org,
          data.branchId,
          rows
            .filter((r) => r.status === "ready")
            .map((r) => r.values.external_id),
        ],
      );
      const byId = new Map(existing.map((row) => [row.external_id, row]));
      for (const row of rows) {
        const prior = byId.get(row.values.external_id);
        if (row.status === "ready" && prior) {
          const same =
            prior.name === row.values.name &&
            prior.email === row.values.email &&
            prior.phone === row.values.phone;
          row.status = same ? "duplicate" : "conflict";
          row.errors = [same ? "ALREADY_IMPORTED" : "EXISTING_CONFLICT"];
        }
      }
      // One bounded insert, rather than a SQL round trip for each row.
      await tx.query(
        `INSERT INTO import_rows(organization_id,batch_id,row_number,data,status,errors)
        SELECT $1,$2,r.row_number,r.data,r.status,r.errors FROM jsonb_to_recordset($3::jsonb) AS r(row_number integer,data jsonb,status text,errors jsonb)`,
        [
          org,
          id,
          JSON.stringify(
            rows.map((r) => ({
              row_number: r.row_number,
              data: r.values,
              status: r.status,
              errors: r.errors,
            })),
          ),
        ],
      );
      await audit(tx, org, actorId, "import.previewed", data.branchId, {
        rows: String(rows.length),
      });
      return {
        ...(await this.view(tx, org, id, pageQuery.parse({}))),
        reused: false,
      };
    });
  }
  async get(secret: string, org: string, id: string, input: unknown = {}) {
    const query = pageQuery.parse(input);
    return this.db.transaction(async (tx) => {
      await this.accessBatch(tx, secret, org, id);
      return this.view(tx, org, id, query);
    });
  }
  async list(secret: string, org: string, input: unknown = {}) {
    const query = pageQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(
        tx,
        secret,
        org,
        "customers:read",
        query.branchId,
      );
      const [count] = await tx.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM import_batches WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)",
        [org, scope.branchId],
      );
      const items = await tx.query<ImportBatch>(
        `SELECT ${batchColumns} FROM import_batches b WHERE b.organization_id=$1 AND ($2::uuid IS NULL OR b.branch_id=$2) ORDER BY b.created_at DESC,b.id DESC LIMIT $3 OFFSET $4`,
        [org, scope.branchId, query.limit, (query.page - 1) * query.limit],
      );
      return {
        items,
        pagination: pagination(query.page, query.limit, count.total),
        workerAvailable: await workerAvailable(tx),
      };
    });
  }
  async confirm(secret: string, org: string, id: string, input: unknown) {
    const data = versionSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const { actorId } = await this.accessBatch(tx, secret, org, id, true);
      const [batch] = await tx.query<BatchInternal>(
        "SELECT * FROM import_batches WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, org],
      );
      // Repeated delivery of the original confirmation returns the same job/result.
      if (batch.state !== "preview")
        return this.view(tx, org, id, pageQuery.parse({}));
      if (batch.version !== data.version)
        throw new AppError("VERSION_CONFLICT", 409);
      const [count] = await tx.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM import_rows WHERE organization_id=$1 AND batch_id=$2 AND status='ready'",
        [org, id],
      );
      if (!count.total) throw new AppError("IMPORT_NO_ROWS", 409);
      await tx.query(
        "UPDATE import_batches SET state='queued',version=version+1,confirmed_by=$3 WHERE organization_id=$1 AND id=$2",
        [org, id, actorId],
      );
      await tx.query(
        "INSERT INTO outbox_events(id,organization_id,branch_id,batch_id,actor_id,topic,event_key) VALUES($1,$2,$3,$4,$5,'import.requested',$6)",
        [randomUUID(), org, batch.branch_id, id, actorId, `${id}:requested`],
      );
      await audit(tx, org, actorId, "import.confirmed", batch.branch_id, {
        rows: String(count.total),
      });
      return this.view(tx, org, id, pageQuery.parse({}));
    });
  }
  async retry(secret: string, org: string, id: string, input: unknown) {
    const data = versionSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const { actorId } = await this.accessBatch(tx, secret, org, id, true);
      const [batch] = await tx.query<BatchInternal>(
        "SELECT * FROM import_batches WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, org],
      );
      if (batch.version !== data.version)
        throw new AppError("VERSION_CONFLICT", 409);
      if (!["failed", "cancelled"].includes(batch.state))
        throw new AppError("IMPORT_NOT_RETRYABLE", 409);
      await tx.query(
        "UPDATE jobs SET state='queued',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL,actor_id=$3 WHERE organization_id=$1 AND batch_id=$2",
        [org, id, actorId],
      );
      await tx.query(
        "UPDATE import_batches SET state='queued',error_code=NULL,completed_at=NULL,version=version+1,confirmed_by=$3 WHERE organization_id=$1 AND id=$2",
        [org, id, actorId],
      );
      await audit(tx, org, actorId, "import.retried", batch.branch_id);
      return this.view(tx, org, id, pageQuery.parse({}));
    });
  }
  async customers(secret: string, org: string, input: unknown = {}) {
    const query = pageQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(
        tx,
        secret,
        org,
        "customers:read",
        query.branchId,
      );
      const [count] = await tx.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM customers WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)",
        [org, scope.branchId],
      );
      const items = await tx.query<Customer>(
        `SELECT c.id,c.branch_id,c.external_id,c.name,c.email,c.phone,c.version,c.created_at,c.updated_at,b.filename AS source_file,c.source_row
        FROM customers c LEFT JOIN import_batches b ON b.id=c.source_batch_id AND b.organization_id=c.organization_id
        WHERE c.organization_id=$1 AND ($2::uuid IS NULL OR c.branch_id=$2) ORDER BY c.created_at DESC,c.id DESC LIMIT $3 OFFSET $4`,
        [org, scope.branchId, query.limit, (query.page - 1) * query.limit],
      );
      return {
        items,
        pagination: pagination(query.page, query.limit, count.total),
      };
    });
  }
  async updateCustomer(
    secret: string,
    org: string,
    id: string,
    input: unknown,
  ) {
    idSchema.parse(id);
    const data = customerUpdate.parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(tx, secret, org, "customers:write");
      const [customer] = await tx.query<{
        branch_id: string;
        version: number;
        erased_at: string | null;
      }>(
        "SELECT branch_id,version,erased_at FROM customers WHERE id=$1 AND organization_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) FOR UPDATE",
        [id, org, scope.branchId],
      );
      if (!customer) throw new AppError("NOT_FOUND", 404);
      if (customer.erased_at) throw new AppError("SUBJECT_ERASED", 409);
      if (customer.version !== data.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "UPDATE customers SET name=$1,email=$2,phone=$3,version=version+1,updated_at=now() WHERE id=$4 AND organization_id=$5",
        [data.name, data.email.toLowerCase(), data.phone, id, org],
      );
      await audit(
        tx,
        org,
        scope.actorId,
        "customer.updated",
        customer.branch_id,
        { customerId: id },
      );
      return { ok: true as const };
    });
  }
}
