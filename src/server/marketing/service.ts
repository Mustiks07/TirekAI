import { createHash } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { can } from "../../domain/permissions";
import { D } from "../../domain/purchasing";
import { discountedTotal } from "../../domain/commerce";
import { marginPercent } from "../../domain/decimal";
import {
  MAX_RECIPIENTS,
  MIN_ANCHOR_ORDERS,
  MIN_PAIR_ORDERS,
  campaignCreate,
  campaignData,
  campaignDecision,
  campaignUpdate,
  exportInput,
  imageUpload,
  publishInput,
  recommendQuery,
  segmentPreview,
  spendInput,
  templateText,
  type CampaignData,
  type Evaluation,
  type LineEvaluation,
} from "../../domain/marketing";
import { idempotent } from "../execution/core";
import { TelegramService } from "../integrations/telegram-service";
import type { ConnectionRow } from "../integrations/common";
import { materialPdf } from "./pdf";

type Campaign = {
  id: string;
  branch_id: string;
  state: "draft" | "pending" | "approved" | "rejected" | "archived";
  version: number;
  approved_version: number | null;
  data: CampaignData;
  spend_minor: string | null;
  spend_note: string;
  spend_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};
const columns =
  "id,branch_id,state,version,approved_version,data,spend_minor::text,spend_note,spend_version,created_by,created_at::text,updated_at::text";
const blocking = new Set([
  "ITEM_NOT_FOUND",
  "ITEM_INACTIVE",
  "PRICE_MISSING",
  "BUNDLE_NOT_CHEAPER",
  "WAREHOUSE_NOT_FOUND",
  "IMAGE_NOT_FOUND",
]);
// Unit cost rounded to whole tiyn: the average of the stock balance in scope, otherwise the
// catalog purchase price, otherwise unknown (never zero).
function unitCost(
  stock: { quantity: string; value_minor: string } | undefined,
  purchase: string | null,
) {
  if (stock && new D(stock.quantity).gt(0))
    return {
      cost: BigInt(
        new D(stock.value_minor)
          .div(stock.quantity)
          .toDecimalPlaces(0)
          .toFixed(0),
      ),
      source: "stock_average" as const,
    };
  if (purchase !== null)
    return {
      cost: BigInt(new D(purchase).times(100).toDecimalPlaces(0).toFixed(0)),
      source: "purchase_price" as const,
    };
  return { cost: null, source: "unknown" as const };
}
const priceMinor = (price: string | null) =>
  price === null
    ? null
    : BigInt(new D(price).times(100).toDecimalPlaces(0).toFixed(0));
// Cost and margins are visible only with inventory:cost; the status stays visible.
function redact(e: Evaluation, costVisible: boolean): Evaluation {
  if (costVisible) return { ...e, costVisible };
  return {
    ...e,
    costVisible,
    lowestMargin: null,
    lines: e.lines.map((l) => ({
      ...l,
      costMinor: null,
      margin: null,
      regularMargin: null,
    })),
    bundle: e.bundle && { ...e.bundle, costMinor: null, margin: null },
  };
}
// The facts printed on materials: a change of any of them after approval needs a new approval.
const printed = (e: Evaluation) =>
  JSON.stringify({
    lines: e.lines.map((l) => [l.itemId, l.priceMinor, l.promoMinor]),
    bundle: e.bundle?.priceMinor ?? null,
  });

