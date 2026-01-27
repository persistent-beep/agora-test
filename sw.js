const CACHE_NAME = 'agora-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style1.css',
  '/script1.js',
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Установка SW
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Кэширование ресурсов');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// Активация SW
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Удаление старого кэша:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Возвращаем из кэша или делаем сетевой запрос
        return response || fetch(event.request);
      })
      .catch(() => {
        // Для изображений возвращаем placeholder
        if (event.request.url.includes('.png')) {
          return caches.match('/logo.png');
        }
      })
  );
});

// Стратегия кэширования для динамических ресурсов
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const shouldCache = event.request.url.includes('logo.png') || 
                      event.request.url.includes('icon-');
  
  if (shouldCache) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return fetch(event.request).then((response) => {
          // Обновляем кэш в фоне
          cache.put(event.request, response.clone());
          return response;
        });
      })
    );
  }
});
