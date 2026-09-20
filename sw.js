'use strict';

const CACHE_NAME = 'fb-audit-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './logo-180.png',
  './logo-192.png',
  './logo-512.png',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

// Установка — кэшируем ресурсы
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(
        ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('SW cache skip:', url, err.message))
        )
      );
    })
  );
  self.skipWaiting();
});

// Активация — чистим старые кэши
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Перехват запросов
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Не кэшируем запросы к GitHub API
  if (url.hostname === 'api.github.com') return;

  // Не кэшируем не-GET
  if (e.request.method !== 'GET') return;

  // Только same-origin и CDN xlsx
  const isSameOrigin = url.origin === self.location.origin;
  const isXlsxCDN = url.href.includes('cdn.jsdelivr.net');
  if (!isSameOrigin && !isXlsxCDN) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Кэшируем только успешные ответы
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        // Офлайн — возвращаем index.html для навигации
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
