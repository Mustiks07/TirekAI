import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors";
import { getDatabase } from "./db/database";
import { Platform } from "./platform";
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
          if (size > 16384) {
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
    let data: unknown;
    let sessionToken: string | undefined;
    const route = path.join("/");
    if (method === "GET" && route === "session")
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
      if (path.length === 2 && method === "GET")
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
