// Minimal service worker. Its main job is just existing — a fetch handler
// is what makes Chrome/Android treat this as an installable PWA. It also
// caches the app shell so the page itself still opens if you're offline;
// live data (kits/items) always requires network, since that talks to
// Supabase/Netlify functions and isn't cached here.
const CACHE_NAME = 'cyt-inventory-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API/function calls or Supabase requests — those must always
  // hit the network so inventory data stays live.
  if (url.pathname.startsWith('/.netlify/functions/') || url.hostname.includes('supabase')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