// T039: promotion campaigns, margin control, materials, approval and publication log.
export class MarketingService {
  constructor(
    private db: Database,
    private telegram = new TelegramService(db),
  ) {}
  private async load(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
    lock = false,
  ) {
    idSchema.parse(id);
    const [c] = await tx.query<Campaign>(
      `SELECT ${columns} FROM marketing_campaigns WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) ${lock ? "FOR UPDATE" : ""}`,
      [org, id, branch],
    );
    if (!c) throw new AppError("NOT_FOUND", 404);
    return c;
  }
  private async today(tx: Sql, org: string) {
    const [r] = await tx.query<{ today: string }>(
      "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
      [org],
    );
    return r.today;
  }
  // Margin, availability and price facts of an offer, recomputed from current data.
  async evaluateInTransaction(
    tx: Sql,
    org: string,
    data: CampaignData,
    campaignId: string | null,
  ): Promise<Evaluation> {
    const ids = data.offer.lines.map((l) => l.itemId);
    const issues: Evaluation["issues"] = [];
    if (data.warehouseId) {
      const [w] = await tx.query(
        "SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
        [org, data.warehouseId, data.branchId],
      );
      if (!w) issues.push({ code: "WAREHOUSE_NOT_FOUND" });
    }
    if (data.materials.imageId) {
      const [img] = campaignId
        ? await tx.query(
            "SELECT id FROM marketing_images WHERE organization_id=$1 AND id=$2 AND campaign_id=$3",
            [org, data.materials.imageId, campaignId],
          )
        : [];
      if (!img) issues.push({ code: "IMAGE_NOT_FOUND" });
    }
    const items = await tx.query<{
      id: string;
      sku: string;
      name_ru: string;
      name_kk: string;
      kind: "goods" | "service";
      base_unit: string;
      active: boolean;
      purchase_price: string | null;
      sale_price: string | null;
    }>(
      "SELECT id,sku,name_ru,name_kk,kind,base_unit,active,purchase_price::text,sale_price::text FROM catalog_items WHERE organization_id=$1 AND id=ANY($2::uuid[])",
      [org, ids],
    );
    const stock = await tx.query<{
      item_id: string;
      quantity: string;
      reserved: string;
      value_minor: string;
    }>(
      "SELECT b.item_id,sum(b.quantity)::text quantity,sum(b.reserved)::text reserved,sum(b.value_minor)::text value_minor FROM stock_balances b JOIN warehouses w ON w.organization_id=b.organization_id AND w.id=b.warehouse_id WHERE b.organization_id=$1 AND b.item_id=ANY($2::uuid[]) AND w.branch_id=$3 AND ($4::uuid IS NULL OR w.id=$4) GROUP BY b.item_id",
      [org, ids, data.branchId, data.warehouseId],
    );
    const lines: LineEvaluation[] = [];
    const costs = new Map<string, bigint | null>();
    for (const o of data.offer.lines) {
      const item = items.find((i) => i.id === o.itemId);
      const quantity = "quantity" in o ? o.quantity : "1";
      const discount = "discount" in o ? o.discount : null;
      if (!item) {
        issues.push({ code: "ITEM_NOT_FOUND", itemId: o.itemId });
        lines.push({
          itemId: o.itemId,
          sku: null,
          nameRu: null,
          nameKk: null,
          kind: null,
          unit: null,
          quantity,
          discount,
          priceMinor: null,
          promoMinor: null,
          costMinor: null,
          costSource: "unknown",
          margin: null,
          regularMargin: null,
          available: null,
        });
        costs.set(o.itemId, null);
        continue;
      }
      if (!item.active) issues.push({ code: "ITEM_INACTIVE", itemId: item.id });
      const s = stock.find((x) => x.item_id === item.id);
      const { cost, source } = unitCost(s, item.purchase_price);
      costs.set(item.id, cost);
      const price = priceMinor(item.sale_price);
      if (price === null)
        issues.push({ code: "PRICE_MISSING", itemId: item.id });
      const available =
        item.kind === "service"
          ? null
          : s
            ? new D(s.quantity).minus(s.reserved).toFixed()
            : "0";
      if (available !== null && new D(available).lt(quantity))
        issues.push({ code: "OUT_OF_STOCK", itemId: item.id });
      const promo =
        price !== null && discount !== null
          ? discountedTotal(item.sale_price!, "1", discount)
          : null;
      lines.push({
        itemId: item.id,
        sku: item.sku,
        nameRu: item.name_ru,
        nameKk: item.name_kk,
        kind: item.kind,
        unit: item.base_unit,
        quantity,
        discount,
        priceMinor: price?.toString() ?? null,
        promoMinor: promo?.toString() ?? null,
        costMinor: cost?.toString() ?? null,
        costSource: source,
        margin:
          promo !== null && cost !== null ? marginPercent(promo, cost) : null,
        regularMargin:
          price !== null && cost !== null ? marginPercent(price, cost) : null,
        available,
      });
    }
    let bundle: Evaluation["bundle"] = null;
    const margins: (string | null)[] = [];
    if (data.offer.kind === "bundle") {
      const bundlePrice = BigInt(new D(data.offer.price).times(100).toFixed(0));
      const known = (v: (string | null)[]) => v.every((x) => x !== null);
      const regular = known(lines.map((l) => l.priceMinor))
        ? lines.reduce(
            (a, l) =>
              a +
              BigInt(
                new D(l.priceMinor!)
                  .times(l.quantity)
                  .toDecimalPlaces(0)
                  .toFixed(0),
              ),
            0n,
          )
        : null;
      const cost = known(lines.map((l) => l.costMinor))
        ? lines.reduce(
            (a, l) =>
              a +
              BigInt(
                new D(l.costMinor!)
                  .times(l.quantity)
                  .toDecimalPlaces(0)
                  .toFixed(0),
              ),
            0n,
          )
        : null;
      if (regular !== null && bundlePrice >= regular)
        issues.push({ code: "BUNDLE_NOT_CHEAPER" });
      const sets = lines.every((l) => l.kind === "service")
        ? null
        : lines
            .filter((l) => l.available !== null)
            .map((l) => new D(l.available!).div(l.quantity).floor())
            .reduce((a, b) => (b.lt(a) ? b : a))
            .toFixed();
      bundle = {
        priceMinor: bundlePrice.toString(),
        regularMinor: regular?.toString() ?? null,
        costMinor: cost?.toString() ?? null,
        margin: cost !== null ? marginPercent(bundlePrice, cost) : null,
        sets,
      };
      margins.push(bundle.margin);
    } else margins.push(...lines.map((l) => l.margin));
    const unknown = margins.some((m) => m === null);
    const lowest = unknown
      ? null
      : margins.reduce((a, b) => (new D(b!).lt(a!) ? b : a))!;
    const status = issues.some((i) => blocking.has(i.code))
      ? "invalid"
      : unknown
        ? "unknown_margin"
        : new D(lowest!).lt(data.minMargin)
          ? "below_threshold"
          : "ok";
    if (status === "below_threshold") issues.push({ code: "MARGIN_BELOW" });
    if (status === "unknown_margin") issues.push({ code: "MARGIN_UNKNOWN" });
    return {
      offer: data.offer.kind,
      lines,
      bundle,
      minMargin: data.minMargin,
      lowestMargin: lowest,
      status,
      issues,
      costVisible: true,
    };
  }
  async evaluate(secret: Credential, org: string, input: unknown) {
    const data = campaignData.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "marketing:read",
        data.branchId,
      );
      const e = await this.evaluateInTransaction(tx, org, data, null);
      return redact(e, can(s.role, "inventory:cost"));
    });
  }
  async create(secret: Credential, org: string, input: unknown) {
    const c = campaignCreate.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "marketing:write",
        c.data.branchId,
      );
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.create",
        data: c.data,
      });
      if (r.reused) return { id: r.id, reused: true };
      if (c.data.materials.imageId) throw new AppError("IMAGE_NOT_FOUND", 422);
      const e = await this.evaluateInTransaction(tx, org, c.data, null);
      await tx.query(
        "INSERT INTO marketing_campaigns(id,organization_id,branch_id,state,data,created_by) VALUES($1,$2,$3,'draft',$4,$5)",
        [r.id, org, c.data.branchId, JSON.stringify(c.data), s.actorId],
      );
      await tx.query(
        "INSERT INTO marketing_campaign_versions(organization_id,campaign_id,version,data,evaluation,note,author_id) VALUES($1,$2,1,$3,$4,$5,$6)",
        [
          org,
          r.id,
          JSON.stringify(c.data),
          JSON.stringify(e),
          "Создана",
          s.actorId,
        ],
      );
      await audit(
        tx,
        org,
        s.actorId,
        "marketing.campaign_created",
        c.data.branchId,
        { campaignId: r.id },
      );
      return { id: r.id, reused: false };
    });
  }
  // Every content change is a new version; an approval of an older version no longer applies.
  async update(secret: Credential, org: string, id: string, input: unknown) {
    const c = campaignUpdate.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:write");
      const old = await this.load(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.update",
        id,
        ...c,
      });
      if (r.reused) return { id, reused: true };
      if (old.state === "archived")
        throw new AppError("CAMPAIGN_ARCHIVED", 409);
      if (old.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      if (c.data.branchId !== old.branch_id)
        throw new AppError("BRANCH_CHANGE", 422);
      const e = await this.evaluateInTransaction(tx, org, c.data, id);
      const version = old.version + 1;
      await tx.query(
        "UPDATE marketing_campaigns SET data=$3,version=$4,state='draft',approved_version=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, JSON.stringify(c.data), version],
      );
      await tx.query(
        "INSERT INTO marketing_campaign_versions(organization_id,campaign_id,version,data,evaluation,note,author_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          org,
          id,
          version,
          JSON.stringify(c.data),
          JSON.stringify(e),
          c.note,
          s.actorId,
        ],
      );
      await audit(
        tx,
        org,
        s.actorId,
        "marketing.campaign_updated",
        old.branch_id,
        { campaignId: id, version: String(version) },
      );
      return { id, reused: false };
    });
  }
  async decide(secret: Credential, org: string, id: string, input: unknown) {
    const c = campaignDecision.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        c.kind === "submit" ? "marketing:write" : "marketing:approve",
      );
      const old = await this.load(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.decide",
        id,
        ...c,
      });
      if (r.reused) return { id, reused: true };
      // The decision is bound to the version the person saw.
      if (old.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      const [v] = await tx.query<{ author_id: string }>(
        "SELECT author_id FROM marketing_campaign_versions WHERE organization_id=$1 AND campaign_id=$2 AND version=$3",
        [org, id, c.version],
      );
      let state: Campaign["state"],
        evaluation: Evaluation | null = null,
        override = false;
      switch (c.kind) {
        case "submit": {
          if (!["draft", "rejected"].includes(old.state))
            throw new AppError("CAMPAIGN_STATE", 409);
          evaluation = await this.evaluateInTransaction(tx, org, old.data, id);
          if (evaluation.status === "invalid")
            throw new AppError("CAMPAIGN_INVALID", 409);
          state = "pending";
          break;
        }
        case "approve": {
          if (old.state !== "pending")
            throw new AppError("CAMPAIGN_STATE", 409);
          if (v.author_id === s.actorId)
            throw new AppError("SELF_APPROVAL", 403);
          // Costs and prices are re-read now: an approval never relies on a stale margin.
          evaluation = await this.evaluateInTransaction(tx, org, old.data, id);
          if (evaluation.status === "invalid")
            throw new AppError("CAMPAIGN_INVALID", 409);
          if (evaluation.status !== "ok") {
            if (!c.override)
              throw new AppError(
                evaluation.status === "below_threshold"
                  ? "MARGIN_BELOW_THRESHOLD"
                  : "MARGIN_UNKNOWN",
                409,
              );
            // A separate permission: only the owner, with a reason, may go below the threshold.
            if (s.role !== "owner")
              throw new AppError("OVERRIDE_FORBIDDEN", 403);
            if (c.note.length < 10) throw new AppError("OVERRIDE_REASON", 422);
            override = true;
          } else if (c.override) throw new AppError("OVERRIDE_NOT_NEEDED", 422);
          state = "approved";
          break;
        }
        case "reject":
          if (old.state !== "pending")
            throw new AppError("CAMPAIGN_STATE", 409);
          state = "rejected";
          break;
        default:
          if (old.state === "archived")
            throw new AppError("CAMPAIGN_STATE", 409);
          state = "archived";
      }
      await tx.query(
        "UPDATE marketing_campaigns SET state=$3,approved_version=$4,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, state, state === "approved" ? c.version : null],
      );
      await tx.query(
        "INSERT INTO marketing_decisions(id,organization_id,campaign_id,version,decision,override,evaluation,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          r.id,
          org,
          id,
          c.version,
          c.kind === "submit"
            ? "submitted"
            : c.kind === "approve"
              ? "approved"
              : c.kind === "reject"
                ? "rejected"
                : "archived",
          override,
          evaluation && JSON.stringify(evaluation),
          c.note,
          s.actorId,
        ],
      );
      await audit(
        tx,
        org,
        s.actorId,
        `marketing.campaign_${state}`,
        old.branch_id,
        {
          campaignId: id,
          version: String(c.version),
          override: String(override),
        },
      );
      return { id, reused: false };
    });
  }
  async list(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:read");
      const items = await tx.query(
        "SELECT id,branch_id,state,version,approved_version,data->>'name' name,data->>'startsOn' starts_on,data->>'endsOn' ends_on,data->'offer'->>'kind' offer,updated_at::text FROM marketing_campaigns WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY updated_at DESC,id LIMIT 200",
        [org, s.branchId],
      );
      return { items };
    });
  }
  async get(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:read");
      const c = await this.load(tx, org, id, s.branchId);
      const costVisible = can(s.role, "inventory:cost");
      const evaluation = redact(
        await this.evaluateInTransaction(tx, org, c.data, id),
        costVisible,
      );
      const versions = await tx.query<{
        version: number;
        note: string;
        author: string;
        created_at: string;
      }>(
        "SELECT v.version,v.note,u.name author,v.created_at::text FROM marketing_campaign_versions v JOIN users u ON u.id=v.author_id WHERE v.organization_id=$1 AND v.campaign_id=$2 ORDER BY v.version DESC",
        [org, id],
      );
      const decisions = await tx.query<{
        decision: string;
        version: number;
        override: boolean;
        note: string;
        actor: string;
        created_at: string;
      }>(
        "SELECT d.decision,d.version,d.override,d.note,u.name actor,d.created_at::text FROM marketing_decisions d JOIN users u ON u.id=d.actor_id WHERE d.organization_id=$1 AND d.campaign_id=$2 ORDER BY d.created_at,d.id",
        [org, id],
      );
      const images = await tx.query(
        "SELECT id,mime,size,source,alt_ru,alt_kk,created_at::text FROM marketing_images WHERE organization_id=$1 AND campaign_id=$2 ORDER BY created_at",
        [org, id],
      );
      // Delivery counts come from the channel's own message states, not from the publication.
      const publications = await tx.query(
        "SELECT p.id,p.version,p.channel,p.material,p.locale,p.state,p.reason,p.recipients,p.skipped,p.sha256,p.created_at::text,u.name actor,(SELECT count(*) FROM messaging_messages m WHERE m.organization_id=p.organization_id AND m.publication_id=p.id AND m.state='sent')::int sent,(SELECT count(*) FROM messaging_messages m WHERE m.organization_id=p.organization_id AND m.publication_id=p.id AND m.state IN ('failed','blocked','unknown'))::int undelivered FROM marketing_publications p JOIN users u ON u.id=p.actor_id WHERE p.organization_id=$1 AND p.campaign_id=$2 ORDER BY p.created_at DESC,p.id",
        [org, id],
      );
      return {
        campaign: {
          ...c,
          spend_minor: c.spend_minor,
        },
        evaluation,
        versions,
        decisions,
        images,
        publications,
        can: {
          write: can(s.role, "marketing:write"),
          approve: can(s.role, "marketing:approve"),
          override: s.role === "owner",
          cost: costVisible,
        },
      };
    });
  }
  // Suggested RU/KK text from the evaluated facts; nothing is saved.
  async template(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:write");
      const c = await this.load(tx, org, id, s.branchId);
      const e = await this.evaluateInTransaction(tx, org, c.data, id);
      return templateText(e, c.data);
    });
  }
  async uploadImage(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = imageUpload.parse(input);
    const bytes = Buffer.from(c.content, "base64");
    if (!bytes.length || bytes.length > 2 * 1024 * 1024)
      throw new AppError("TOO_LARGE", 413);
    // The declared type must match the file signature (PNG or JPEG only: printable by PDFKit).
    const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((c.mime === "image/png" && !png) || (c.mime === "image/jpeg" && !jpeg))
      throw new AppError("IMAGE_TYPE", 422);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:write");
      const camp = await this.load(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.image",
        id,
        sha256,
        mime: c.mime,
        altRu: c.altRu,
        altKk: c.altKk,
      });
      if (r.reused) return { id: r.id, reused: true };
      if (camp.state === "archived")
        throw new AppError("CAMPAIGN_ARCHIVED", 409);
      await tx.query(
        "INSERT INTO marketing_images(id,organization_id,campaign_id,source,mime,size,sha256,bytes,alt_ru,alt_kk,created_by) VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,$10)",
        [
          r.id,
          org,
          id,
          c.mime,
          bytes.length,
          sha256,
          bytes,
          c.altRu,
          c.altKk,
          s.actorId,
        ],
      );
      await audit(
        tx,
        org,
        s.actorId,
        "marketing.image_uploaded",
        camp.branch_id,
        { campaignId: id, imageId: r.id },
      );
      return { id: r.id, reused: false };
    });
  }
  // REQ MKT 03 names a pluggable generator; none is connected in this environment.
  async generateImage(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:write");
      await this.load(tx, org, id, s.branchId);
      throw new AppError("IMAGE_GENERATOR_NOT_CONFIGURED", 409);
    });
  }
  async image(secret: Credential, org: string, id: string, imageId: string) {
    idSchema.parse(imageId);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:read");
      await this.load(tx, org, id, s.branchId);
      const [img] = await tx.query<{ mime: string; bytes: Uint8Array }>(
        "SELECT mime,bytes FROM marketing_images WHERE organization_id=$1 AND campaign_id=$2 AND id=$3",
        [org, id, imageId],
      );
      if (!img) throw new AppError("NOT_FOUND", 404);
      return {
        mime: img.mime,
        content: Buffer.from(img.bytes).toString("base64"),
      };
    });
  }
  // Checks shared by export and publication: the approved version, its dates and unchanged facts.
  private async approvedFacts(
    tx: Sql,
    org: string,
    c: Campaign,
    version: number,
  ) {
    if (c.state !== "approved" || c.approved_version !== version)
      throw new AppError("CAMPAIGN_NOT_APPROVED", 409);
    if ((await this.today(tx, org)) > c.data.endsOn)
      throw new AppError("CAMPAIGN_ENDED", 409);
    const [d] = await tx.query<{ evaluation: Evaluation }>(
      "SELECT evaluation FROM marketing_decisions WHERE organization_id=$1 AND campaign_id=$2 AND version=$3 AND decision='approved' ORDER BY created_at DESC LIMIT 1",
      [org, c.id, version],
    );
    const now = await this.evaluateInTransaction(tx, org, c.data, c.id);
    // A price changed after approval: the printed offer would no longer match the catalog.
    if (!d || printed(d.evaluation) !== printed(now))
      throw new AppError("OFFER_CHANGED", 409);
    return d.evaluation;
  }
  async exportMaterial(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = exportInput.parse(input);
    const out = await this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:write");
      const camp = await this.load(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.export",
        id,
        ...c,
      });
      const evaluation = r.reused
        ? (
            await tx.query<{ evaluation: Evaluation }>(
              "SELECT evaluation FROM marketing_decisions WHERE organization_id=$1 AND campaign_id=$2 AND version=$3 AND decision='approved' ORDER BY created_at DESC LIMIT 1",
              [org, id, c.version],
            )
          )[0]?.evaluation
        : await this.approvedFacts(tx, org, camp, c.version);
      if (!evaluation) throw new AppError("CAMPAIGN_NOT_APPROVED", 409);
      const [v] = await tx.query<{ data: CampaignData }>(
        "SELECT data FROM marketing_campaign_versions WHERE organization_id=$1 AND campaign_id=$2 AND version=$3",
        [org, id, c.version],
      );
      const imageId = v.data.materials.imageId;
      const [img] = imageId
        ? await tx.query<{ bytes: Uint8Array; alt_ru: string; alt_kk: string }>(
            "SELECT bytes,alt_ru,alt_kk FROM marketing_images WHERE organization_id=$1 AND id=$2 AND campaign_id=$3",
            [org, imageId, id],
          )
        : [];
      const pdf = await materialPdf({
        material: c.material,
        locale: c.locale,
        data: v.data,
        evaluation,
        version: c.version,
        image: img
          ? {
              bytes: Buffer.from(img.bytes),
              alt: c.locale === "ru" ? img.alt_ru : img.alt_kk,
            }
          : null,
      });
      const sha256 = createHash("sha256").update(pdf).digest("hex");
      if (!r.reused) {
        await tx.query(
          "INSERT INTO marketing_publications(id,organization_id,campaign_id,version,channel,material,locale,state,sha256,actor_id) VALUES($1,$2,$3,$4,'export',$5,$6,'exported',$7,$8)",
          [r.id, org, id, c.version, c.material, c.locale, sha256, s.actorId],
        );
        await audit(
          tx,
          org,
          s.actorId,
          "marketing.material_exported",
          camp.branch_id,
          { campaignId: id, publicationId: r.id, material: c.material },
        );
      }
      return { publicationId: r.id, pdf, reused: r.reused };
    });
    return {
      publicationId: out.publicationId,
      reused: out.reused,
      filename: `campaign-${id.slice(0, 8)}-v${c.version}-${c.material}-${c.locale}.pdf`,
      mime: "application/pdf",
      content: out.pdf.toString("base64"),
    };
  }
  private async recipients(
    tx: Sql,
    org: string,
    branchId: string,
    segment: CampaignData["segment"],
  ) {
    const kind = segment.kind;
    return tx.query<{
      id: string;
      email: string;
      phone: string;
      consents: Record<string, boolean>;
      excluded: boolean;
    }>(
      `SELECT c.id,c.email,c.phone,c.consents,(c.id=ANY($5::uuid[])) excluded FROM customers c WHERE c.organization_id=$1 AND c.branch_id=$2 AND (
        $3::text='all'
        OR ($3::text='bought_items' AND EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.organization_id=o.organization_id AND l.order_id=o.id WHERE o.organization_id=c.organization_id AND o.customer_id=c.id AND o.state NOT IN ('draft','cancelled') AND o.created_at>=now()-make_interval(days=>$4) AND l.item_id=ANY($6::uuid[])))
        OR ($3::text='inactive' AND EXISTS(SELECT 1 FROM sales_orders o WHERE o.organization_id=c.organization_id AND o.customer_id=c.id AND o.state NOT IN ('draft','cancelled')) AND NOT EXISTS(SELECT 1 FROM sales_orders o WHERE o.organization_id=c.organization_id AND o.customer_id=c.id AND o.state NOT IN ('draft','cancelled') AND o.created_at>=now()-make_interval(days=>$4)))
      ) ORDER BY c.id LIMIT 20000`,
      [org, branchId, kind, segment.days, segment.excluded, segment.itemIds],
    );
  }
  // REQ MKT 01: counts only; consent and opt-out decide who can be contacted through a channel.
  async previewSegment(secret: Credential, org: string, input: unknown) {
    const c = segmentPreview.parse(input);
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "marketing:read", c.branchId);
      const rows = await this.recipients(tx, org, c.branchId, c.segment);
      let linked = new Set<string>();
      if (c.segment.channel === "messenger")
        linked = new Set(
          (
            await tx.query<{ internal_id: string }>(
              "SELECT DISTINCT m.internal_id FROM integration_mappings m JOIN integration_connections k ON k.id=m.connection_id WHERE k.organization_id=$1 AND k.provider='telegram' AND k.disconnected_at IS NULL AND m.entity_type='chat' AND m.state='active'",
              [org],
            )
          ).map((r) => r.internal_id),
        );
      const counts = {
        matched: rows.length,
        excluded: 0,
        noConsent: 0,
        noContact: 0,
        reachable: 0,
      };
      for (const r of rows) {
        if (r.excluded) counts.excluded++;
        else if (c.segment.channel === "none") continue;
        else if (!r.consents?.[c.segment.channel]) counts.noConsent++;
        else if (
          (c.segment.channel === "email" && !r.email) ||
          (c.segment.channel === "sms" && !r.phone) ||
          (c.segment.channel === "messenger" && !linked.has(r.id))
        )
          counts.noContact++;
        else counts.reachable++;
      }
      return {
        ...counts,
        channel: c.segment.channel,
        // Only Telegram is connected as a sending channel; email/SMS are counted, not sent.
        sendable: c.segment.channel === "messenger",
      };
    });
  }
  // REQ MKT 04: a message to customers who agreed and linked a chat; the log shows "queued",
  // the delivery state is the channel's own message state.
  async publish(secret: Credential, org: string, id: string, input: unknown) {
    const c = publishInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:approve");
      const camp = await this.load(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.publish",
        id,
        ...c,
      });
      if (r.reused) {
        const [p] = await tx.query<{
          state: string;
          recipients: number;
          reason: string | null;
        }>(
          "SELECT state,recipients,reason FROM marketing_publications WHERE organization_id=$1 AND id=$2",
          [org, r.id],
        );
        return { id: r.id, reused: true, ...p };
      }
      await this.approvedFacts(tx, org, camp, c.version);
      const [v] = await tx.query<{ data: CampaignData }>(
        "SELECT data FROM marketing_campaign_versions WHERE organization_id=$1 AND campaign_id=$2 AND version=$3",
        [org, id, c.version],
      );
      if (v.data.segment.channel !== "messenger")
        throw new AppError("SEGMENT_CHANNEL", 422);
      const [conn] = await tx.query<ConnectionRow>(
        "SELECT * FROM integration_connections WHERE organization_id=$1 AND provider='telegram' AND disconnected_at IS NULL ORDER BY created_at LIMIT 1",
        [org],
      );
      const record = async (
        state: "queued" | "not_configured" | "blocked",
        reason: string | null,
        recipients: number,
        skipped: Record<string, number>,
        insert = true,
      ) => {
        await tx.query(
          insert
            ? "INSERT INTO marketing_publications(id,organization_id,campaign_id,version,channel,material,locale,state,reason,recipients,skipped,connection_id,actor_id) VALUES($1,$2,$3,$4,'telegram','message',$5,$6,$7,$8,$9,$10,$11)"
            : "UPDATE marketing_publications SET state=$6,reason=$7,recipients=$8,skipped=$9 WHERE organization_id=$2 AND id=$1 AND campaign_id=$3 AND version=$4 AND locale=$5 AND connection_id IS NOT DISTINCT FROM $10 AND actor_id=$11",
          [
            r.id,
            org,
            id,
            c.version,
            c.locale,
            state,
            reason,
            recipients,
            JSON.stringify(skipped),
            conn?.id ?? null,
            s.actorId,
          ],
        );
        await audit(
          tx,
          org,
          s.actorId,
          "marketing.publication_" + state,
          camp.branch_id,
          {
            campaignId: id,
            publicationId: r.id,
            recipients: String(recipients),
          },
        );
        return { id: r.id, reused: false, state, recipients, reason };
      };
      // Without an enabled channel the attempt is logged honestly and nothing is sent.
      if (!conn || !conn.settings.outbound)
        return record(
          "not_configured",
          conn ? "MESSAGING_DISABLED" : "CHANNEL_NOT_CONNECTED",
          0,
          {},
        );
      const rows = await this.recipients(
        tx,
        org,
        camp.branch_id,
        v.data.segment,
      );
      const candidates = rows.filter((x) => !x.excluded);
      if (candidates.length > MAX_RECIPIENTS)
        throw new AppError("SEGMENT_TOO_LARGE", 409);
      const [d] = await tx.query<{ evaluation: Evaluation }>(
        "SELECT evaluation FROM marketing_decisions WHERE organization_id=$1 AND campaign_id=$2 AND version=$3 AND decision='approved' ORDER BY created_at DESC LIMIT 1",
        [org, id, c.version],
      );
      const t = templateText(d.evaluation, v.data)[c.locale];
      const m = v.data.materials[c.locale];
      // Facts (prices) are appended from the approved evaluation after the author's text.
      const text = [m.title, m.body, t.body, m.terms]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 2000);
      // The publication row exists first, so queued messages can reference it.
      await tx.query(
        "INSERT INTO marketing_publications(id,organization_id,campaign_id,version,channel,material,locale,state,connection_id,actor_id) VALUES($1,$2,$3,$4,'telegram','message',$5,'blocked',$6,$7)",
        [r.id, org, id, c.version, c.locale, conn.id, s.actorId],
      );
      const skipped = { excluded: rows.length - candidates.length } as Record<
        string,
        number
      >;
      let queued = 0;
      for (const x of candidates) {
        const outcome = await this.telegram.queueInTransaction(
          tx,
          org,
          s.actorId,
          conn,
          x.id,
          text,
          { branchId: camp.branch_id, publicationId: r.id },
        );
        if (outcome === "queued") queued++;
        else skipped[outcome] = (skipped[outcome] ?? 0) + 1;
      }
      return queued
        ? record("queued", null, queued, skipped, false)
        : record("blocked", "NO_REACHABLE_RECIPIENTS", 0, skipped, false);
    });
  }
  // Actual campaign spend entered from documents; null means unknown (not zero).
  async setSpend(secret: Credential, org: string, id: string, input: unknown) {
    const c = spendInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:write");
      const camp = await this.load(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "marketing.spend",
        id,
        ...c,
      });
      if (r.reused) return { id, reused: true };
      if (camp.spend_version !== c.spendVersion)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "UPDATE marketing_campaigns SET spend_minor=$3,spend_note=$4,spend_version=spend_version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          c.spend === null ? null : new D(c.spend).times(100).toFixed(0),
          c.note,
        ],
      );
      await audit(tx, org, s.actorId, "marketing.spend_set", camp.branch_id, {
        campaignId: id,
        known: String(c.spend !== null),
      });
      return { id, reused: false };
    });
  }
  // REQ MKT 05: campaign period against an equally long control period right before it. The
  // difference is reported as a difference, not as the campaign's effect.
  async analysis(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:read");
      const c = await this.load(tx, org, id, s.branchId);
      const costVisible = can(s.role, "inventory:cost");
      const today = await this.today(tx, org);
      const caveats = ["seasonality_not_adjusted", "not_causal"];
      const start = c.data.startsOn,
        end = c.data.endsOn < today ? c.data.endsOn : today;
      if (today < start) caveats.push("period_not_started");
      else if (today < c.data.endsOn) caveats.push("period_in_progress");
      const [{ control_start, control_end, days }] = await tx.query<{
        control_start: string;
        control_end: string;
        days: number;
      }>(
        "SELECT ($1::date-($2::date-$1::date+1))::text control_start,($1::date-1)::text control_end,greatest($2::date-$1::date+1,0)::int days",
        [start, end < start ? start : end],
      );
      const ids = c.data.offer.lines.map((l) => l.itemId);
      const period = async (from: string, to: string) => {
        const [r] = await tx.query<{
          quantity: string;
          revenue_minor: string;
          cost_minor: string;
          unknown_cost: number;
          discount_minor: string;
          orders: number;
        }>(
          `SELECT coalesce(sum(CASE WHEN e.kind='fulfill' THEN e.quantity ELSE -e.quantity END),0)::text quantity,
            coalesce(sum(e.revenue_minor),0)::text revenue_minor, coalesce(sum(e.cost_minor),0)::text cost_minor,
            count(*) FILTER(WHERE e.cost_minor IS NULL)::int unknown_cost,
            coalesce(sum(round(l.price*e.quantity*l.discount) * CASE WHEN e.kind='fulfill' THEN 1 ELSE -1 END),0)::text discount_minor,
            count(DISTINCT e.order_id)::int orders
           FROM sales_events e JOIN sales_order_lines l ON l.organization_id=e.organization_id AND l.id=e.line_id
           JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id
           JOIN organizations g ON g.id=e.organization_id
           WHERE e.organization_id=$1 AND o.branch_id=$2 AND e.kind IN ('fulfill','return') AND l.item_id=ANY($3::uuid[])
             AND (e.created_at AT TIME ZONE g.timezone)::date BETWEEN $4::date AND $5::date`,
          [org, c.branch_id, ids, from, to],
        );
        const profit =
          r.unknown_cost === 0
            ? (BigInt(r.revenue_minor) - BigInt(r.cost_minor)).toString()
            : null;
        return {
          from,
          to,
          quantity: new D(r.quantity).toFixed(),
          revenueMinor: r.revenue_minor,
          discountMinor: r.discount_minor,
          costMinor: costVisible && r.unknown_cost === 0 ? r.cost_minor : null,
          unknownCostEvents: r.unknown_cost,
          grossProfitMinor: costVisible ? profit : null,
          orders: r.orders,
        };
      };
      const started = today >= start;
      const campaign = started ? await period(start, end) : null;
      const control =
        started && days > 0 ? await period(control_start, control_end) : null;
      if (campaign?.unknownCostEvents || control?.unknownCostEvents)
        caveats.push("unknown_costs");
      if (control && control.orders === 0) caveats.push("no_control_sales");
      if (c.spend_minor === null) caveats.push("spend_unknown");
      const [overlap] = await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM marketing_campaigns x WHERE x.organization_id=$1 AND x.branch_id=$2 AND x.id<>$3 AND x.state='approved' AND x.data->>'startsOn'<=$5 AND x.data->>'endsOn'>=$4 AND EXISTS(SELECT 1 FROM jsonb_array_elements(x.data->'offer'->'lines') l WHERE (l->>'itemId')::uuid=ANY($6::uuid[]))",
        [org, c.branch_id, id, start, c.data.endsOn, ids],
      );
      if (overlap.n) caveats.push("overlapping_campaigns");
      const [reach] = await tx.query<{ sent: number; any: number }>(
        "SELECT count(*) FILTER(WHERE m.state='sent')::int sent,count(*)::int any FROM messaging_messages m JOIN marketing_publications p ON p.organization_id=m.organization_id AND p.id=m.publication_id WHERE p.organization_id=$1 AND p.campaign_id=$2",
        [org, id],
      );
      const spend = c.spend_minor;
      const net =
        campaign?.grossProfitMinor != null && spend !== null
          ? (BigInt(campaign.grossProfitMinor) - BigInt(spend)).toString()
          : null;
      return {
        campaign,
        control,
        difference:
          campaign && control
            ? {
                quantity: new D(campaign.quantity)
                  .minus(control.quantity)
                  .toFixed(),
                revenueMinor: (
                  BigInt(campaign.revenueMinor) - BigInt(control.revenueMinor)
                ).toString(),
              }
            : null,
        spendMinor: spend,
        spendNote: c.spend_note,
        spendVersion: c.spend_version,
        netAfterSpendMinor: costVisible ? net : null,
        // Reach is known only for messages sent through a connected channel.
        reach: reach.any
          ? { sent: reach.sent, queuedOrTried: reach.any }
          : null,
        caveats,
      };
    });
  }
  // REQ MKT 02: co-purchase recommendations only with enough history and a minimum sample.
  async recommendations(
    secret: Credential,
    org: string,
    query: Record<string, string>,
  ) {
    const q = recommendQuery.parse(query);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "marketing:read");
      const [base] = await tx.query<{ total: number; anchor: number }>(
        "SELECT count(DISTINCT o.id)::int total,count(DISTINCT o.id) FILTER(WHERE l.item_id=$3)::int anchor FROM sales_orders o JOIN sales_order_lines l ON l.organization_id=o.organization_id AND l.order_id=o.id WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND o.state NOT IN ('draft','cancelled') AND o.created_at>=now()-make_interval(days=>$4)",
        [org, s.branchId, q.itemId, q.days],
      );
      const out = {
        itemId: q.itemId,
        days: q.days,
        totalOrders: base.total,
        anchorOrders: base.anchor,
        minAnchorOrders: MIN_ANCHOR_ORDERS,
        minPairOrders: MIN_PAIR_ORDERS,
        sufficient: base.anchor >= MIN_ANCHOR_ORDERS,
        items: [] as {
          itemId: string;
          sku: string;
          name: string;
          together: number;
          confidence: string;
          lift: string;
        }[],
      };
      if (!out.sufficient) return out;
      const rows = await tx.query<{
        item_id: string;
        sku: string;
        name: string;
        together: number;
        with_item: number;
      }>(
        `WITH scope AS (SELECT o.id FROM sales_orders o WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND o.state NOT IN ('draft','cancelled') AND o.created_at>=now()-make_interval(days=>$4)),
          anchor AS (SELECT DISTINCT l.order_id FROM sales_order_lines l JOIN scope ON scope.id=l.order_id WHERE l.organization_id=$1 AND l.item_id=$3),
          pairs AS (SELECT l.item_id,count(DISTINCT l.order_id)::int together FROM sales_order_lines l JOIN anchor a ON a.order_id=l.order_id WHERE l.organization_id=$1 AND l.item_id<>$3 GROUP BY l.item_id),
          freq AS (SELECT l.item_id,count(DISTINCT l.order_id)::int with_item FROM sales_order_lines l JOIN scope ON scope.id=l.order_id WHERE l.organization_id=$1 GROUP BY l.item_id)
         SELECT p.item_id,i.sku,i.name_ru name,p.together,f.with_item FROM pairs p JOIN freq f ON f.item_id=p.item_id JOIN catalog_items i ON i.organization_id=$1 AND i.id=p.item_id
         WHERE p.together>=$5 ORDER BY p.together DESC,i.sku LIMIT 10`,
        [org, s.branchId, q.itemId, q.days, MIN_PAIR_ORDERS],
      );
      out.items = rows.map((r) => {
        const confidence = new D(r.together).div(base.anchor);
        return {
          itemId: r.item_id,
          sku: r.sku,
          name: r.name,
          together: r.together,
          confidence: confidence.times(100).toFixed(1),
          lift: confidence.div(new D(r.with_item).div(base.total)).toFixed(2),
        };
      });
      return out;
    });
  }
}
