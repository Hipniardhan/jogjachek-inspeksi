const CACHE_NAME = 'rtech-inspection-v23';
const IS_LOCALHOST =
    ['localhost', '127.0.0.1', '::1'].includes(self.location.hostname);

const APP_ASSETS = [
    './',
    './index.html',
    './css/app.css',
    './js/app.js',
    './manifest.webmanifest',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/inspection/pdf-image-8.jpg',
    './assets/inspection/pdf-image-10.jpg',
    './assets/inspection/pdf-image-11.jpg',
    './assets/inspection/pdf-image-12.jpg',
    './assets/inspection/pdf-image-23.jpg',
    './assets/inspection/pdf-image-30.jpg',
    './assets/inspection/pdf-image-31.jpg',
    './assets/inspection/pdf-image-37.jpg',
    './assets/inspection/pdf-image-38.jpg',
    './assets/inspection/pdf-image-39.jpg',
    './assets/inspection/pdf-image-40.jpg',
    './assets/inspection/red-circle.svg',
    './assets/inspection/rtech-logo-pdf.png',
    './assets/inspection/signature-tama.svg'
];

self.addEventListener('install', (event) => {
    if (IS_LOCALHOST) {
        self.skipWaiting();
        return;
    }

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_ASSETS))
    );

    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((cacheName) => cacheName !== CACHE_NAME)
                    .map((cacheName) => caches.delete(cacheName))
            );
        })
    );

    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }

    if (IS_LOCALHOST) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (
                    !networkResponse ||
                    networkResponse.status !== 200 ||
                    networkResponse.type === 'opaque'
                ) {
                    return networkResponse;
                }

                const responseClone = networkResponse.clone();

                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseClone);
                });

                return networkResponse;
            }).catch(() => {
                if (event.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }

                return caches.match(event.request);
            });
        })
    );
});
