import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { OneCService } from "../src/server/integrations/onec-service";
import { validInfobaseUrl } from "../src/server/integrations/onec";

// Local server built from the 1C:Enterprise 8.3.27 Developer Guide §17.4 shapes: resource
// names Catalog_<Name>, $format=json → {"odata.metadata","value"}, $select/$orderby/$top/$skip,
// Ref_Key/DataVersion/DeletionMark, 401 for bad credentials, 4XX with <m:error><m:code>.
// Not a live infobase.
const HOST = "https://erp.example.kz/trade",
  USER = "odata",
  PASSWORD = "Synthetic-1C-pass-661";
type P = {
  Ref_Key: string;
  DataVersion: string;
  DeletionMark: boolean;
  IsFolder: boolean;
  Code: string;
  Description: string;
  Артикул: string;
  ЕдиницаИзмерения_Key: string;
};
const unitPc = randomUUID(),
  unitKg = randomUUID(),
  unitOdd = randomUUID();
const state = { products: [] as P[], requests: [] as string[], down: false };
let server: Server, base: string;
const fetcher = ((url: string | URL | Request, init?: RequestInit) =>
  fetch(
    String(url).replace("https://erp.example.kz", base),
    init,
  )) as typeof fetch;
let db: Database,
  p: Platform,
  org: string,
  owner: string,
  manager: string,
  svc: OneCService,
  connection: string;
