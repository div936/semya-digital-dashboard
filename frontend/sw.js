// ── Semya Digital PWA Service Worker ────────────────────────────────────────
// Strategy:
//   • App shell (HTML, JS, CSS, icons) → Cache-first (fast loads, works offline)
//   • API calls to the backend (Render/Supabase) → Network-first (always fresh data)
//   • If network fails for API → serve a friendly offline fallback
//
// Version this string whenever you deploy a new build so the old cache is
// cleared automatically on next load.
const CACHE_NAME = 'semya-v1';

// Files to pre-cache on install — the app shell
const SHELL_FILES = [
  '/semya-digital-dashboard/dashboard.html',
  '/semya-digital-dashboard/index.html',
  '/semya-digital-dashboard/semya_auth_guard.js',
  '/semya-digital-dashboard/assets/semya-logo.jpg',
  '/semya-digital-dashboard/manifest.json',
];

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching app shell');
      // Use individual adds so one failing asset doesn't block everything
      return Promise.allSettled(
        SHELL_FILES.map(url => cache.add(url).catch(err =>
          console.warn('[SW] Could not cache:', url, err)
        ))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for shell ─────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (POST/PUT/DELETE — file uploads, data writes)
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http requests
  if (!url.protocol.startsWith('http')) return;

  // API calls → network-first, no caching
  const isApiCall = (
    url.hostname.includes('onrender.com') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('supabase.com') ||
    url.hostname.includes('anthropic.com')
  );

  if (isApiCall) {
    // Network-first: always try the network, no cache for API responses
    event.respondWith(
      fetch(event.request).catch(() => {
        // Network failed — return a JSON error response
        return new Response(
          JSON.stringify({ error: 'You are offline. Please check your connection.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // CDN resources (Supabase JS, Chart.js etc.) → network-first with cache fallback
  const isCdn = (
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('unpkg.com')
  );

  if (isCdn) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell → cache-first: serve from cache, update cache in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Serve cached version immediately, refresh cache in background
        fetch(event.request).then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response));
          }
        }).catch(() => {});
        return cached;
      }
      // Not in cache — fetch from network and cache it
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Push notifications (future use) ─────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Semya Dashboard', {
      body: data.body || '',
      icon: '/semya-digital-dashboard/assets/semya-logo.jpg',
      badge: '/semya-digital-dashboard/assets/semya-logo.jpg',
      data: data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/semya-digital-dashboard/dashboard.html')
  );
});
