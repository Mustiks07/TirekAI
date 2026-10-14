import { NextRequest, NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors";
import { getDatabase } from "./db/database";
import { Platform } from "./platform";
import { ImportService } from "./imports/service";
import { InventoryService } from "./inventory/service";
import { CommerceService } from "./commerce/service";
import { PurchasingService } from "./purchasing/service";
import { CrmService } from "./crm/service";
import { quotePdf } from "./crm/pdf";
import { dispatchExecution, uploadLimit } from "./routes/execution";
import {
  crmCustomers,
  inquiriesView,
  quotesView,
  quoteRow,
  crmHistory,
  pipelineInput,
} from "../domain/crm";
import {
  supplierList,
  comparison,
  purchaseList,
  purchaseDetail,
  documentList,
  documentView,
  needView,
  budgetView,
} from "../domain/purchasing";
import {
  ordersView,
  orderView,
  accountsView,
  ledgerView,
  obligationsView,
  financeSummary,
  customerOptions,
  commerceResult,
  commerceContract,
  calendarView,
} from "../domain/commerce";
import {
  catalogSchema,
  stockViewSchema,
  movementsViewSchema,
  reservationsViewSchema,
  transfersViewSchema,
  warehouseViewSchema,
  commandResult,
  inventoryContract,
  balanceSnapshot,
  entityResult,
} from "../domain/inventory";
import {
  batchViewSchema,
  batchesViewSchema,
  customersViewSchema,
  importApiContract,
} from "../domain/import-contracts";
import type { ZodType } from "zod";
function checked(schema: ZodType, data: unknown) {
  const result = schema.safeParse(JSON.parse(JSON.stringify(data)));
  if (!result.success) throw new AppError("RESPONSE_CONTRACT_ERROR", 500);
  return result.data;
}
const cookie = "smb_session";
const localPreview = () => process.env.LOCAL_PREVIEW === "1";
function origin() {
  const value = process.env.APP_ORIGIN;
  if (!value) throw new AppError("NOT_CONFIGURED", 503);
  return new URL(value).origin;
}
export async function handle(request: NextRequest, path: string[]) {
  const requestId = randomUUID();
  try {
    const method = request.method;
    if (
      localPreview() &&
      !["127.0.0.1", "localhost", "[::1]"].includes(request.nextUrl.hostname)
    )
      throw new AppError("FORBIDDEN", 403);
    if (method !== "GET" && request.headers.get("origin") !== origin())
      throw new AppError("INVALID_ORIGIN", 403);
    const secret = request.cookies.get(cookie)?.value || "";
    let body: unknown = {};
    if (["POST", "PATCH"].includes(method)) {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new AppError("INVALID_INPUT", 415);
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          const limit =
            (path[0] === "organizations" &&
              uploadLimit(method, path.slice(2))) ||
            (path.length === 3 &&
            path[0] === "organizations" &&
            path[2] === "imports" &&
            method === "POST"
              ? 512 * 1024
              : path.length === 3 &&
                  path[0] === "organizations" &&
                  path[2] === "purchase-documents" &&
                  method === "POST"
                ? 7_100_000
                : 16384);
          if (size > limit) {
            await reader.cancel();
            throw new AppError("TOO_LARGE", 413);
          }
          chunks.push(value);
        }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        throw new AppError("INVALID_INPUT", 400);
      }
    }
    const service = new Platform(await getDatabase());
    const imports = new ImportService(await getDatabase());
    const inventory = new InventoryService(await getDatabase());
    const commerce = new CommerceService(await getDatabase());
    const purchasing = new PurchasingService(await getDatabase());
    const crm = new CrmService(await getDatabase());
    const query = Object.fromEntries(request.nextUrl.searchParams);
    let data: unknown;
    let sessionToken: string | undefined;
    const route = path.join("/");
    if (method === "GET" && route === "contracts/commerce")
      data = commerceContract();
    else if (method === "GET" && route === "contracts/inventory")
      data = inventoryContract();
    else if (method === "GET" && route === "contracts/imports")
      data = importApiContract();
    else if (method === "GET" && route === "session")
      data = {
        ...(await service.session(secret)),
        localPreview: localPreview(),
      };
    else if (method === "POST" && route === "auth/register") {
      if (!localPreview()) throw new AppError("REGISTRATION_DISABLED", 503);
      const result = await service.register(body);
      data = result.user;
      sessionToken = result.token;
    } else if (method === "POST" && route === "auth/login") {
      const result = await service.login(body);
      data = result.user;
      sessionToken = result.token;
    } else if (method === "POST" && route === "auth/logout") {
      await service.logout(secret);
      data = { ok: true };
      sessionToken = "";
    } else if (method === "POST" && route === "organizations")
      data = await service.createOrganization(secret, body);
    else if (method === "POST" && route === "invitations/accept")
      data = await service.acceptInvitation(secret, body);
    else if (path[0] === "organizations" && path[1]) {
      const id = path[1];
      const execution = await dispatchExecution(method, path.slice(2), {
        db: await getDatabase(),
        secret,
        org: id,
        body,
        query,
      });
      if (execution.matched) data = execution.data;
      else if (
        path.length === 3 &&
        path[2] === "order-customers" &&
        method === "GET"
      )
        data = checked(
          customerOptions,
          await commerce.customers(secret, id, query),
        );
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "pipeline" &&
        method === "GET"
      )
        data = checked(pipelineInput, await crm.pipeline(secret, id));
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "pipeline" &&
        method === "POST"
      )
        data = await crm.savePipeline(secret, id, body);
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "customers" &&
        method === "GET"
      )
        data = checked(crmCustomers, await crm.customers(secret, id, query));
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "customers" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await crm.createCustomer(secret, id, body),
        );
      else if (
        path.length === 5 &&
        path[2] === "crm" &&
        path[3] === "customers" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await crm.profile(secret, id, path[4], body),
        );
      else if (
        path.length === 6 &&
        path[2] === "crm" &&
        path[3] === "customers" &&
        path[5] === "history" &&
        method === "GET"
      )
        data = checked(
          crmHistory,
          await crm.history(secret, id, path[4], query),
        );
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "inquiries" &&
        method === "GET"
      )
        data = checked(inquiriesView, await crm.inquiries(secret, id, query));
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "inquiries" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await crm.createInquiry(secret, id, body),
        );
      else if (
        path.length === 5 &&
        path[2] === "crm" &&
        path[3] === "inquiries" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await crm.transition(secret, id, path[4], body),
        );
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "quotes" &&
        method === "GET"
      )
        data = checked(quotesView, await crm.quotes(secret, id, query));
      else if (
        path.length === 4 &&
        path[2] === "crm" &&
        path[3] === "quotes" &&
        method === "POST"
      )
        data = checked(commerceResult, await crm.saveQuote(secret, id, body));
      else if (
        path.length === 5 &&
        path[2] === "crm" &&
        path[3] === "quotes" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await crm.saveQuote(secret, id, body, path[4]),
        );
      else if (
        path.length === 5 &&
        path[2] === "crm" &&
        path[3] === "quotes" &&
        method === "GET"
      )
        data = checked(quoteRow, await crm.quote(secret, id, path[4]));
      else if (
        path.length === 6 &&
        path[2] === "crm" &&
        path[3] === "quotes" &&
        path[5] === "convert" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await crm.convert(secret, id, path[4], body),
        );
      else if (
        path.length === 6 &&
        path[2] === "crm" &&
        path[3] === "quotes" &&
        path[5] === "pdf" &&
        method === "GET"
      ) {
        const q = quoteRow.parse(
          JSON.parse(JSON.stringify(await crm.quote(secret, id, path[4]))),
        );
        const locale = z.enum(["ru", "kk"]).default("ru").parse(query.locale),
          buffer = await quotePdf(q, locale);
        return new NextResponse(new Uint8Array(buffer), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="quote-${q.number}-v${q.version}-${locale}.pdf"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } else if (
        path.length === 3 &&
        path[2] === "suppliers" &&
        method === "GET"
      )
        data = checked(
          supplierList,
          await purchasing.suppliers(secret, id, query),
        );
      else if (
        path.length === 3 &&
        path[2] === "suppliers" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.createSupplier(secret, id, body),
        );
      else if (
        path.length === 3 &&
        path[2] === "supplier-offers" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.createOffer(secret, id, body),
        );
      else if (
        path.length === 4 &&
        path[2] === "purchasing" &&
        path[3] === "compare" &&
        method === "POST"
      )
        data = checked(comparison, await purchasing.compare(secret, id, body));
      else if (
        path.length === 4 &&
        path[2] === "purchasing" &&
        path[3] === "need" &&
        method === "POST"
      )
        data = checked(needView, await purchasing.need(secret, id, body));
      else if (
        path.length === 4 &&
        path[2] === "purchasing" &&
        path[3] === "budget" &&
        method === "POST"
      )
        data = checked(budgetView, await purchasing.budget(secret, id, body));
      else if (path.length === 3 && path[2] === "purchases" && method === "GET")
        data = checked(purchaseList, await purchasing.list(secret, id, query));
      else if (
        path.length === 3 &&
        path[2] === "purchases" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.create(secret, id, body),
        );
      else if (path.length === 4 && path[2] === "purchases" && method === "GET")
        data = checked(
          purchaseDetail,
          await purchasing.get(secret, id, path[3], query),
        );
      else if (
        path.length === 5 &&
        path[2] === "purchases" &&
        path[4] === "commands" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.transition(secret, id, path[3], body),
        );
      else if (
        path.length === 5 &&
        path[2] === "purchases" &&
        path[4] === "receipts" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.receive(secret, id, path[3], body),
        );
      else if (
        path.length === 3 &&
        path[2] === "purchase-documents" &&
        method === "GET"
      )
        data = checked(
          documentList,
          await purchasing.documents(secret, id, query),
        );
      else if (
        path.length === 3 &&
        path[2] === "purchase-documents" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.upload(secret, id, body),
        );
      else if (
        path.length === 4 &&
        path[2] === "purchase-documents" &&
        method === "GET"
      )
        data = checked(
          documentView,
          await purchasing.document(secret, id, path[3]),
        );
      else if (
        path.length === 5 &&
        path[2] === "purchase-documents" &&
        path[4] === "original" &&
        method === "GET"
      )
        data = checked(
          z.object({ filename: z.string(), content: z.string() }),
          await purchasing.document(secret, id, path[3], true),
        );
      else if (
        path.length === 5 &&
        path[2] === "purchase-documents" &&
        ["review", "review-draft", "review-preview"].includes(path[4]) &&
        method === "POST"
      )
        data = checked(
          path[4] === "review-preview"
            ? z.object({
                id: z.uuid(),
                reused: z.boolean(),
                total_minor: z.string(),
                payable_minor: z.string(),
                discrepancies: z.array(z.string()),
              })
            : commerceResult,
          await purchasing.review(
            secret,
            id,
            path[3],
            body,
            path[4] === "review-preview"
              ? "preview"
              : path[4] === "review-draft"
                ? "draft"
                : "approve",
          ),
        );
      else if (
        path.length === 5 &&
        path[2] === "purchase-documents" &&
        path[4] === "adjustments" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await purchasing.adjust(secret, id, path[3], body),
        );
      else if (path.length === 3 && path[2] === "orders" && method === "GET")
        data = checked(ordersView, await commerce.list(secret, id, query));
      else if (path.length === 3 && path[2] === "orders" && method === "POST")
        data = checked(commerceResult, await commerce.create(secret, id, body));
      else if (path.length === 4 && path[2] === "orders" && method === "GET")
        data = checked(
          orderView,
          await commerce.get(secret, id, path[3], query),
        );
      else if (
        path.length === 5 &&
        path[2] === "orders" &&
        path[4] === "commands" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await commerce.transition(secret, id, path[3], body),
        );
      else if (
        path.length === 4 &&
        path[2] === "finance" &&
        method === "GET" &&
        ["accounts", "ledger", "obligations", "summary", "calendar"].includes(
          path[3],
        )
      ) {
        const section = path[3] as
          "accounts" | "ledger" | "obligations" | "summary" | "calendar";
        const schemas = {
          accounts: accountsView,
          ledger: ledgerView,
          obligations: obligationsView,
          summary: financeSummary,
          calendar: calendarView,
        };
        data = checked(
          schemas[section],
          await commerce[section](secret, id, query),
        );
      } else if (
        path.length === 4 &&
        path[2] === "finance" &&
        path[3] === "accounts" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await commerce.createAccount(secret, id, body),
        );
      else if (
        path.length === 4 &&
        path[2] === "finance" &&
        path[3] === "obligations" &&
        method === "POST"
      )
        data = checked(
          commerceResult,
          await commerce.createObligation(secret, id, body),
        );
      else if (
        path.length === 4 &&
        path[2] === "finance" &&
        path[3] === "commands" &&
        method === "POST"
      )
        data = checked(commerceResult, await commerce.money(secret, id, body));
      else if (path.length === 3 && path[2] === "catalog" && method === "GET")
        data = checked(
          catalogSchema,
          await inventory.catalog(secret, id, query),
        );
      else if (path.length === 3 && path[2] === "catalog" && method === "POST")
        data = checked(
          entityResult,
          await inventory.saveItem(secret, id, body),
        );
      else if (path.length === 4 && path[2] === "catalog" && method === "PATCH")
        data = checked(
          entityResult,
          await inventory.saveItem(secret, id, body, path[3]),
        );
      else if (
        path.length === 3 &&
        path[2] === "warehouses" &&
        method === "GET"
      )
        data = checked(
          warehouseViewSchema,
          await inventory.warehouses(secret, id, query),
        );
      else if (
        path.length === 3 &&
        path[2] === "warehouses" &&
        method === "POST"
      )
        data = checked(
          entityResult,
          await inventory.createWarehouse(secret, id, body),
        );
      else if (
        path.length === 3 &&
        path[2] === "stock-commands" &&
        method === "POST"
      )
        data = checked(
          commandResult,
          await inventory.execute(secret, id, body),
        );
      else if (
        path.length === 4 &&
        path[2] === "inventory" &&
        path[3] === "balance" &&
        method === "GET"
      )
        data = checked(
          balanceSnapshot,
          await inventory.snapshot(secret, id, query),
        );
      else if (
        path.length === 4 &&
        path[2] === "inventory" &&
        method === "GET" &&
        ["balances", "movements", "reservations", "transfers"].includes(path[3])
      ) {
        const section = path[3] as
          "balances" | "movements" | "reservations" | "transfers";
        const schemas = {
          balances: stockViewSchema,
          movements: movementsViewSchema,
          reservations: reservationsViewSchema,
          transfers: transfersViewSchema,
        };
        data = checked(
          schemas[section],
          await inventory.view(secret, id, section, query),
        );
      } else if (
        path.length === 3 &&
        path[2] === "imports" &&
        method === "POST"
      )
        data = checked(batchViewSchema, await imports.upload(secret, id, body));
      else if (path.length === 3 && path[2] === "imports" && method === "GET")
        data = checked(
          batchesViewSchema,
          await imports.list(secret, id, query),
        );
      else if (path.length === 4 && path[2] === "imports" && method === "GET")
        data = checked(
          batchViewSchema,
          await imports.get(secret, id, path[3], query),
        );
      else if (
        path.length === 5 &&
        path[2] === "imports" &&
        path[4] === "confirm" &&
        method === "POST"
      )
        data = checked(
          batchViewSchema,
          await imports.confirm(secret, id, path[3], body),
        );
      else if (
        path.length === 5 &&
        path[2] === "imports" &&
        path[4] === "retry" &&
        method === "POST"
      )
        data = checked(
          batchViewSchema,
          await imports.retry(secret, id, path[3], body),
        );
      else if (path.length === 3 && path[2] === "customers" && method === "GET")
        data = checked(
          customersViewSchema,
          await imports.customers(secret, id, query),
        );
      else if (
        path.length === 4 &&
        path[2] === "customers" &&
        method === "PATCH"
      )
        data = await imports.updateCustomer(secret, id, path[3], body);
      else if (path.length === 2 && method === "GET")
        data = await service.workspace(secret, id);
      else if (path.length === 2 && method === "PATCH") {
        await service.updateOrganization(secret, id, body);
        data = { ok: true };
      } else if (
        path.length === 3 &&
        path[2] === "branches" &&
        method === "POST"
      )
        data = await service.createBranch(secret, id, body);
      else if (
        path.length === 3 &&
        path[2] === "invitations" &&
        method === "POST"
      )
        data = await service.invite(secret, id, body);
      else if (
        path.length === 4 &&
        path[2] === "invitations" &&
        method === "DELETE"
      ) {
        await service.revokeInvitation(secret, id, path[3]);
        data = { ok: true };
      } else if (
        path.length === 4 &&
        path[2] === "members" &&
        method === "DELETE"
      ) {
        await service.removeMember(secret, id, path[3]);
        data = { ok: true };
      } else throw new AppError("NOT_FOUND", 404);
    } else throw new AppError("NOT_FOUND", 404);
    const response = NextResponse.json(
      { data, requestId },
      { headers: { "Cache-Control": "no-store" } },
    );
    if (sessionToken !== undefined)
      response.cookies.set(cookie, sessionToken, {
        httpOnly: true,
        secure: origin().startsWith("https:"),
        sameSite: "lax",
        path: "/",
        maxAge: sessionToken ? 12 * 3600 : 0,
      });
    return response;
  } catch (error) {
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof ZodError
          ? 400
          : 500;
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof ZodError
          ? "INVALID_INPUT"
          : "INTERNAL_ERROR";
    // No bodies, secrets, database URLs, or raw SQL errors in application logs.
    if (status === 500) console.error(JSON.stringify({ requestId, code }));
    return NextResponse.json(
      { error: { code, requestId } },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
