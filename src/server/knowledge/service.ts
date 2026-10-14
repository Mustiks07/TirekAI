import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { can } from "../../domain/permissions";
import { pagination } from "../../domain/import-contracts";
import {
  knowledgeInput,
  knowledgeUpload,
  knowledgeRevision,
  knowledgePublish,
  knowledgeQuery,
  type KnowledgeHit,
} from "../../domain/knowledge";
import { idempotent, emit, base64File, signatures } from "../execution/core";
import { extractDocument } from "../purchasing/extract";

const columns =
  "d.id,d.branch_id,d.title,d.category,d.audience,d.state,d.latest_version,d.published_version,d.review_due::text,(d.review_due IS NOT NULL AND d.review_due<(now() AT TIME ZONE o.timezone)::date) stale,d.version,d.updated_at";
const join =
  "knowledge_documents d JOIN organizations o ON o.id=d.organization_id";
// Readers see only published documents for their branch and role; editors also see drafts in their scope.
const visible = `d.organization_id=$1 AND ($2::uuid IS NULL OR d.branch_id IS NULL OR d.branch_id=$2) AND ($3::boolean OR (d.state='published' AND (jsonb_array_length(d.audience)=0 OR d.audience @> jsonb_build_array($4::text))))`;
type Access = { actorId: string; branchId: string | null; role: string };
export class KnowledgeService {
  constructor(private db: Database) {}
  private editor(s: Access) {
    return can(s.role as never, "knowledge:write");
  }
  private canEdit(s: Access, branch: string | null) {
    return this.editor(s) && (s.branchId === null || branch === s.branchId);
  }
  private async doc(tx: Sql, org: string, id: string, s: Access, lock = false) {
    idSchema.parse(id);
    const [d] = await tx.query<{
      id: string;
      branch_id: string | null;
      state: string;
      latest_version: number;
      published_version: number | null;
      version: number;
      title: string;
    }>(
      `SELECT ${columns} FROM ${join} WHERE ${visible} AND d.id=$5 ${lock ? "FOR UPDATE OF d" : ""}`,
      [org, s.branchId, this.editor(s), s.role, id],
    );
    if (!d) throw new AppError("NOT_FOUND", 404);
    return d;
  }
  async create(secret: Credential, org: string, input: unknown) {
    const c = knowledgeInput.parse(input);
    return this.db.transaction((tx) =>
      this.insert(tx, secret, org, c, c.body, null),
    );
  }
  async upload(secret: Credential, org: string, input: unknown) {
    const c = knowledgeUpload.parse(input);
    const { bytes, mime } = base64File(
      c.content,
      3 * 1024 * 1024,
      {
        "text/plain": signatures["text/plain"],
        "text/markdown": signatures["text/markdown"],
        "application/pdf": signatures["application/pdf"],
      },
      c.filename,
    );
    // Authorize before parsing the file; rights are checked again in the write transaction.
    await this.db.transaction((tx) =>
      sessionAccess(
        tx,
        secret,
        org,
        "knowledge:write",
        c.branchId || undefined,
      ),
    );
    const body =
      mime === "application/pdf"
        ? (await extractDocument(c.filename, bytes)).text.trim()
        : new TextDecoder("utf-8").decode(bytes).trim();
    if (!body) throw new AppError("DOCUMENT_EMPTY", 422);
    return this.db.transaction((tx) =>
      this.insert(tx, secret, org, c, body.slice(0, 100_000), {
        filename: c.filename,
        mime,
        bytes,
      }),
    );
  }
  private async insert(
    tx: Sql,
    secret: Credential,
    org: string,
    c: {
      key: string;
      branchId: string | null;
      title: string;
      category: string;
      audience: string[];
      reviewDue: string | null;
      changeNote: string;
    },
    body: string,
    file: { filename: string; mime: string; bytes: Buffer } | null,
  ) {
    const s = await sessionAccess(
      tx,
      secret,
      org,
      "knowledge:write",
      c.branchId || undefined,
    );
    // A branch-scoped editor cannot publish organization-wide instructions.
    if (!c.branchId && s.branchId) throw new AppError("FORBIDDEN", 403);
    const r = await idempotent(tx, org, c.key, {
      operation: "knowledge.create",
      ...c,
      body,
      sha: file ? createHash("sha256").update(file.bytes).digest("hex") : null,
    });
    if (r.reused) return r;
    await tx.query(
      "INSERT INTO knowledge_documents(id,organization_id,branch_id,title,category,audience,state,latest_version,review_due,created_by) VALUES($1,$2,$3,$4,$5,$6,'draft',1,$7,$8)",
      [
        r.id,
        org,
        c.branchId,
        c.title,
        c.category,
        JSON.stringify([...new Set(c.audience)]),
        c.reviewDue,
        s.actorId,
      ],
    );
    await tx.query(
      "INSERT INTO knowledge_versions(id,organization_id,document_id,number,title,body,filename,mime,original,sha256,change_note,author_id) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        randomUUID(),
        org,
        r.id,
        c.title,
        body,
        file?.filename || null,
        file?.mime || null,
        file?.bytes || null,
        file ? createHash("sha256").update(file.bytes).digest("hex") : null,
        c.changeNote,
        s.actorId,
      ],
    );
    await audit(tx, org, s.actorId, "knowledge.created", c.branchId, {
      documentId: r.id,
    });
    return r;
  }
  async revise(secret: Credential, org: string, id: string, input: unknown) {
    const c = knowledgeRevision.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "knowledge:write");
      const d = await this.doc(tx, org, id, s, true);
      if (!this.canEdit(s, d.branch_id)) throw new AppError("FORBIDDEN", 403);
      const r = await idempotent(tx, org, c.key, {
        operation: "knowledge.revise",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (d.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (d.state === "archived") throw new AppError("KNOWLEDGE_STATE", 409);
      if (d.latest_version >= 500)
        throw new AppError("DOCUMENT_REVISION_LIMIT", 422);
      // Versions are immutable; a revision is a new number and stays unpublished until published.
      await tx.query(
        "INSERT INTO knowledge_versions(id,organization_id,document_id,number,title,body,change_note,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          randomUUID(),
          org,
          id,
          d.latest_version + 1,
          c.title,
          c.body,
          c.changeNote,
          s.actorId,
        ],
      );
      await tx.query(
        "UPDATE knowledge_documents SET latest_version=latest_version+1,review_due=$3,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, c.reviewDue],
      );
      await audit(tx, org, s.actorId, "knowledge.revised", d.branch_id, {
        documentId: id,
        number: String(d.latest_version + 1),
      });
      return r;
    });
  }
  async publish(secret: Credential, org: string, id: string, input: unknown) {
    const c = knowledgePublish.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "knowledge:write");
      const d = await this.doc(tx, org, id, s, true);
      if (!this.canEdit(s, d.branch_id)) throw new AppError("FORBIDDEN", 403);
      const r = await idempotent(tx, org, c.key, {
        operation: "knowledge.publish",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (d.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (c.action === "archive") {
        await tx.query(
          "UPDATE knowledge_documents SET state='archived',version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
          [org, id],
        );
        await audit(tx, org, s.actorId, "knowledge.archived", d.branch_id, {
          documentId: id,
        });
        return r;
      }
      if (c.number > d.latest_version) throw new AppError("NOT_FOUND", 404);
      const [v] = await tx.query<{ title: string }>(
        "UPDATE knowledge_versions SET published_at=coalesce(published_at,now()),published_by=coalesce(published_by,$4) WHERE organization_id=$1 AND document_id=$2 AND number=$3 RETURNING title",
        [org, id, c.number, s.actorId],
      );
      await tx.query(
        "UPDATE knowledge_documents SET state='published',published_version=$3,title=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, c.number, v.title],
      );
      await emit(tx, {
        org,
        branch: d.branch_id,
        topic: "knowledge.published",
        entityType: "knowledge",
        entityId: id,
        payload: { number: c.number },
        actorId: s.actorId,
        dedupeKey: `knowledge.published:${id}:${d.version}`,
      });
      await audit(tx, org, s.actorId, "knowledge.published", d.branch_id, {
        documentId: id,
        number: String(c.number),
      });
      return r;
    });
  }
  async list(secret: Credential, org: string, input: unknown) {
    const q = knowledgeQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "knowledge:read",
        q.branchId,
      );
      const where = `${visible} AND position(lower($5) in lower(d.title||' '||d.category))>0 AND ($6::text='' OR d.state=$6)`;
      const params = [
        org,
        s.branchId,
        this.editor(s),
        s.role,
        q.q,
        q.state || "",
      ];
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        params,
      );
      return {
        items: await tx.query(
          `SELECT ${columns} FROM ${join} WHERE ${where} ORDER BY d.updated_at DESC,d.id LIMIT $7 OFFSET $8`,
          [...params, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async get(secret: Credential, org: string, id: string, number?: number) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "knowledge:read");
      const d = await this.doc(tx, org, id, s);
      const edit = this.canEdit(s, d.branch_id);
      // Readers get only the published version; editors may open any version.
      const target = edit ? number || d.latest_version : d.published_version;
      const [current] = target
        ? await tx.query(
            "SELECT v.id,v.number,v.title,v.body,v.filename,v.change_note,u.name author_name,v.created_at,v.published_at FROM knowledge_versions v JOIN users u ON u.id=v.author_id WHERE v.organization_id=$1 AND v.document_id=$2 AND v.number=$3",
            [org, id, target],
          )
        : [];
      return {
        document: d,
        current: current || null,
        versions: edit
          ? await tx.query(
              "SELECT v.id,v.number,v.title,v.filename,v.change_note,u.name author_name,v.created_at,v.published_at FROM knowledge_versions v JOIN users u ON u.id=v.author_id WHERE v.organization_id=$1 AND v.document_id=$2 ORDER BY v.number DESC LIMIT 100",
              [org, id],
            )
          : [],
        canEdit: edit,
      };
    });
  }
  async original(secret: Credential, org: string, id: string, number: number) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "knowledge:read");
      const d = await this.doc(tx, org, id, s);
      if (!this.canEdit(s, d.branch_id) && number !== d.published_version)
        throw new AppError("NOT_FOUND", 404);
      const [v] = await tx.query<{
        filename: string | null;
        original: Uint8Array | null;
      }>(
        "SELECT filename,original FROM knowledge_versions WHERE organization_id=$1 AND document_id=$2 AND number=$3",
        [org, id, number],
      );
      if (!v?.original || !v.filename) throw new AppError("NOT_FOUND", 404);
      return {
        filename: v.filename,
        content: Buffer.from(v.original).toString("base64"),
      };
    });
  }
  // Only the current published version of documents visible to this user; drafts never leak.
  async search(secret: Credential, org: string, input: unknown) {
    const q = knowledgeQuery.parse(input);
    return this.db.transaction((tx) =>
      this.searchInTransaction(tx, secret, org, q.q, q.limit),
    );
  }
  async searchInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    text: string,
    limit = 5,
  ): Promise<{ query: string; items: KnowledgeHit[] }> {
    const s = await sessionAccess(tx, secret, org, "knowledge:read");
    const query = text.trim().slice(0, 120);
    if (!query) return { query, items: [] };
    const rows = await tx.query<{
      document_id: string;
      version: number;
      title: string;
      category: string;
      body: string;
      stale: boolean;
      review_due: string | null;
      published_at: string;
    }>(
      `SELECT d.id document_id,v.number version,v.title,d.category,v.body,(d.review_due IS NOT NULL AND d.review_due<(now() AT TIME ZONE o.timezone)::date) stale,d.review_due::text,v.published_at::text published_at
       FROM knowledge_documents d JOIN organizations o ON o.id=d.organization_id JOIN knowledge_versions v ON v.organization_id=d.organization_id AND v.document_id=d.id AND v.number=d.published_version
       WHERE d.organization_id=$1 AND d.state='published' AND ($2::uuid IS NULL OR d.branch_id IS NULL OR d.branch_id=$2) AND (jsonb_array_length(d.audience)=0 OR d.audience @> jsonb_build_array($3::text))
       AND (to_tsvector('simple', v.title || ' ' || v.body) @@ plainto_tsquery('simple', $4) OR position(lower($4) in lower(v.title || ' ' || v.body))>0)
       ORDER BY ts_rank(to_tsvector('simple', v.title || ' ' || v.body), plainto_tsquery('simple', $4)) DESC,d.updated_at DESC LIMIT $5`,
      [org, s.branchId, s.role, query, Math.min(limit, 20)],
    );
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return {
      query,
      items: rows.map(({ body, ...r }) => {
        const lower = body.toLowerCase();
        const found = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0),
          at = found.length ? Math.max(0, Math.min(...found) - 80) : 0;
        return {
          ...r,
          excerpt: body.slice(at, at + 280),
        };
      }),
    };
  }
}
