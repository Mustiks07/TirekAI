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
import { CommerceService } from "../src/server/commerce/service";
import { CrmService } from "../src/server/crm/service";
import { TelegramService } from "../src/server/integrations/telegram-service";
import { MarketingService } from "../src/server/marketing/service";
import type { CampaignData, Evaluation } from "../src/domain/marketing";

// T039 end-to-end on synthetic data: margin recalculation, threshold and owner override,
// versioned approval, PDF export, consent-bound Telegram queue (local Bot API stand-in),
// analysis against a control period and co-purchase sample checks.
const TOKEN = "123456789:AAH-synthetic-token-for-marketing-test0";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const calls: { method: string; body: Record<string, unknown> }[] = [];
let server: Server, base: string;
let db: Database,
  p: Platform,
  org: string,
  branch: string,
  warehouse: string,
  owner: string,
  manager: string,
  seller: string,
  observer: string,
  itemA: string,
  itemB: string,
  itemC: string,
  itemD: string,
  today: string,
  mk: MarketingService,
  inventory: InventoryService,
  commerce: CommerceService;
const customers: string[] = [];
const key = () => randomUUID();
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
function data(patch: Partial<CampaignData> = {}): CampaignData {
  return {
    name: "Осенняя скидка",
    branchId: branch,
    warehouseId: warehouse,
    startsOn: shift(today, -1),
    endsOn: shift(today, 6),
    budget: "20000",
    minMargin: "20",
    offer: { kind: "discount", lines: [{ itemId: itemA, discount: "20" }] },
    segment: {
      kind: "all",
      itemIds: [],
      days: 90,
      channel: "messenger",
      excluded: [],
    },
    materials: {
      ru: { title: "Осенняя скидка", body: "Чай со скидкой", terms: "" },
      kk: { title: "Күзгі жеңілдік", body: "Шай жеңілдікпен", terms: "" },
      imageId: null,
    },
    ...patch,
  };
}
async function item(
  name: string,
  kind: "goods" | "service",
  purchase: string | null,
  sale: string | null,
  stock?: string,
) {
  const id = (
    await inventory.saveItem(owner, org, {
      sku: `SKU-${name}`,
      name_ru: name,
      name_kk: `${name} KK`,
      kind,
      base_unit: kind === "goods" ? "pc" : "hour",
      purchase_price: purchase,
      sale_price: sale,
    })
  ).id!;
  if (stock)
    await inventory.execute(owner, org, {
      key: key(),
      kind: "receipt",
      warehouseId: warehouse,
      itemId: id,
      quantity: stock,
      unit: "pc",
      unitCost: purchase ?? "600",
      note: "Synthetic receipt",
    });
  return id;
}
async function sell(
  lines: { itemId: string; quantity: string }[],
  fulfill = true,
) {
  const o = await commerce.create(owner, org, {
    key: key(),
    branchId: branch,
    customerId: customers[0],
    warehouseId: warehouse,
    dueDate: today,
    delivery: "pickup",
    note: "Synthetic order",
    taxMode: "excluded",
    lines: lines.map((l) => ({
      ...l,
      unit: l.itemId === itemC ? "hour" : "pc",
      price: "1000",
      discount: "0",
    })),
  });
  let view = await commerce.get(owner, org, o.id);
  await commerce.transition(owner, org, o.id, {
    key: key(),
    version: view.order.version,
    kind: "confirm",
    note: "Synthetic confirm",
  });
  if (fulfill)
    for (const line of view.lines) {
      view = await commerce.get(owner, org, o.id);
      await commerce.transition(owner, org, o.id, {
        key: key(),
        version: view.order.version,
        kind: "fulfill",
        lineId: line.id,
        quantity: line.quantity,
        note: "Synthetic fulfill",
      });
    }
  return o.id;
}
const version = async (id: string) =>
  (await mk.get(owner, org, id)).campaign.version;
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!m || m[1] !== TOKEN) {
        res.writeHead(401);
        return res.end(JSON.stringify({ ok: false, error_code: 401 }));
      }
      const body = JSON.parse(raw || "{}");
      calls.push({ method: m[2], body });
      const result =
        m[2] === "getMe"
          ? { id: 1, is_bot: true, username: "taraz_promo_bot" }
          : m[2] === "sendMessage"
            ? { message_id: calls.length, chat: { id: body.chat_id } }
            : true;
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  mk = new MarketingService(db);
  inventory = new InventoryService(db);
  commerce = new CommerceService(db);
  const user = () =>
    p.register({
      name: "Promo",
      email: `${key()}@example.test`,
      password: "Synthetic-Promo-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "Promo Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  for (const role of ["manager", "sales", "observer"]) {
    const u = await user(),
      inv = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: inv.token });
    if (role === "manager") manager = u.token;
    else if (role === "sales") seller = u.token;
    else observer = u.token;
  }
  warehouse = (
    await inventory.createWarehouse(owner, org, {
      branchId: branch,
      name: "Main",
    })
  ).id;
  [{ today }] = await db.query<{ today: string }>(
    "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
    [org],
  );
  itemA = await item("Чай", "goods", "600", "1000", "10");
  itemB = await item("Мёд", "goods", null, "500");
  itemC = await item("Дегустация", "service", "1500", "2000");
  itemD = await item("Печенье", "goods", "200", "400", "100");
  const crm = new CrmService(db);
  for (const [name, messenger] of [
    ["Айгерим", false],
    ["Бауыржан", true],
    ["Сауле", false],
    ["Ерлан", true],
  ] as const)
    customers.push(
      (
        await crm.createCustomer(owner, org, {
          key: key(),
          branchId: branch,
          name,
          email: "",
          phone: "+77000000001",
          kind: "person",
          responsibleId: null,
          consents: { email: false, sms: false, messenger },
          consentNote: "Synthetic consent record",
        })
      ).id,
    );
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
let campaign: string;
it("T039: a discount change recalculates the margin from average stock cost; cost is hidden without inventory:cost; rights are checked", async () => {
  await expect(mk.list(observer, org)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const k = key();
  campaign = (await mk.create(seller, org, { key: k, data: data() })).id;
  expect((await mk.create(seller, org, { key: k, data: data() })).reused).toBe(
    true,
  );
  let view = await mk.get(manager, org, campaign);
  expect(view.campaign).toMatchObject({ state: "draft", version: 1 });
  expect(view.evaluation).toMatchObject({
    status: "ok",
    lowestMargin: "25.00",
    lines: [
      {
        priceMinor: "100000",
        promoMinor: "80000",
        costMinor: "60000",
        costSource: "stock_average",
        margin: "25.00",
        regularMargin: "40.00",
        available: "10",
      },
    ],
  });
  await mk.update(seller, org, campaign, {
    key: key(),
    version: 1,
    note: "Скидка 30%",
    data: data({
      offer: { kind: "discount", lines: [{ itemId: itemA, discount: "30" }] },
    }),
  });
  view = await mk.get(manager, org, campaign);
  expect(view.evaluation).toMatchObject({
    status: "below_threshold",
    lowestMargin: "14.29",
    lines: [{ promoMinor: "70000", margin: "14.29" }],
  });
  const salesView = await mk.get(seller, org, campaign);
  expect(salesView.evaluation).toMatchObject({
    status: "below_threshold",
    costVisible: false,
    lowestMargin: null,
    lines: [{ promoMinor: "70000", costMinor: null, margin: null }],
  });
  // Stale version.
  await expect(
    mk.update(seller, org, campaign, {
      key: key(),
      version: 1,
      note: "Опоздавшая правка",
      data: data(),
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  // Unknown cost stays unknown, not zero.
  const unknown = await mk.evaluate(
    manager,
    org,
    data({
      offer: { kind: "discount", lines: [{ itemId: itemB, discount: "10" }] },
    }),
  );
  expect(unknown).toMatchObject({
    status: "unknown_margin",
    lowestMargin: null,
    lines: [{ costSource: "unknown", costMinor: null, margin: null }],
  });
  // Bundle: goods at average cost plus a service at its purchase price.
  const bundle = await mk.evaluate(
    manager,
    org,
    data({
      offer: {
        kind: "bundle",
        price: "2900",
        lines: [
          { itemId: itemA, quantity: "1" },
          { itemId: itemC, quantity: "1" },
        ],
      },
    }),
  );
  expect(bundle).toMatchObject({
    status: "ok",
    bundle: {
      priceMinor: "290000",
      regularMinor: "300000",
      costMinor: "210000",
      margin: "27.59",
      sets: "10",
    },
  });
  const dearer = await mk.evaluate(
    manager,
    org,
    data({
      offer: {
        kind: "bundle",
        price: "3000",
        lines: [
          { itemId: itemA, quantity: "1" },
          { itemId: itemC, quantity: "1" },
        ],
      },
    }),
  );
  expect(dearer.status).toBe("invalid");
  expect(dearer.issues).toContainEqual({ code: "BUNDLE_NOT_CHEAPER" });
});
it("T039: below the threshold approval is blocked; only the owner overrides with a reason; no self-approval; approval is bound to a version", async () => {
  await expect(
    mk.decide(seller, org, campaign, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Согласую",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    mk.decide(manager, org, campaign, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Согласую",
    }),
  ).rejects.toMatchObject({ code: "CAMPAIGN_STATE" });
  await mk.decide(seller, org, campaign, {
    key: key(),
    version: 2,
    kind: "submit",
  });
  await expect(
    mk.decide(manager, org, campaign, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Согласую",
    }),
  ).rejects.toMatchObject({ code: "MARGIN_BELOW_THRESHOLD" });
  await expect(
    mk.decide(manager, org, campaign, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Согласую ниже порога",
      override: true,
    }),
  ).rejects.toMatchObject({ code: "OVERRIDE_FORBIDDEN" });
  await expect(
    mk.decide(owner, org, campaign, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Да",
      override: true,
    }),
  ).rejects.toThrow();
  await expect(
    mk.decide(owner, org, campaign, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Коротко",
      override: true,
    }),
  ).rejects.toMatchObject({ code: "OVERRIDE_REASON" });
  await mk.decide(owner, org, campaign, {
    key: key(),
    version: 2,
    kind: "approve",
    note: "Распродажа остатков сезона, маржа 14% допустима",
    override: true,
  });
  const view = await mk.get(owner, org, campaign);
  expect(view.campaign).toMatchObject({
    state: "approved",
    approved_version: 2,
  });
  expect(view.decisions.map((d) => [d.decision, d.override])).toEqual([
    ["submitted", false],
    ["approved", true],
  ]);
  // The author of a version cannot approve it.
  const own = (await mk.create(owner, org, { key: key(), data: data() })).id;
  await mk.decide(owner, org, own, { key: key(), version: 1, kind: "submit" });
  await expect(
    mk.decide(owner, org, own, {
      key: key(),
      version: 1,
      kind: "approve",
      note: "Сам себе",
    }),
  ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
  await mk.decide(manager, org, own, {
    key: key(),
    version: 1,
    kind: "approve",
    note: "Маржа в норме",
  });
  expect((await mk.get(owner, org, own)).campaign.state).toBe("approved");
  // An invalid offer cannot even be submitted.
  const bad = (
    await mk.create(seller, org, {
      key: key(),
      data: data({
        offer: {
          kind: "bundle",
          price: "3000",
          lines: [
            { itemId: itemA, quantity: "1" },
            { itemId: itemC, quantity: "1" },
          ],
        },
      }),
    })
  ).id;
  await expect(
    mk.decide(seller, org, bad, { key: key(), version: 1, kind: "submit" }),
  ).rejects.toMatchObject({ code: "CAMPAIGN_INVALID" });
});
it("T039: materials export as PDF only from the approved version; manual image upload; generator not configured; edits drop the approval", async () => {
  const k = key();
  const pdf = await mk.exportMaterial(seller, org, campaign, {
    key: k,
    version: 2,
    material: "poster",
    locale: "ru",
  });
  expect(Buffer.from(pdf.content, "base64").subarray(0, 5).toString()).toBe(
    "%PDF-",
  );
  expect(
    (
      await mk.exportMaterial(seller, org, campaign, {
        key: k,
        version: 2,
        material: "poster",
        locale: "ru",
      })
    ).publicationId,
  ).toBe(pdf.publicationId);
  for (const material of ["price_tag", "card"] as const)
    await mk.exportMaterial(seller, org, campaign, {
      key: key(),
      version: 2,
      material,
      locale: "kk",
    });
  let view = await mk.get(seller, org, campaign);
  expect(view.publications.map((x) => x.state)).toEqual([
    "exported",
    "exported",
    "exported",
  ]);
  expect(view.publications.some((x) => x.state === "published")).toBe(false);
  await expect(
    mk.uploadImage(seller, org, campaign, {
      key: key(),
      mime: "image/png",
      content: Buffer.from("GIF89a-not-a-png").toString("base64"),
      altRu: "Пачка чая",
      altKk: "Шай қорабы",
    }),
  ).rejects.toMatchObject({ code: "IMAGE_TYPE" });
  await expect(mk.generateImage(seller, org, campaign)).rejects.toMatchObject({
    code: "IMAGE_GENERATOR_NOT_CONFIGURED",
  });
  const image = (
    await mk.uploadImage(seller, org, campaign, {
      key: key(),
      mime: "image/png",
      content: PNG.toString("base64"),
      altRu: "Пачка чая",
      altKk: "Шай қорабы",
    })
  ).id;
  const template = await mk.template(seller, org, campaign);
  expect(template.ru.body).toContain("700 ₸ вместо 1000 ₸");
  expect(template.kk.body).toContain("1000 ₸ орнына 700 ₸");
  const next = data({
    offer: { kind: "discount", lines: [{ itemId: itemA, discount: "30" }] },
  });
  next.materials = { ...template, imageId: image };
  next.segment = { ...next.segment, excluded: [customers[3]] };
  await mk.update(seller, org, campaign, {
    key: key(),
    version: 2,
    note: "Текст из шаблона и фото",
    data: next,
  });
  view = await mk.get(seller, org, campaign);
  expect(view.campaign).toMatchObject({
    state: "draft",
    version: 3,
    approved_version: null,
  });
  await expect(
    mk.exportMaterial(seller, org, campaign, {
      key: key(),
      version: 3,
      material: "card",
      locale: "kk",
    }),
  ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_APPROVED" });
  await mk.decide(seller, org, campaign, {
    key: key(),
    version: 3,
    kind: "submit",
  });
  await mk.decide(owner, org, campaign, {
    key: key(),
    version: 3,
    kind: "approve",
    note: "Распродажа остатков сезона, маржа 14% допустима",
    override: true,
  });
  const card = await mk.exportMaterial(seller, org, campaign, {
    key: key(),
    version: 3,
    material: "card",
    locale: "kk",
  });
  expect(Buffer.from(card.content, "base64").length).toBeGreaterThan(1000);
});
it("T039: publication is logged honestly: not_configured without a channel, queued only for consenting linked customers", async () => {
  const v = await version(campaign);
  const preview = await mk.previewSegment(seller, org, {
    branchId: branch,
    segment: {
      kind: "all",
      channel: "messenger",
      excluded: [customers[3]],
    },
  });
  expect(preview).toMatchObject({
    matched: 4,
    excluded: 1,
    noConsent: 2,
    noContact: 1,
    reachable: 0,
  });
  await expect(
    mk.publish(seller, org, campaign, {
      key: key(),
      version: v,
      channel: "telegram",
      locale: "ru",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const none = await mk.publish(manager, org, campaign, {
    key: key(),
    version: v,
    channel: "telegram",
    locale: "ru",
  });
  expect(none).toMatchObject({
    state: "not_configured",
    reason: "CHANNEL_NOT_CONNECTED",
    recipients: 0,
  });
  // Connect a bot (local stand-in), enable outbound, link the first customer by /start code.
  const tg = TelegramService.forContractServer(db, base);
  const connection = (
    await tg.configure(owner, org, {
      key: key(),
      botToken: TOKEN,
      branchId: branch,
    })
  ).id;
  await tg.check(owner, org, connection);
  await tg.registerWebhook(owner, org, connection, "https://app.example.kz");
  const set = calls.find((x) => x.method === "setWebhook")!.body as {
    url: string;
    secret_token: string;
  };
  const disabled = await mk.publish(manager, org, campaign, {
    key: key(),
    version: v,
    channel: "telegram",
    locale: "ru",
  });
  expect(disabled).toMatchObject({
    state: "not_configured",
    reason: "MESSAGING_DISABLED",
  });
  const [conn] = await db.query<{ version: number }>(
    "SELECT version FROM integration_connections WHERE id=$1",
    [connection],
  );
  await tg.setOutbound(owner, org, connection, {
    key: key(),
    version: conn.version,
    enabled: true,
  });
  const { code } = await tg.createLink(seller, org, connection, {
    customerId: customers[0],
  });
  await tg.receiveUpdate(
    connection,
    set.url.split("/").pop()!,
    set.secret_token,
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1760500000,
        chat: { id: 555, type: "private" },
        from: { id: 555, is_bot: false, first_name: "Айгерим" },
        text: `/start ${code}`,
      },
    },
  );
  await tg.processInbox();
  const k = key();
  const queued = await mk.publish(manager, org, campaign, {
    key: k,
    version: v,
    channel: "telegram",
    locale: "ru",
  });
  expect(queued).toMatchObject({ state: "queued", recipients: 1 });
  expect(
    (
      await mk.publish(manager, org, campaign, {
        key: k,
        version: v,
        channel: "telegram",
        locale: "ru",
      })
    ).reused,
  ).toBe(true);
  const [pub] = await db.query<{ skipped: Record<string, number> }>(
    "SELECT skipped FROM marketing_publications WHERE id=$1",
    [queued.id],
  );
  expect(pub.skipped).toEqual({ excluded: 1, not_linked: 2 });
  let view = await mk.get(owner, org, campaign);
  expect(view.publications.find((x) => x.id === queued.id)).toMatchObject({
    state: "queued",
    sent: 0,
  });
  await tg.processOutbox();
  const sent = calls.filter((x) => x.method === "sendMessage");
  expect(sent).toHaveLength(1);
  expect(sent[0].body.chat_id).toBe("555");
  expect(String(sent[0].body.text)).toContain("700 ₸ вместо 1000 ₸");
  view = await mk.get(owner, org, campaign);
  expect(view.publications.find((x) => x.id === queued.id)).toMatchObject({
    state: "queued",
    sent: 1,
  });
});
it("T039: a catalog price change after approval blocks export of stale materials", async () => {
  const [row] = await db.query<{ version: number }>(
    "SELECT version FROM catalog_items WHERE id=$1",
    [itemD],
  );
  const own = (
    await mk.create(seller, org, {
      key: key(),
      data: data({
        offer: { kind: "discount", lines: [{ itemId: itemD, discount: "10" }] },
      }),
    })
  ).id;
  await mk.decide(seller, org, own, { key: key(), version: 1, kind: "submit" });
  await mk.decide(manager, org, own, {
    key: key(),
    version: 1,
    kind: "approve",
    note: "Маржа в норме",
  });
  await inventory.saveItem(
    owner,
    org,
    {
      sku: "SKU-Печенье",
      name_ru: "Печенье",
      name_kk: "Печенье KK",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "200",
      sale_price: "450",
      version: row.version,
    },
    itemD,
  );
  await expect(
    mk.exportMaterial(seller, org, own, {
      key: key(),
      version: 1,
      material: "price_tag",
      locale: "ru",
    }),
  ).rejects.toMatchObject({ code: "OFFER_CHANGED" });
});
it("T039: analysis compares with a control period, keeps unknown spend unknown and states its limits; co-purchase needs a sample", async () => {
  // Control period: two days before the campaign start (shifted synthetic sale).
  const control = await sell([{ itemId: itemA, quantity: "1" }]);
  await db.query(
    "UPDATE sales_events SET created_at=now()-interval '2 days' WHERE order_id=$1",
    [control],
  );
  await sell([{ itemId: itemA, quantity: "2" }]);
  let a = await mk.analysis(owner, org, campaign);
  expect(a.campaign).toMatchObject({
    quantity: "2",
    revenueMinor: "200000",
    costMinor: "120000",
    grossProfitMinor: "80000",
  });
  expect(a.control).toMatchObject({ quantity: "1", revenueMinor: "100000" });
  expect(a.difference).toEqual({ quantity: "1", revenueMinor: "100000" });
  expect(a.spendMinor).toBeNull();
  expect(a.netAfterSpendMinor).toBeNull();
  expect(a.caveats).toEqual(
    expect.arrayContaining([
      "seasonality_not_adjusted",
      "not_causal",
      "period_in_progress",
      "spend_unknown",
    ]),
  );
  expect(a.reach).toEqual({ sent: 1, queuedOrTried: 1 });
  await mk.setSpend(seller, org, campaign, {
    key: key(),
    spendVersion: 0,
    spend: "15000",
    note: "Счёт типографии №12",
  });
  await expect(
    mk.setSpend(seller, org, campaign, {
      key: key(),
      spendVersion: 0,
      spend: "1",
      note: "Устаревшая правка",
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  a = await mk.analysis(owner, org, campaign);
  expect(a.netAfterSpendMinor).toBe("-1420000");
  expect(a.caveats).not.toContain("spend_unknown");
  const hidden = await mk.analysis(seller, org, campaign);
  expect(hidden.campaign).toMatchObject({
    costMinor: null,
    grossProfitMinor: null,
  });
  expect(hidden.netAfterSpendMinor).toBeNull();
  // Co-purchase: below the minimum sample nothing is recommended.
  let rec = await mk.recommendations(manager, org, { itemId: itemA });
  expect(rec).toMatchObject({ sufficient: false, items: [] });
  for (let i = 0; i < 30; i++)
    await sell(
      [
        { itemId: itemD, quantity: "1" },
        { itemId: itemC, quantity: "1" },
      ],
      false,
    );
  rec = await mk.recommendations(manager, org, { itemId: itemD });
  expect(rec).toMatchObject({ sufficient: true, anchorOrders: 30 });
  expect(rec.items[0]).toMatchObject({
    itemId: itemC,
    together: 30,
    confidence: "100.0",
  });
  const evaluation: Evaluation = (await mk.get(owner, org, campaign))
    .evaluation;
  expect(evaluation.lines[0].available).toBe("7");
});
