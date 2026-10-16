/* Only public offline assets are cached. Business pages, APIs and mutations
   always use the network; no background sync or offline command replay. */
const CACHE = "tirekai-public-v2";
const ASSETS = [
  "/offline.html",
  "/icons/app-192.png",
  "/icons/app-512.png",
  "/icons/app-maskable.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (
          (key.startsWith("basqaru-public-") ||
            key.startsWith("tirekai-public-")) &&
          key !== CACHE
        )
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && !url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).catch(async () =>
        (await caches.open(CACHE)).match("/offline.html"),
      ),
    );
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      (async () =>
        (await caches.open(CACHE)).match(url.pathname) || fetch(request))(),
    );
  }
});
