import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { pagination } from "../../domain/import-contracts";
import {
  customerInput,
  customerProfile,
  inquiryInput,
  inquiryCommand,
  quoteInput,
  quoteUpdate,
  quoteConvert,
  crmQuery,
  pipelineInput,
  defaultStages,
  type Quote,
} from "../../domain/crm";
import { discountedTotal } from "../../domain/commerce";
import { toBase, type Item } from "../../domain/inventory";
import { CommerceService } from "../commerce/service";
const customerColumns =
  "c.id,c.branch_id,c.name,c.email,c.phone,c.kind,c.responsible_id,c.consents,c.version,c.created_at";
const inquiryColumns =
  "i.id,i.customer_id,c.name customer_name,i.branch_id,i.source,i.external_id,i.title,i.message,i.responsible_id,i.stage_id,i.version,i.created_at";
const quoteColumns =
  "q.id,q.inquiry_id,i.customer_id,c.name customer_name,i.branch_id,q.number,q.version,q.data,q.order_id,q.created_at";
async function command(
  tx: Sql,
  org: string,
  key: string,
  data: unknown,
  resultId?: string,
) {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    id = resultId || randomUUID();
  if (
    (
      await tx.query(
        "INSERT INTO crm_commands(id,organization_id,request_key,payload_hash,result_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,request_key) DO NOTHING RETURNING id",
        [randomUUID(), org, key, hash, id],
      )
    ).length
  )
    return { id, reused: false };
  const [old] = await tx.query<{ result_id: string; payload_hash: string }>(
    "SELECT result_id,payload_hash FROM crm_commands WHERE organization_id=$1 AND request_key=$2",
    [org, key],
  );
  if (old.payload_hash !== hash)
    throw new AppError("IDEMPOTENCY_CONFLICT", 409);
  return { id: old.result_id, reused: true };
}
async function responsible(
  tx: Sql,
  org: string,
  branch: string,
  id: string | null,
) {
  if (
    id &&
    !(
      await tx.query(
        "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND (branch_id IS NULL OR branch_id=$3)",
        [org, id, branch],
      )
    ).length
  )
    throw new AppError("RESPONSIBLE_SCOPE", 422);
}
async function event(
  tx: Sql,
  org: string,
  customer: string,
  actor: string,
  kind: string,
  note: string,
  data: unknown = {},
  inquiry: string | null = null,
  quote: string | null = null,
) {
  await tx.query(
    "INSERT INTO crm_events(id,organization_id,customer_id,inquiry_id,quote_id,actor_id,kind,note,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      randomUUID(),
      org,
      customer,
      inquiry,
      quote,
      actor,
      kind,
      note,
      JSON.stringify(data),
    ],
  );
}
export class CrmService {
  constructor(private db: Database) {}
  private async customer(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
  ) {
    idSchema.parse(id);
    const [c] = await tx.query<{
      id: string;
      branch_id: string;
      version: number;
    }>(
      "SELECT id,branch_id,version FROM customers WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) FOR UPDATE",
      [org, id, branch],
    );
    if (!c) throw new AppError("NOT_FOUND", 404);
    return c;
  }
  private async pipelineData(tx: Sql, org: string) {
    const [p] = await tx.query<{
      version: number;
      data: z.infer<typeof pipelineInput>["stages"];
    }>("SELECT version,data FROM crm_pipelines WHERE organization_id=$1", [
      org,
    ]);
    return { version: p?.version || 0, stages: p?.data || defaultStages };
  }
  async pipeline(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "customers:read");
      return this.pipelineData(tx, org);
    });
  }
  async savePipeline(secret: Credential, org: string, input: unknown) {
    const c = pipelineInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "team:write");
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        org,
      ]);
      const old = await this.pipelineData(tx, org);
      if (old.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      const used = await tx.query<{ stage_id: string }>(
        "SELECT DISTINCT stage_id FROM inquiries WHERE organization_id=$1",
        [org],
      );
      if (
        used.some(
          (u) =>
            !c.stages.some(
              (stage) =>
                stage.id === u.stage_id &&
                stage.terminal ===
                  old.stages.find((o) => o.id === u.stage_id)?.terminal,
            ),
        )
      )
        throw new AppError("STAGE_IN_USE", 409);
      await tx.query(
        "INSERT INTO crm_pipelines(organization_id,version,data) VALUES($1,1,$2) ON CONFLICT(organization_id) DO UPDATE SET version=crm_pipelines.version+1,data=$2",
        [org, JSON.stringify(c.stages)],
      );
      await audit(tx, org, s.actorId, "crm.pipeline_updated", s.branchId);
      return { ok: true };
    });
  }
  async customers(secret: Credential, org: string, input: unknown) {
    const q = crmQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "customers:read",
          q.branchId,
        ),
        where =
          "c.organization_id=$1 AND ($2::uuid IS NULL OR c.branch_id=$2) AND position(lower($3) in lower(c.name||' '||c.email||' '||c.phone))>0";
      const [n] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM customers c WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT ${customerColumns} FROM customers c WHERE ${where} ORDER BY c.name,c.id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, n.total),
      };
    });
  }
  async createCustomer(secret: Credential, org: string, input: unknown) {
    const c = customerInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "customers:write",
          c.branchId,
        ),
        r = await command(tx, org, c.key, { operation: "customer", ...c });
      if (r.reused) return r;
      await responsible(tx, org, c.branchId, c.responsibleId);
      await tx.query(
        "INSERT INTO customers(id,organization_id,branch_id,external_id,name,email,phone,kind,responsible_id,consents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          r.id,
          org,
          c.branchId,
          `manual:${r.id}`,
          c.name,
          c.email.toLowerCase(),
          c.phone,
          c.kind,
          c.responsibleId,
          JSON.stringify(c.consents),
        ],
      );
      await event(tx, org, r.id, s.actorId, "customer.created", c.consentNote, {
        kind: c.kind,
        responsibleId: c.responsibleId,
        consents: c.consents,
      });
      await audit(tx, org, s.actorId, "customer.created", c.branchId, {
        customerId: r.id,
      });
      return r;
    });
  }
  async profile(secret: Credential, org: string, id: string, input: unknown) {
    const c = customerProfile.extend({ key: z.uuid() }).parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:write"),
        customer = await this.customer(tx, org, id, s.branchId),
        r = await command(
          tx,
          org,
          c.key,
          { operation: "customer.profile", id, ...c },
          id,
        );
      if (r.reused) return r;
      if (customer.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await responsible(tx, org, customer.branch_id, c.responsibleId);
      await tx.query(
        "UPDATE customers SET name=$3,email=$4,phone=$5,kind=$6,responsible_id=$7,consents=$8,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          c.name,
          c.email.toLowerCase(),
          c.phone,
          c.kind,
          c.responsibleId,
          JSON.stringify(c.consents),
        ],
      );
      await event(tx, org, id, s.actorId, "customer.updated", c.consentNote, {
        kind: c.kind,
        responsibleId: c.responsibleId,
        consents: c.consents,
      });
      await audit(tx, org, s.actorId, "customer.updated", customer.branch_id, {
        customerId: id,
      });
      return r;
    });
  }
  async history(secret: Credential, org: string, id: string, input: unknown) {
    const q = crmQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:read");
      await this.customer(tx, org, id, s.branchId);
      const [n] = await tx.query<{ total: number }>(
        "SELECT count(*)::int total FROM crm_events WHERE organization_id=$1 AND customer_id=$2",
        [org, id],
      );
      return {
        items: await tx.query(
          "SELECT e.id,e.kind,e.note,e.data,e.created_at,u.name actor_name FROM crm_events e JOIN users u ON u.id=e.actor_id WHERE e.organization_id=$1 AND e.customer_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT $3 OFFSET $4",
          [org, id, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, n.total),
      };
    });
  }
  async inquiries(secret: Credential, org: string, input: unknown) {
    const q = crmQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "customers:read",
          q.branchId,
        ),
        join =
          "inquiries i JOIN customers c ON c.organization_id=i.organization_id AND c.id=i.customer_id",
        where =
          "i.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id=$2) AND position(lower($3) in lower(i.title||' '||c.name))>0";
      const [n] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT ${inquiryColumns} FROM ${join} WHERE ${where} ORDER BY i.created_at DESC,i.id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, n.total),
      };
    });
  }
  async createInquiry(secret: Credential, org: string, input: unknown) {
    const c = inquiryInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "customers:write",
        c.branchId,
      );
      await this.customer(tx, org, c.customerId, c.branchId);
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [
        org,
      ]);
      const r = await command(tx, org, c.key, { operation: "inquiry", ...c });
      if (r.reused) return r;
      await responsible(tx, org, c.branchId, c.responsibleId);
      const pipeline = await this.pipelineData(tx, org);
      const rows = await tx.query(
        "INSERT INTO inquiries(id,organization_id,branch_id,customer_id,source,external_id,title,message,responsible_id,stage_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id",
        [
          r.id,
          org,
          c.branchId,
          c.customerId,
          c.source,
          c.externalId,
          c.title,
          c.message,
          c.responsibleId,
          pipeline.stages[0].id,
        ],
      );
      if (!rows.length) throw new AppError("DUPLICATE_INQUIRY", 409);
      await event(
        tx,
        org,
        c.customerId,
        s.actorId,
        "inquiry.created",
        c.title,
        { source: c.source },
        r.id,
      );
      await audit(tx, org, s.actorId, "inquiry.created", c.branchId, {
        inquiryId: r.id,
      });
      return r;
    });
  }
  private async inquiry(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
  ) {
    idSchema.parse(id);
    const [i] = await tx.query<{
      id: string;
      customer_id: string;
      branch_id: string;
      stage_id: string;
      version: number;
    }>(
      "SELECT id,customer_id,branch_id,stage_id,version FROM inquiries WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) FOR UPDATE",
      [org, id, branch],
    );
    if (!i) throw new AppError("NOT_FOUND", 404);
    return i;
  }
  async transition(secret: Credential, org: string, id: string, input: unknown) {
    const c = inquiryCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:write"),
        i = await this.inquiry(tx, org, id, s.branchId);
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [
        org,
      ]);
      const r = await command(
        tx,
        org,
        c.key,
        { operation: "inquiry.transition", id, ...c },
        id,
      );
      if (r.reused) return r;
      if (i.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      const p = await this.pipelineData(tx, org);
      if (!p.stages.some((s) => s.id === c.stageId))
        throw new AppError("STAGE_INVALID", 422);
      await tx.query(
        "UPDATE inquiries SET stage_id=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, c.stageId],
      );
      await event(
        tx,
        org,
        i.customer_id,
        s.actorId,
        "inquiry.stage",
        c.note,
        { from: i.stage_id, to: c.stageId },
        id,
      );
      await audit(tx, org, s.actorId, "inquiry.stage_changed", i.branch_id, {
        inquiryId: id,
      });
      return r;
    });
  }
  private async quoteData(
    tx: Sql,
    org: string,
    c: z.infer<typeof quoteInput> | z.infer<typeof quoteUpdate>,
  ) {
    if (new Set(c.lines.map((l) => l.itemId)).size !== c.lines.length)
      throw new AppError("DUPLICATE_LINE", 422);
    let total = 0n;
    const lines = [];
    for (const l of [...c.lines].sort((a, b) =>
      a.itemId.localeCompare(b.itemId),
    )) {
      const [item] = await tx.query<Item>(
        "SELECT id,sku,name_ru,name_kk,base_unit,conversions,active FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR SHARE",
        [org, l.itemId],
      );
      if (!item || !item.active) throw new AppError("ITEM_ARCHIVED", 409);
      toBase(l.quantity, l.unit, item);
      const amount = discountedTotal(l.price, l.quantity, l.discount);
      total += amount;
      lines.push({
        ...l,
        sku: item.sku,
        name_ru: item.name_ru,
        name_kk: item.name_kk,
        total_minor: amount.toString(),
      });
    }
    if (total >= 10n ** 38n) throw new AppError("AMOUNT_LIMIT", 422);
    return {
      validUntil: c.validUntil,
      terms: c.terms,
      lines,
      total_minor: total.toString(),
    };
  }
  async quotes(secret: Credential, org: string, input: unknown) {
    const q = crmQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "customers:read",
          q.branchId,
        ),
        join =
          "quotes q JOIN inquiries i ON i.organization_id=q.organization_id AND i.id=q.inquiry_id JOIN customers c ON c.organization_id=i.organization_id AND c.id=i.customer_id",
        where =
          "q.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id=$2) AND position(lower($3) in lower(c.name||' '||q.number::text))>0";
      const [n] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query<Quote>(
          `SELECT ${quoteColumns} FROM ${join} WHERE ${where} ORDER BY q.created_at DESC,q.id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, n.total),
      };
    });
  }
  async quote(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:read");
      return this.getQuote(tx, org, id, s.branchId);
    });
  }
  private async getQuote(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
  ) {
    idSchema.parse(id);
    const [q] = await tx.query<Quote>(
      `SELECT ${quoteColumns} FROM quotes q JOIN inquiries i ON i.organization_id=q.organization_id AND i.id=q.inquiry_id JOIN customers c ON c.organization_id=i.organization_id AND c.id=i.customer_id WHERE q.organization_id=$1 AND q.id=$2 AND ($3::uuid IS NULL OR i.branch_id=$3) FOR UPDATE OF q`,
      [org, id, branch],
    );
    if (!q) throw new AppError("NOT_FOUND", 404);
    return q;
  }
  async saveQuote(secret: Credential, org: string, input: unknown, id?: string) {
    const c = id ? quoteUpdate.parse(input) : quoteInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:write"),
        old = id ? await this.getQuote(tx, org, id, s.branchId) : null,
        i = await this.inquiry(
          tx,
          org,
          old?.inquiry_id || (c as z.infer<typeof quoteInput>).inquiryId,
          s.branchId,
        ),
        r = await command(
          tx,
          org,
          c.key,
          { operation: "quote.save", id, ...c },
          id,
        );
      if (r.reused) return r;
      if (old?.order_id) throw new AppError("QUOTE_CONVERTED", 409);
      if (old && old.version !== (c as z.infer<typeof quoteUpdate>).version)
        throw new AppError("VERSION_CONFLICT", 409);
      const data = await this.quoteData(tx, org, c);
      if (old)
        await tx.query(
          "UPDATE quotes SET data=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
          [org, id, JSON.stringify(data)],
        );
      else
        await tx.query(
          "INSERT INTO quotes(id,organization_id,inquiry_id,data) VALUES($1,$2,$3,$4)",
          [r.id, org, i.id, JSON.stringify(data)],
        );
      for (const l of data.lines)
        await tx.query(
          "INSERT INTO quote_items(organization_id,quote_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [org, r.id, l.itemId],
        );
      await event(
        tx,
        org,
        i.customer_id,
        s.actorId,
        "quote.saved",
        c.note,
        { version: (old?.version || 0) + 1, ...data },
        i.id,
        r.id,
      );
      await audit(tx, org, s.actorId, "quote.saved", i.branch_id, {
        quoteId: r.id,
      });
      return r;
    });
  }
  async convert(secret: Credential, org: string, id: string, input: unknown) {
    const c = quoteConvert.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write"),
        q = await this.getQuote(tx, org, id, s.branchId),
        r = await command(tx, org, c.key, {
          operation: "quote.convert",
          id,
          ...c,
        });
      if (r.reused) return r;
      if (q.order_id) throw new AppError("QUOTE_CONVERTED", 409);
      if (q.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      const [clock] = await tx.query<{ today: string }>(
        "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
        [org],
      );
      if (q.data.validUntil < clock.today)
        throw new AppError("QUOTE_EXPIRED", 409);
      const result = await new CommerceService(this.db).createInTransaction(
        tx,
        secret,
        org,
        {
          key: c.key,
          branchId: q.branch_id,
          customerId: q.customer_id,
          warehouseId: c.warehouseId,
          dueDate: c.dueDate,
          delivery: c.delivery,
          note: c.note,
          taxMode: "excluded",
          lines: q.data.lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit,
            price: l.price,
            discount: l.discount,
          })),
        },
      );
      await tx.query(
        "UPDATE sales_orders SET quote_id=$3,inquiry_id=$4 WHERE organization_id=$1 AND id=$2",
        [org, result.id, id, q.inquiry_id],
      );
      await tx.query(
        "UPDATE quotes SET order_id=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, result.id],
      );
      await tx.query(
        "UPDATE crm_commands SET result_id=$3 WHERE organization_id=$1 AND request_key=$2",
        [org, c.key, result.id],
      );
      await event(
        tx,
        org,
        q.customer_id,
        s.actorId,
        "quote.converted",
        c.note,
        { orderId: result.id },
        q.inquiry_id,
        id,
      );
      await audit(tx, org, s.actorId, "quote.converted", q.branch_id, {
        quoteId: id,
        orderId: result.id,
      });
      return { id: result.id, reused: false };
    });
  }
}
