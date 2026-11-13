// Service worker: permite instalar la app y abrirla sin conexión.
// Siempre intenta la versión más nueva primero, así cada actualización llega sola.
const CACHE = "tuna-utal-v1";
const SHELL = ["./", "./index.html", "./logo.png", "./manifest.webmanifest", "./firebase-config.js", "./canciones.json",
  "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

// Notificaciones al celular: llegan aunque la app esté cerrada.
self.addEventListener("push", e => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = j.data || j.notification || j; }
  catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Tuna UTAL", {
    body: d.body || "Hay novedades en la app.",
    icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: d.tag || undefined, data: { abrir: d.abrir || "" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const abrir = (e.notification.data && e.notification.data.abrir) || "";
  const url = new URL(abrir ? "./?abrir=" + encodeURIComponent(abrir) : "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) {
      if (c.url.startsWith(self.registration.scope)) { if (abrir) c.postMessage({ abrir }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
