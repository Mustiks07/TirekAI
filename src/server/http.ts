import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors";
import { getDatabase } from "./db/database";
import { Platform } from "./platform";
import { ImportService } from "./imports/service";
import { InventoryService } from "./inventory/service";
import { CommerceService } from "./commerce/service";
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
            path.length === 3 &&
            path[0] === "organizations" &&
            path[2] === "imports" &&
            method === "POST"
              ? 512 * 1024
              : 16384;
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
      if (
        path.length === 3 &&
        path[2] === "order-customers" &&
        method === "GET"
      )
        data = checked(
          customerOptions,
          await commerce.customers(secret, id, query),
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
