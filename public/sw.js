// Quraşdırma üçün lazım olan sadə service worker.
// Heç nə keşləmir: hesabat datası və giriş həmişə serverdən gəlir.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request));
});