const key = () => randomUUID();
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    state.requests.push(decodeURIComponent(url.pathname) + url.search);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const fault = (status: number, code: number, message: string) => {
      res.writeHead(status, { "Content-Type": "application/xml" });
      res.end(
        `<m:error xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><m:code>${code}</m:code><m:message>${message}</m:message></m:error>`,
      );
    };
    if (state.down) return fault(503, -1, "unavailable");
    const auth = Buffer.from(
      (req.headers.authorization || "").replace("Basic ", ""),
      "base64",
    ).toString("utf8");
    if (auth !== `${USER}:${PASSWORD}`) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="1C"' });
      return res.end();
    }
    const m = /^\/trade\/odata\/standard\.odata\/(.+)$/.exec(
      decodeURIComponent(url.pathname),
    );
    if (!m || url.searchParams.get("$format") !== "json")
      return fault(400, 3, "format");
    const top = Number(url.searchParams.get("$top") || 1000),
      skip = Number(url.searchParams.get("$skip") || 0);
    const meta = `${base}/trade/odata/standard.odata/$metadata#${m[1]}`;
    if (m[1] === "Catalog_КлассификаторЕдиницИзмерения")
      return json(200, {
        "odata.metadata": meta,
        value: [
          {
            Ref_Key: unitPc,
            DataVersion: "AAAAAQ==",
            DeletionMark: false,
            Code: "796",
          },
          {
            Ref_Key: unitKg,
            DataVersion: "AAAAAQ==",
            DeletionMark: false,
            Code: "166",
          },
          {
            Ref_Key: unitOdd,
            DataVersion: "AAAAAQ==",
            DeletionMark: false,
            Code: "778",
          },
        ].slice(skip, skip + top),
      });
    if (m[1] === "Catalog_Номенклатура") {
      const rows = [...state.products].sort((a, b) =>
        a.Ref_Key.localeCompare(b.Ref_Key),
      );
      return json(200, {
        "odata.metadata": meta,
        value: rows.slice(skip, skip + top),
      });
    }
    fault(400, 8, "No entity type is found.");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 450; i++)
    state.products.push({
      Ref_Key: randomUUID(),
      DataVersion: "AAAAAA==",
      DeletionMark: i === 1,
      IsFolder: i === 2,
      Code: `0000${i}`,
      Description: `Товар 1С ${i}`,
      Артикул: i === 4 ? "" : `1C-${i}`,
      ЕдиницаИзмерения_Key: i === 3 ? unitOdd : i % 5 ? unitPc : unitKg,
    });
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "1C",
      email: `${key()}@example.test`,
      password: "Synthetic-OneC-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "1C Lab", profile: "retail" })
  ).id;
  const branch = (await p.workspace(owner, org)).branches[0].id;
  const u = await user(),
    inv = await p.invite(owner, org, {
      email: u.user.email,
      role: "manager",
      branchId: branch,
    });
  await p.acceptInvitation(u.token, { token: inv.token });
  manager = u.token;
  await new InventoryService(db).saveItem(owner, org, {
    sku: "1C-7",
    name_ru: "Локальный",
    kind: "goods",
    base_unit: "pc",
    purchase_price: "1",
    sale_price: "2",
  });
  svc = OneCService.forContractServer(db, fetcher);
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
it("T032: HTTPS public publication only, owner only, password sealed, wrong object name is reported", async () => {
  for (const bad of [
    "http://erp.example.kz/trade",
    "https://localhost/trade",
    "https://192.168.1.10/trade",
    "https://10.0.0.1/trade",
    "https://user:pw@erp.example.kz/trade",
    "https://erp.example.kz/trade?x=1",
  ])
    expect(validInfobaseUrl(bad)).toBe(false);
  expect(validInfobaseUrl(HOST)).toBe(true);
  const input = {
    key: key(),
    infobaseUrl: HOST,
    user: USER,
    password: PASSWORD,
  };
  await expect(svc.configure(manager, org, input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    svc.configure(owner, org, {
      ...input,
      key: key(),
      products: "Catalog_Bad'); DROP",
    }),
  ).rejects.toMatchObject({ code: "ONEC_SETTINGS_INVALID" });
  const wrong = await svc.configure(owner, org, {
    ...input,
    key: key(),
    products: "Catalog_Товары",
  });
  connection = wrong.id;
  const [row] = await db.query<{ credentials: Uint8Array }>(
    "SELECT credentials FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(Buffer.from(row.credentials).toString("utf8")).not.toContain(PASSWORD);
  await expect(svc.check(owner, org, connection)).rejects.toMatchObject({
    code: "ONEC_ENTITY_NOT_FOUND",
  });
  expect((await svc.configure(owner, org, { ...input, key: key() })).id).toBe(
    connection,
  );
  await svc.check(owner, org, connection);
  const [c] = await db.query<{
    status: string;
    verification: { scope: string };
  }>("SELECT status,verification FROM integration_connections WHERE id=$1", [
    connection,
  ]);
  expect(c).toMatchObject({
    status: "configured",
    verification: { scope: "contract_server" },
  });
});
it("T032: full ordered scan in pages, OKEI units, folders/deletion marks, conflicts, no zero prices, idempotent rerun", async () => {
  const stats = await svc.syncNow(owner, org, connection);
  // 450 rows − 1 folder; 1 deletion-marked new row is skipped, 1 odd unit and 1 taken SKU conflict.
  expect(stats).toMatchObject({
    created: 446,
    skipped_deleted: 1,
    conflicts: 2,
  });
  const pages = state.requests.filter(
    (r) => r.includes("Catalog_Номенклатура") && r.includes("%24skip"),
  );
  expect(pages.length).toBeGreaterThanOrEqual(3);
  const reasons = await db.query<{ reason: string }>(
    "SELECT reason FROM sync_conflicts WHERE connection_id=$1 ORDER BY reason",
    [connection],
  );
  expect(reasons.map((r) => r.reason)).toEqual(["sku_exists", "unit_unmapped"]);
  const items = await db.query<{
    sku: string;
    base_unit: string;
    purchase_price: string | null;
    sale_price: string | null;
  }>(
    "SELECT sku,base_unit,purchase_price::text,sale_price::text FROM catalog_items WHERE organization_id=$1 AND category='1С' ORDER BY sku",
    [org],
  );
  expect(items).toHaveLength(446);
  expect(
    items.every((i) => i.purchase_price === null && i.sale_price === null),
  ).toBe(true);
  expect(items.find((i) => i.sku === "1C-5")!.base_unit).toBe("kg");
  expect(items.some((i) => i.sku === "00004")).toBe(true);
  const again = await svc.syncNow(owner, org, connection);
  expect(again.created || 0).toBe(0);
  expect(again.unchanged).toBe(446);
});
it("T032: a changed DataVersion updates once; a deletion mark archives; a product gone from a full scan is archived", async () => {
  const changed = state.products.find((x) => x.Артикул === "1C-10")!;
  changed.Description = "Переименован в 1С";
  changed.DataVersion = "AAAAAg==";
  const marked = state.products.find((x) => x.Артикул === "1C-11")!;
  marked.DeletionMark = true;
  marked.DataVersion = "AAAAAg==";
  const removed = state.products.findIndex((x) => x.Артикул === "1C-12");
  state.products.splice(removed, 1);
  const stats = await svc.syncNow(owner, org, connection);
  expect(stats).toMatchObject({ updated: 1, archived: 1, removed: 1 });
  const rows = await db.query<{
    sku: string;
    name_ru: string;
    active: boolean;
  }>(
    "SELECT sku,name_ru,active FROM catalog_items WHERE organization_id=$1 AND sku IN ('1C-10','1C-11','1C-12') ORDER BY sku",
    [org],
  );
  expect(rows).toEqual([
    { sku: "1C-10", name_ru: "Переименован в 1С", active: true },
    { sku: "1C-11", name_ru: "Товар 1С 11", active: false },
    { sku: "1C-12", name_ru: "Товар 1С 12", active: false },
  ]);
});
it("T032: unavailable server and bad password are recorded as failures; disconnect erases the login", async () => {
  state.down = true;
  await expect(svc.syncNow(owner, org, connection)).rejects.toMatchObject({
    code: "ONEC_503",
  });
  state.down = false;
  await svc.configure(owner, org, {
    key: key(),
    infobaseUrl: HOST,
    user: USER,
    password: "wrong-password",
  });
  await expect(svc.check(owner, org, connection)).rejects.toMatchObject({
    code: "ONEC_AUTH_FAILED",
  });
  const [c] = await db.query<{ status: string; last_error_code: string }>(
    "SELECT status,last_error_code FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(c).toEqual({
    status: "degraded",
    last_error_code: "ONEC_AUTH_FAILED",
  });
  await svc.disconnect(owner, org, connection);
  await expect(svc.syncNow(owner, org, connection)).rejects.toMatchObject({
    code: "INTEGRATION_NOT_CONFIGURED",
  });
});
