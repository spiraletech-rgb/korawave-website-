'use strict';

// ── Cache versionné ──────────────────────────────────────────────────────────
// Bumper CACHE à chaque déploiement où l'on veut invalider les vieux assets.
const CACHE = 'kw-cache-v8';

// Assets essentiels pré-cachés (coquille de l'app). Les JS/CSS/images versionnés
// sont mis en cache à la volée (stale-while-revalidate) — pas besoin de les lister ici.
const SHELL = ['/', '/index.html', '/img/logo.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Domaines à NE JAMAIS mettre en cache (API dynamique + flux audio/vidéo lourds).
function neverCache(url) {
  return (
    url.pathname.startsWith('/api/') ||
    /\/(stream|preview)(\/|$)/.test(url.pathname) || // flux + aperçus média
    url.hostname.includes('onrender.com')
  );
}

// Images Cloudinary (pochettes, posters) : cacheables et légères.
function isCacheableImage(url) {
  return (
    url.hostname.includes('res.cloudinary.com') &&
    (url.pathname.includes('/image/') || /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(url.pathname))
  ) || /\/poster(\/|$)/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 1) API + flux média : réseau direct, jamais de cache.
  if (neverCache(url)) return;

  // 2) Navigations (HTML) : network-first → toujours du HTML frais (donc la bonne
  //    version des assets ?v=N). Repli cache si hors-ligne.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => { caches.open(CACHE).then((c) => c.put('/index.html', resp.clone())); return resp; })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isStatic = sameOrigin && /\.(js|css|woff2?|ttf|svg|png|jpg|jpeg|webp|ico|gif)$/i.test(url.pathname);
  const isFont = url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com');

  // 3) Assets statiques + polices + images Cloudinary : stale-while-revalidate.
  if (isStatic || isFont || isCacheableImage(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((resp) => { if (resp && resp.status === 200) cache.put(req, resp.clone()); return resp; })
          .catch(() => cached);
        return cached || network; // instantané si en cache, sinon réseau
      }),
    );
  }
  // Sinon : comportement par défaut (réseau).
});

// ── Notifications push (inchangé) ────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'KORAWAVE', {
      body: data.body || '',
      icon: '/img/logo.png',
      badge: '/img/logo.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(event.notification.data?.url || '/');
    }),
  );
});
