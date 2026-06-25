// DalziTravel Service Worker v2.2.0
// Supporto offline completo: itinerari salvati in cache dinamica

const STATIC_CACHE   = "dalzitravel-static-v2.2.0";
const DYNAMIC_CACHE  = "dalzitravel-dynamic-v2.2.0";
const ITIN_CACHE     = "dalzitravel-itinerari-v2.2.0"; // itinerari offline

const STATIC_ASSETS = [
  "/", "/index.html", "/manifest.json", "/css/styles.css",
  "/icons/icon-192x192.png", "/icons/icon-512x512.png",
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch((e) => console.warn("[SW] Pre-cache parziale:", e))
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => ![STATIC_CACHE, DYNAMIC_CACHE, ITIN_CACHE].includes(k))
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!request.url.startsWith("http")) return;
  const url = new URL(request.url);

  // Unpkg/CDN (Leaflet ecc.) → CDN bypass
  if (url.hostname.includes("unpkg.com") ||
      url.hostname.includes("fonts.googleapis.com") ||
      url.hostname.includes("fonts.gstatic.com")) return;

  // Tile OSM → cache con stale-while-revalidate
  if (url.hostname.includes("tile.openstreetmap.org")) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // API di lettura chat (/api/chats/:id) → Network first con fallback cache
  if (url.pathname.startsWith("/api/chats/") && request.method === "GET") {
    event.respondWith(networkFirstWithCache(request, ITIN_CACHE));
    return;
  }

  // Tutte le altre API (POST, auth, ecc.) → Network Only
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Share pubblico → Network First (pagina condivisa deve essere aggiornata)
  if (url.pathname.startsWith("/share/")) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Asset locali → Cache First
  event.respondWith(cacheFirst(request));
});

// ─── Strategie ────────────────────────────────────────────────────────────────
async function networkOnly(request) {
  try { return await fetch(request); }
  catch {
    return new Response(JSON.stringify({ error: "Offline." }),
      { status: 503, headers: { "Content-Type": "application/json" }});
  }
}

async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
    const net = await fetch(request);
    if (net?.ok) (await caches.open(STATIC_CACHE)).put(request, net.clone());
    return net;
  } catch {
    const fallback = await caches.match("/index.html");
    return fallback || new Response("DalziTravel — Offline",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" }});
  }
}

async function networkFirst(request) {
  try {
    const net = await fetch(request);
    if (net?.ok) (await caches.open(DYNAMIC_CACHE)).put(request, net.clone());
    return net;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: "Offline." }),
      { status: 503, headers: { "Content-Type": "application/json" }});
  }
}

// Network first per chat, con cache dedicata agli itinerari
async function networkFirstWithCache(request, cacheName) {
  try {
    const net = await fetch(request);
    if (net?.ok) (await caches.open(cacheName)).put(request, net.clone());
    return net;
  } catch {
    const cached = await caches.match(request, { cacheName });
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "Offline: chat non disponibile." }),
      { status: 503, headers: { "Content-Type": "application/json" }});
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((net) => {
    if (net?.ok) cache.put(request, net.clone());
    return net;
  }).catch(() => cached);
  return cached || fetchPromise;
}

// ─── Messaggi dal client ──────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "GET_VERSION")
    event.ports[0]?.postMessage({ version: STATIC_CACHE });

  // Salva itinerario offline esplicitamente dal client
  if (event.data?.type === "CACHE_ITINERARY") {
    const { url, data } = event.data;
    caches.open(ITIN_CACHE).then((c) =>
      c.put(url, new Response(JSON.stringify(data),
        { headers: { "Content-Type": "application/json" }}))
    );
  }
});
