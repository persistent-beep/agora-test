const CACHE_NAME = 'agora-hub-v1'; // Или любая другая строка
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
        // Если это логотип или иконка, сохраняем в кэш на лету
        const isImage = event.request.url.includes('logo.png') || event.request.url.includes('icon-');
        
        if (isImage && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 3. Фолбэк, если сети нет и в кэше пусто
        if (event.request.url.includes('.png')) {
          return caches.match('/logo.png');
        }
      });
    })
  );
});
