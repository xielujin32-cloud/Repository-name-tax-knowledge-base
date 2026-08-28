const SHELL_CACHE = 'taxkb-shell-v2';
const SHELL = ['/', '/knowledge.html', '/knowledge.css', '/knowledge.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/knowledge/')) return; // Policy content always comes from the server.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
