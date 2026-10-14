import { NextRequest } from "next/server";
import { handle } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function route(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return handle(request, (await context.params).path);
}
export { route as GET, route as POST, route as PATCH, route as DELETE };
