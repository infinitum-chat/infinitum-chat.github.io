/* Infinitum service worker: offline-start, cache en pushmeldingen (werkt ook als de app dicht is) */
const VERSION = 'infinitum-v0.20';
const SHELL = [
  './', 'index.html', 'upgrade.html', 'styles.css?v=0.20',
  'js/app.js?v=0.20', 'js/firebase.js?v=0.20', 'js/legal.js?v=0.20', 'js/streakr.js?v=0.20', 'js/call.js?v=0.20', 'js/voice.js?v=0.20', 'js/emoji.js?v=0.20', 'js/emoji-data.js?v=0.20', 'js/upgrade.js?v=8',
  'manifest.webmanifest',
  'assets/favicon.svg', 'assets/favicon-plus.svg', 'assets/favicon-prime.svg',
  'assets/streakr-flame.svg', 'assets/infinitum-logo.svg', 'assets/infinitum-logo-plus.svg', 'assets/infinitum-logo-prime.svg', 'assets/logo-dark.svg',
  'assets/hero-background.svg', 'assets/bg-aurora.svg', 'assets/bg-sunset.svg', 'assets/bg-ocean.svg',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const CDN = /^https:\/\/(www\.gstatic\.com\/firebasejs|fonts\.(googleapis|gstatic)\.com)\//;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !CDN.test(req.url)) return;          // Firestore/Auth e.d. gaan nooit via de cache

  // eigen bestanden (pagina's, js, css): eerst netwerk, zodat updates direct binnenkomen; offline val je terug op de cache
  if (same) {
    e.respondWith(
      fetch(req).then((res) => { if (res.ok) { const c = res.clone(); caches.open(VERSION).then((ch) => ch.put(req, c)); } return res; })
        .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
    );
    return;
  }
  // externe bibliotheken en lettertypen: uit de cache en op de achtergrond verversen
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') { const c = res.clone(); caches.open(VERSION).then((ch) => ch.put(req, c)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* ---------- pushmeldingen ---------- */
// De Cloud Function stuurt "data-only" berichten: { title, body, tag, open } waarna wij de melding zelf tonen.
self.addEventListener('push', (e) => {
  let p = {};
  try { const j = e.data ? e.data.json() : {}; p = j.data || j; } catch { p = { body: e.data ? e.data.text() : '' }; }
  const title = p.title || 'Infinitum';

  e.waitUntil((async () => {
    // Staat de app open en in beeld? Dan toont de app zelf al een melding; dubbel is irritant.
    // Uitzondering: iOS (Apple) trekt pushrechten in als een push geen zichtbare melding oplevert, dus daar tonen we altijd.
    const sub = await self.registration.pushManager.getSubscription().catch(() => null);
    const apple = /push\.apple\.com/.test((sub && sub.endpoint) || '');
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!apple && !p.force && list.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    const call = p.tag === 'infinitum-call';   // v0.19: inkomende oproep: blijft staan, met trilling
    await self.registration.showNotification(title, {
      body: p.body || '',
      icon: 'assets/icons/icon-192.png',
      badge: 'assets/icons/badge-96.png',
      data: { open: p.open || '' },
      ...(call ? { tag: 'infinitum-call', renotify: true, requireInteraction: true, vibrate: [300, 150, 300, 150, 300] } : {})
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = (e.notification.data && e.notification.data.open) || '';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) {
        await c.focus();
        c.postMessage({ type: 'open', open });
        return;
      }
    }
    await self.clients.openWindow('./' + (open ? '?open=' + encodeURIComponent(open) : ''));
  })());
});
