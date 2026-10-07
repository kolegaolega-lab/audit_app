/* ═══════════════════════════════════════════
   French Bakery Аудит — Service Worker
   v9.24.15 · shell + runtime + offline fallback
   ═══════════════════════════════════════════ */

'use strict';

const SW_VERSION = 'v87.59';
const CACHE_SHELL = 'fb-audit-' + SW_VERSION;
const CACHE_RUNTIME = 'fb-audit-runtime-' + SW_VERSION;
const CACHE_MAX_ENTRIES = 80;

/* Файлы оболочки — кэшируются при установке.
   Если файла нет — установка не упадёт. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './logo-180.png',
  './logo-192.png',
  './logo-512.png'
];

/* Внешние ресурсы — кэшируются после первого запроса */
const RUNTIME_HOSTS = new Set([
  'cdn.jsdelivr.net'
]);

/* Эти запросы — всегда только из сети */
function isNetworkOnly(url) {
  if (url.pathname.endsWith('/sync.json')) return true;
  if (url.hostname === 'api.github.com') return true;
  if (url.hostname === 'generativelanguage.googleapis.com') return true;
  return false;
}

/* ─────────── Install ─────────── */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_SHELL);
    await Promise.allSettled(
      SHELL_ASSETS.map(asset =>
        cache.add(new Request(asset, { cache: 'reload' }))
          .catch(err => console.warn('[SW] shell skip:', asset, err.message))
      )
    );
    /* Не активируемся автоматически.
       Ждём сообщения SKIP_WAITING от страницы. */
  })());
});

/* ─────────── Activate ─────────── */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    /* Удаляем старые кэши предыдущих версий */
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n !== CACHE_SHELL && n !== CACHE_RUNTIME)
        .map(n => caches.delete(n))
    );

    /* Отключаем navigation preload — конфликтует с network-first HTML */
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) {}
    }

    await self.clients.claim();
  })());
});

/* ─────────── Message ─────────── */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data === 'SKIP_WAITING' || data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', version: SW_VERSION });
  }
});

/* ─────────── Fetch ─────────── */
self.addEventListener('fetch', event => {
  const req = event.request;

  /* Только GET. POST (Gemini, GitHub PUT) — не трогаем. */
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* 1. sync.json и API — строго из сети */
  if (isNetworkOnly(url)) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503, statusText: 'offline' })));
    return;
  }

  /* 2. Навигация (HTML) — network-first с offline-fallback */
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  /* 3. Внешние CDN — stale-while-revalidate */
  if (RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_RUNTIME));
    return;
  }

  /* 4. Свои статические файлы — cache-first с фоновым обновлением */
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, CACHE_SHELL));
    return;
  }

  /* 5. Всё остальное — просто в сеть */
  event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
});

/* ─────────── Стратегии ─────────── */

async function networkFirstHTML(req) {
  const cache = await caches.open(CACHE_SHELL);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const fallback = await cache.match('./index.html') || await cache.match('./');
    if (fallback) return fallback;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Оффлайн</title>' +
      '<body style="font-family:system-ui;padding:2rem;text-align:center">' +
      '<h1>Нет соединения</h1><p>Откройте приложение позже.</p></body>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok && (fresh.type === 'basic' || fresh.type === 'default')) {
      cache.put(req, fresh.clone()).catch(() => {});
      trimCache(cacheName, CACHE_MAX_ENTRIES).catch(() => {});
    }
    return fresh;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req).then(res => {
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(() => {});
      trimCache(cacheName, CACHE_MAX_ENTRIES).catch(() => {});
    }
    return res;
  }).catch(() => null);

  return cached || (await fetchPromise) || new Response('', { status: 503 });
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(k => cache.delete(k)));
}
