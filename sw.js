// GitHub Pagesのサブパスでも動作する相対パス構成
const CACHE_NAME = "flow-timer-static-v2";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith("flow-timer-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // ページ本体はオンライン時に最新を優先し、オフライン時は保存済みを利用
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      }).catch(async () => {
        return (await caches.match(request)) || (await caches.match("./index.html")) || Response.error();
      })
    );
    return;
  }

  // 静的リソースもオンラインでは最新を取得してキャッシュを更新
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error())
  );
});
