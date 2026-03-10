'use strict';

const CACHE = 'texas-holdem-v2';

// App shell: files to pre-cache on install
const PRECACHE = [
  '/',
  '/socket.io/socket.io.js',
  '/icon.svg',
  '/icon-maskable.svg',
  '/manifest.json',
  // Sound effects
  '/sounds/card-slide-1.ogg',
  '/sounds/card-shove-1.ogg',
  '/sounds/card-place-1.ogg',
  '/sounds/chip-lay-3.ogg',
  '/sounds/raise.mp3',
  '/sounds/allin.mp3',
  '/sounds/win.mp3',
];

// ── Install: pre-cache app shell ─────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first, cache fallback ─────────────────
// Multiplayer game needs live server; cache only provides offline shell.
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip socket.io transport requests (polling/websocket) — always network
  if (url.pathname.startsWith('/socket.io/') && url.search.length > 0) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Update cache with fresh response
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache (offline fallback)
        return caches.match(event.request)
          .then(cached => cached || new Response('离线模式：请连接网络后刷新', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          }));
      })
  );
});
