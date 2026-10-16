import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idempotent } from "../execution/core";
import {
  erasedImportValues,
  importFingerprint,
  lockImportPrivacy,
} from "./import-erasure";

// T053 / SPECIFICATION §20: erasure of personal data on request. The subject row stays so that
// orders, payments and stock documents remain linked (accounting records are kept as required);
// personal fields, free-text notes, raw import rows and messages are replaced, external links are
// marked deleted so a later sync cannot write the data back, and the subject is locked.
export const erasureInput = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    reason: z.enum([
      "subject_request",
      "retention_expired",
      "consent_withdrawn",
    ]),
  })
  .strict();
export const erasureResult = z
  .object({
    id: z.uuid(),
    reused: z.boolean(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
const REMOVED = "[удалено]";
const count = async (tx: Sql, sql: string, params: unknown[]) =>
  (await tx.query(`${sql} RETURNING 1`, params)).length;
export class PrivacyService {
  constructor(private db: Database) {}
  private async recorded(tx: Sql, org: string, id: string) {
    const [r] = await tx.query<{ counts: Record<string, number> }>(
      "SELECT counts FROM privacy_requests WHERE organization_id=$1 AND id=$2",
      [org, id],
    );
    return r?.counts ?? {};
  }
  async eraseCustomer(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = erasureInput.parse(input);
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => {
      // Owner only: erasure cannot be undone.
      const s = await sessionAccess(tx, secret, org, "organization:write");
      await lockImportPrivacy(tx, org);
      const r = await idempotent(tx, org, c.key, {
        operation: "privacy.erase_customer",
        id,
        ...c,
      });
      if (r.reused)
        return {
          id: r.id,
          reused: true,
          counts: await this.recorded(tx, org, r.id),
        };
      const [customer] = await tx.query<{
        branch_id: string;
        version: number;
        external_id: string;
        erased_at: string | null;
        technical: boolean;
      }>(
        "SELECT c.branch_id,c.version,c.external_id,c.erased_at::text,(EXISTS(SELECT 1 FROM clinic_billing_customers b WHERE b.organization_id=c.organization_id AND b.customer_id=c.id) OR c.external_id LIKE 'kaspi:%') technical FROM customers c WHERE c.organization_id=$1 AND c.id=$2 AND ($3::uuid IS NULL OR c.branch_id=$3) FOR UPDATE",
        [org, id, s.branchId],
      );
      if (!customer) throw new AppError("NOT_FOUND", 404);
      if (customer.erased_at) throw new AppError("SUBJECT_ERASED", 409);
      // Technical settlement customers (clinic billing, sales channel) hold no person's data.
      if (customer.technical) throw new AppError("TECHNICAL_CUSTOMER", 409);
      if (customer.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      const counts: Record<string, number> = {};
      await tx.query(
        "INSERT INTO privacy_import_tombstones(organization_id,branch_id,external_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          org,
          customer.branch_id,
          importFingerprint(org, customer.branch_id, customer.external_id),
        ],
      );
      // Remove the entire source attachment: even invalid/extra columns can contain personal
      // data. Other customers' parsed rows, accounting links and the deduplication hash remain.
      counts.importSources = await count(
        tx,
        "UPDATE import_batches b SET source_content='' WHERE b.organization_id=$1 AND b.branch_id=$3 AND EXISTS(SELECT 1 FROM import_rows r WHERE r.organization_id=b.organization_id AND r.batch_id=b.id AND (r.customer_id=$2 OR r.data->>'external_id'=$4))",
        [org, id, customer.branch_id, customer.external_id],
      );
      counts.customer = await count(
        tx,
        "UPDATE customers SET name=$3,email='',phone='',external_id=$4,responsible_id=NULL,consents='{\"email\":false,\"sms\":false,\"messenger\":false}'::jsonb,erased_at=now(),version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          `Удалённый клиент · Жойылған клиент ${id.slice(0, 8)}`,
          `erased:${id}`,
        ],
      );
      counts.inquiries = await count(
        tx,
        "UPDATE inquiries SET title=$3,message='',external_id='',version=version+1 WHERE organization_id=$1 AND customer_id=$2",
        [org, id, REMOVED],
      );
      counts.crmNotes = await count(
        tx,
        "UPDATE crm_events SET note=$3,data='{}'::jsonb WHERE organization_id=$1 AND customer_id=$2",
        [org, id, REMOVED],
      );
      counts.importRows = await count(
        tx,
        "UPDATE import_rows r SET data=$5::jsonb,errors='[\"SUBJECT_ERASED\"]'::jsonb,status=CASE WHEN status='ready' THEN 'invalid' ELSE status END WHERE organization_id=$1 AND (customer_id=$2 OR (data->>'external_id'=$4 AND EXISTS(SELECT 1 FROM import_batches b WHERE b.organization_id=r.organization_id AND b.id=r.batch_id AND b.branch_id=$3)))",
        [
          org,
          id,
          customer.branch_id,
          customer.external_id,
          JSON.stringify(erasedImportValues),
        ],
      );
      counts.messages = await count(
        tx,
        "UPDATE messaging_messages SET text=$3 WHERE organization_id=$1 AND customer_id=$2",
        [org, id, REMOVED],
      );
      counts.syncConflicts = await count(
        tx,
        "UPDATE sync_conflicts SET local=NULL,remote='{}'::jsonb,state='kept_local',resolved_by=$3,resolved_at=now() WHERE organization_id=$1 AND internal_id=$2",
        [org, id, s.actorId],
      );
      counts.messagingLinks = await count(
        tx,
        "DELETE FROM messaging_links WHERE organization_id=$1 AND customer_id=$2",
        [org, id],
      );
      // External contact/chat links: a later sync must not re-create the person's data.
      counts.externalLinks = await count(
        tx,
        "UPDATE integration_mappings SET state='deleted',updated_at=now() WHERE organization_id=$1 AND internal_id=$2 AND entity_type IN ('contact','chat','partner') AND state<>'deleted'",
        [org, id],
      );
      await tx.query(
        "INSERT INTO crm_events(id,organization_id,customer_id,kind,note,actor_id) VALUES($1,$2,$3,'customer.erased',$4,$5)",
        [r.id, org, id, c.reason, s.actorId],
      );
      await tx.query(
        "INSERT INTO privacy_requests(id,organization_id,branch_id,subject_type,subject_id,reason,counts,actor_id) VALUES($1,$2,$3,'customer',$4,$5,$6,$7)",
        [
          r.id,
          org,
          customer.branch_id,
          id,
          c.reason,
          JSON.stringify(counts),
          s.actorId,
        ],
      );
      await audit(
        tx,
        org,
        s.actorId,
        "privacy.customer_erased",
        customer.branch_id,
        {
          customerId: id,
          reason: c.reason,
        },
      );
      return { id: r.id, reused: false, counts };
    });
  }
  // Administrative clinic request (T047): patient name/contact in the document, its history
  // snapshots and staff notes are removed; times, service and billing stay.
  async eraseClinicRequest(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = erasureInput.parse(input);
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:write");
      const r = await idempotent(tx, org, c.key, {
        operation: "privacy.erase_clinic",
        id,
        ...c,
      });
      if (r.reused)
        return {
          id: r.id,
          reused: true,
          counts: await this.recorded(tx, org, r.id),
        };
      const [doc] = await tx.query<{
        branch_id: string;
        version: number;
        erased_at: string | null;
      }>(
        "SELECT branch_id,version,erased_at::text FROM industry_documents WHERE organization_id=$1 AND id=$2 AND kind='clinic' AND ($3::uuid IS NULL OR branch_id=$3) FOR UPDATE",
        [org, id, s.branchId],
      );
      if (!doc) throw new AppError("NOT_FOUND", 404);
      if (doc.erased_at) throw new AppError("SUBJECT_ERASED", 409);
      if (doc.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      const scrub =
        "jsonb_set(jsonb_set(data,'{patientName}',to_jsonb($3::text)),'{contact}','\"\"'::jsonb)";
      const counts: Record<string, number> = {};
      counts.document = await count(
        tx,
        `UPDATE industry_documents SET title=$3,data=${scrub},erased_at=now(),version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [org, id, REMOVED],
      );
      counts.history = await count(
        tx,
        `UPDATE industry_history SET data=CASE WHEN data ? 'patientName' THEN ${scrub} ELSE data END,note=$3 WHERE organization_id=$1 AND document_id=$2`,
        [org, id, REMOVED],
      );
      await tx.query(
        "INSERT INTO privacy_requests(id,organization_id,branch_id,subject_type,subject_id,reason,counts,actor_id) VALUES($1,$2,$3,'clinic_request',$4,$5,$6,$7)",
        [
          r.id,
          org,
          doc.branch_id,
          id,
          c.reason,
          JSON.stringify(counts),
          s.actorId,
        ],
      );
      await audit(
        tx,
        org,
        s.actorId,
        "privacy.clinic_request_erased",
        doc.branch_id,
        {
          documentId: id,
          reason: c.reason,
        },
      );
      return { id: r.id, reused: false, counts };
    });
  }
  async requests(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "organization:write");
      return {
        items: await tx.query(
          "SELECT id,branch_id,subject_type,subject_id,reason,counts,actor_id,created_at::text FROM privacy_requests WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200",
          [org],
        ),
      };
    });
  }
}
