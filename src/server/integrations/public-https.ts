import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { request } from "node:https";
import { AppError } from "../../domain/errors";
import type { Fetch } from "./moysklad";

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(ip, bits, "ipv6");
export function publicAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  return !!family && !blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
}
// Resolve at socket creation and pass those exact addresses to the connection. A separate
// pre-flight lookup followed by ordinary fetch would allow DNS rebinding to a private host.
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true })
    .then((addresses) => {
      if (
        !addresses.length ||
        addresses.some((x) => !publicAddress(x.address))
      ) {
        callback(new Error("ONEC_HOST_NOT_ALLOWED"), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    })
    .catch(() => callback(new Error("ONEC_HOST_NOT_ALLOWED"), []));
};
export const publicHttps: Fetch = (input, init) =>
  new Promise((resolve, reject) => {
    const url = new URL(String(input));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (isIP(host) && !publicAddress(host))
    ) {
      reject(new AppError("ONEC_HOST_NOT_ALLOWED", 422));
      return;
    }
    const req = request(
      url,
      {
        method: "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        lookup: safeLookup,
        signal: init?.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            res.destroy(new Error("ONEC_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            reject(new AppError("ONEC_REDIRECT_REJECTED", 502));
            return;
          }
          resolve(new Response(Buffer.concat(chunks), { status }));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
