import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

// T052: full pass of every section available to the owner — Kazakh (default) and Russian,
// mobile 360/390/430 and desktop 1280/1440 — with layout, accessibility and wording checks, plus
// keyboard, visible focus, enlarged text, reduced motion and Kazakh glyphs in every font weight.
const origin = "http://127.0.0.1:3100";
const mobile = [360, 390, 430],
  desktop = [1280, 1440];
function client(request: APIRequestContext) {
  const post = async (path: string, data: unknown) => {
    const r = await request.post(`/api/v1/${path}`, {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  const get = async (path: string) => {
    const r = await request.get(`/api/v1/${path}`);
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  return { post, get };
}
async function seed(page: Page) {
  const api = client(page.request);
  await api.post("auth/register", {
    name: "Собственник",
    email: `ui-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Ui-661!",
  });
  const org = (
    await api.post("organizations", { name: "Сынақ UI", profile: "retail" })
  ).id;
  const base = `organizations/${org}`;
  const branch = (await api.get(base)).branches[0].id;
  const warehouse = (
    await api.post(`${base}/warehouses`, { branchId: branch, name: "Қойма" })
  ).id;
  const item = (
    await api.post(`${base}/catalog`, {
      sku: "UI-1",
      name_ru: "Чай",
      name_kk: "Шай ӘҒҚҢӨҰҮҺІ",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "10",
      sale_price: "20",
    })
  ).id;
  await api.post(`${base}/stock-commands`, {
    key: randomUUID(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "5",
    unit: "pc",
    unitCost: "10",
    note: "Бастапқы қалдық",
  });
  const customer = (
    await api.post(`${base}/crm/customers`, {
      key: randomUUID(),
      branchId: branch,
      name: "Әсел Құрманғазы",
      email: "",
      phone: "",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Сынақ деректері",
    })
  ).id;
  await api.post(`${base}/orders`, {
    key: randomUUID(),
    branchId: branch,
    customerId: customer,
    warehouseId: warehouse,
    dueDate: "2026-12-31",
    delivery: "pickup",
    note: "Сынақ тапсырысы",
    taxMode: "excluded",
    lines: [
      { itemId: item, quantity: "1", unit: "pc", price: "20", discount: "0" },
    ],
  });
  await api.post(`${base}/finance/accounts`, {
    key: randomUUID(),
    branchId: branch,
    name: "Касса",
    opening: "1000",
  });
  return { org };
}
const settle = async (page: Page) => {
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByText(/^(Загрузка|Жүктелуде)/)).toHaveCount(0, {
    timeout: 15000,
  });
};
type Check = {
  locale: string;
  width: number;
  section: string;
  overflow: number;
  axe: string[];
  emDash: boolean;
  demo: boolean;
  smallTargets: string[];
};
async function inspect(
  page: Page,
  locale: string,
  width: number,
  section: string,
  axe: boolean,
): Promise<Check> {
  const layout = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const text = document.body.innerText;
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      "main button, main input:not([type=hidden]), main select, main textarea, nav button, header button",
    )) {
      const r = el.getBoundingClientRect(),
        style = getComputedStyle(el);
      if (!r.width || !r.height || style.visibility === "hidden") continue;
      // WCAG 2.2 AA target size (24 × 24 CSS px); checkboxes/radios are measured with their label.
      if (
        (el as HTMLInputElement).type === "checkbox" ||
        (el as HTMLInputElement).type === "radio"
      ) {
        const label = el.closest("label")?.getBoundingClientRect();
        if (label && label.height >= 24) continue;
      }
      // A control squeezed into a letter-per-line column is unusable even if it is large.
      const label = (el.textContent || "").trim();
      if (
        el.tagName === "BUTTON" &&
        label.length > 3 &&
        r.height > 60 &&
        r.height > 3 * r.width
      )
        small.push(
          `squeezed button "${label.slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
      if (r.width < 24 || r.height < 24)
        small.push(
          `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
    }
    return {
      overflow,
      emDash: text.includes("—"),
      demo: /демо|demo/i.test(text),
      small,
    };
  });
  const violations = axe
    ? (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations.map((v) => `${v.id} (${v.nodes.length})`)
    : [];
  return {
    locale,
    width,
    section,
    overflow: layout.overflow,
    axe: violations,
    emDash: layout.emDash,
    demo: layout.demo,
    smallTargets: layout.small,
  };
}
test("T052: every section in KK (default) and RU on mobile and desktop widths", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await seed(page);
  await page.goto("/");
  // Kazakh is the default language for a new session.
  await expect(page.locator("html")).toHaveAttribute("lang", "kk");
  await expect(
    page.getByRole("button", { name: "ҚАЗ", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.getByRole("navigation").getByRole("button").count())
    .toBeGreaterThanOrEqual(15);
  const sections = await page
    .getByRole("navigation")
    .getByRole("button")
    .evaluateAll((els) =>
      els.map((e) => (e.textContent || "").trim()).filter(Boolean),
    );
  expect(sections.length).toBeGreaterThanOrEqual(15);
  const checks: Check[] = [];
  for (const locale of ["kk", "ru"]) {
    if (locale === "ru")
      await page.getByRole("button", { name: "РУС", exact: true }).click();
    const names = await page
      .getByRole("navigation")
      .getByRole("button")
      .evaluateAll((els) =>
        els.map((e) => (e.textContent || "").trim()).filter(Boolean),
      );
    for (const width of [...mobile, ...desktop]) {
      await page.setViewportSize({ width, height: width < 800 ? 800 : 1000 });
      for (const name of names) {
        // On mobile the navigation may be in a drawer: open it when the item is hidden.
        const item = page
          .getByRole("navigation")
          .getByRole("button", { name, exact: true });
        if (!(await item.isVisible())) {
          const menu = page.getByRole("button", { name: /^(Мәзір|Меню)$/ });
          if (await menu.isVisible()) await menu.click();
        }
        await item.click();
        await settle(page);
        checks.push(
          await inspect(
            page,
            locale,
            width,
            name,
            width === 360 || width === 1440,
          ),
        );
        if (locale === "kk" && width === 360)
          await page.screenshot({
            path: `docs/evidence/t052/${String(names.indexOf(name)).padStart(2, "0")}-kk-360.jpeg`,
            type: "jpeg",
            quality: 55,
          });
      }
    }
  }
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    `docs/evidence/t052-ui-pass.json`,
    JSON.stringify(
      {
        task: "T052",
        date: new Date().toISOString(),
        sections: sections.length,
        checks: checks.length,
        failures: checks.filter(
          (c) =>
            c.overflow > 1 ||
            c.axe.length ||
            c.emDash ||
            c.demo ||
            c.smallTargets.length,
        ),
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  const bad = checks.filter(
    (c) =>
      c.overflow > 1 ||
      c.axe.length ||
      c.emDash ||
      c.demo ||
      c.smallTargets.length,
  );
  expect(bad, JSON.stringify(bad.slice(0, 10), null, 1)).toEqual([]);
  expect(errors).toEqual([]);
});
test("T052: keyboard and visible focus, enlarged text, reduced motion and Kazakh glyphs", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seed(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  // Skip link first, then the controls in order; every focused control has a visible outline.
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.trim(),
    href: document.activeElement?.getAttribute("href"),
  }));
  expect(first.href, JSON.stringify(first)).toBe("#main-content");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement,
        s = getComputedStyle(el);
      return {
        tag: el.tagName,
        outline: s.outlineStyle,
        width: s.outlineWidth,
      };
    });
    expect(focus.tag).not.toBe("BODY");
    expect(focus.outline, JSON.stringify(focus)).not.toBe("none");
  }
  // A section opens from the keyboard alone.
  const orders = page
    .getByRole("navigation")
    .getByRole("button", { name: "Тапсырыстар", exact: true });
  await orders.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main h1")).toContainText("Тапсырыстар");
  // Enlarged text (user default font 32 px = 200 %): no horizontal page overflow at 360 px;
  // wide tables scroll inside their own region.
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  const names = await page
    .getByRole("navigation")
    .getByRole("button")
    .evaluateAll((els) =>
      els.map((e) => (e.textContent || "").trim()).filter(Boolean),
    );
  for (const name of names) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click();
    await expect(page.locator("main h1")).toBeVisible();
    const sizes = await page.evaluate(() => {
      const wide: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const r = el.getBoundingClientRect();
        if (
          r.right > window.innerWidth + 1 &&
          !el.closest(".table-scroll, [data-scroll], nav")
        )
          wide.push(
            `${el.tagName}.${(el.getAttribute("class") || "").slice(0, 30)} in ${(el.closest("[class]:not(svg):not(path)")?.getAttribute("class") || "").slice(0, 30)} ${Math.round(r.right)}`,
          );
      }
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        body: parseFloat(getComputedStyle(document.body).fontSize),
        wide: wide.slice(0, 8),
      };
    });
    expect(sizes.body).toBeGreaterThanOrEqual(27);
    expect(
      sizes.overflow,
      `${name} ${JSON.stringify(sizes.wide)}`,
    ).toBeLessThanOrEqual(1);
  }
  // Reduced motion: no running animations or transitions.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await page.evaluate(() => {
    const busy: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const s = getComputedStyle(el);
      if (s.animationName !== "none" && s.animationDuration !== "0s")
        busy.push(el.className.toString());
      if (s.transitionDuration.split(",").some((d) => parseFloat(d) > 0.01))
        busy.push(el.className.toString());
    }
    return busy;
  });
  expect(motion).toEqual([]);
  // Kazakh letters come from the application font in every weight used by the interface, not
  // from a fallback font (which would mix typefaces).
  const glyphs = await page.evaluate(async () => {
    const letters = "ӘҒҚҢӨҰҮҺІәғқңөұүһі";
    const out: {
      weight: number;
      loaded: boolean;
      differsFromFallback: boolean;
    }[] = [];
    for (const weight of [400, 500, 600, 700, 800]) {
      await document.fonts.load(`${weight} 32px "Noto Sans Variable"`, letters);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${weight} 32px "Noto Sans Variable", monospace`;
      const noto = ctx.measureText(letters).width;
      ctx.font = `${weight} 32px monospace`;
      const fallback = ctx.measureText(letters).width;
      out.push({
        weight,
        loaded: document.fonts.check(
          `${weight} 32px "Noto Sans Variable"`,
          letters,
        ),
        differsFromFallback: Math.abs(noto - fallback) > 1,
      });
    }
    const used = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, p, button, label, td, th, strong",
    ))
      used.add(
        getComputedStyle(el).fontFamily.split(",")[0].replace(/"/g, "").trim(),
      );
    return { out, used: [...used] };
  });
  for (const g of glyphs.out)
    expect(g, JSON.stringify(g)).toEqual({
      ...g,
      loaded: true,
      differsFromFallback: true,
    });
  expect(glyphs.used).toEqual(["Noto Sans Variable"]);
});
