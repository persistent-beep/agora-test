const CACHE_NAME = 'agora-hub-v1'; // Или любая другая строка
const ASSETS =
  [
    './',
    './index.html',
    './script1.js',
    './style1.css',
    './logo.png',
    './manifest.json'
  ];

// 1. При установке кэшируем основные файлы (App Shell)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', (event) => {
  // Игнорируем не-GET запросы
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // 1. Если есть в кэше — отдаем сразу (самый быстрый путь)
      if (cachedResponse) {
        return cachedResponse;
      }

      // 2. Если нет в кэше, идем в сеть
      return fetch(event.request).then((networkResponse) => {
// Кэшируем новые ресурсы на лету (например, иконки)
                if (networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            });
        })
    );
});
