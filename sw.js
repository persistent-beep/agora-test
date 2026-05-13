const CACHE_NAME = "agora-hub-v32";
const ASSETS = [
  "./",
  "./index.html",
  "./script1.js",
  "./style1.css",
  "./logo.png",
  "./manifest.json",
];
const options = {
  body: payload.body,
  icon: "./icons/icon-192.png",
  badge: "./icons/icon-192.png",
  vibrate: [200, 100, 200, 100, 200, 100, 200],
  requireInteraction: true,
  silent: false, // ← важно
  sound: "default", // ← системный звук уведомления
  data: { caller: payload.caller },
  actions: [
    { action: "answer", title: "🟢 Принять" },
    { action: "decline", title: "🔴 Отклонить" },
  ],
};
// 1. При установке кэшируем основные файлы (App Shell)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }),
  );
  self.skipWaiting();
});
// удаление старых кешей
self.addEventListener("activate", (event) => {
  const cacheWhitelist = [CACHE_NAME];

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Если имя кеша не совпадает с текущим (например, agora-hub-v2), удаляем его
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log("[SW] Удаляем старый кеш:", cacheName);
            return caches.delete(cacheName);
          }
        }),
      );
    }),
  );
  // Немедленно контролировать все открытые страницы
  return self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Игнорируем не-GET запросы
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // 1. Если есть в кэше — отдаем сразу (самый быстрый путь)
      if (cachedResponse) {
        return cachedResponse;
      }

      // 2. Если нет в кеше, идем в сеть
      return fetch(event.request).then((networkResponse) => {
        // Кэшируем новые ресурсы на лету
        // Проверяем, что ответ валидный
        if (
          !networkResponse || networkResponse.status !== 200 ||
          networkResponse.type !== "basic"
        ) {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    }),
  );
});
// Ловим Push от сервера
self.addEventListener("push", function (event) {
  if (!event.data) return;

  const payload = event.data.json();

  if (payload.type === "INCOMING_CALL") {
    const options = {
      body: payload.body,
      icon: "./icons/icon-192.png", // Ваша иконка
      badge: "./icons/icon-192.png",
      vibrate: [200, 100, 200, 100, 200, 100, 200], // Имитация звонка
      requireInteraction: true, // Уведомление висит и не исчезает само
      data: { caller: payload.caller },
      actions: [
        { action: "answer", title: "🟢 Принять" },
        { action: "decline", title: "🔴 Отклонить" },
      ],
    };

    event.waitUntil(
      self.registration.showNotification(payload.title, options),
    );
  }
});

// Ловим клик по уведомлению (или по кнопкам Принять/Отклонить)
self.addEventListener("notificationclick", function (event) {
  event.notification.close(); // Закрываем пуш

  const action = event.action;
  const caller = event.notification.data.caller;

  // Если нажали "Отклонить" — просто тихо гасим
  if (action === "decline") return;

  // ИСПРАВЛЕНИЕ 1: Используем self.location.origin для формирования базового URL.
  // Это надежнее, чем self.registration.scope, который может быть путем вроде /app/,
  // и тогда результирующий URL будет /app/?call=..., что может сломать роутинг.
  const urlToOpen = new URL(`/?call=${caller}`, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clientList) => {
        // 1. Ищем, есть ли уже открытая вкладка с хабом
        for (const client of clientList) {
          // ИСПРАВЛЕНИЕ 2: Используем startsWith вместо includes.
          // includes может сработать ложно, если на другом домене есть наш домен в пути.
          // startsWith(self.location.origin) гарантирует, что мы нашли вкладку именно нашего приложения.
          if (
            client.url.startsWith(self.location.origin) && "focus" in client
          ) {
            // Сначала фокусируем вкладку, а потом шлем сообщение.
            // Это гарантирует, что вкладка активна и готова принять postMessage.
            return client.focus().then(() => {
              client.postMessage({ type: "WAKE_UP_CALL", caller: caller });
            });
          }
        }

        // 2. Если приложение полностью закрыто (убито в памяти), открываем заново
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      },
    ).catch((err) => {
      // ИСПРАВЛЕНИЕ 3: Добавляем обработку ошибок, чтобы видеть проблемы в консоли
      console.error("SW: Notification click error:", err);
    }),
  );
});
