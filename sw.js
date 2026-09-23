'use strict';

const CACHE_NAME = 'fb-audit-v57';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './logo-180.png',
  './logo-192.png',
  './logo-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(
      ASSETS.map(url =>
        cache.add(url).catch(err => console.warn('SW cache skip:', url, err.message))
      )
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.hostname === 'api.github.com') return;

  if (url.pathname.endsWith('/sync.json')) return;

  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return;

  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const clone = fresh.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          caches.open(CACHE_NAME).then(c => c.put(req, res.clone()));
        }
      }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
      }
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
