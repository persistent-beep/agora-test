const CACHE_NAME = "agora-hub-v36";
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
  const payloadData = event.notification.data || {};
  const caller = payloadData.caller || "unknown";

  if (action === "decline") return;

  // ИДЕАЛЬНЫЙ URL ДЛЯ GITHUB PAGES (с учетом папки /agora-test/)
  // self.registration.scope вернет "https://persistent-beep.github.io/agora-test/"
  const targetUrl = self.registration.scope + "?call=" +
    encodeURIComponent(caller);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clientList) => {
        for (const client of clientList) {
          // Ищем вкладку, которая начинается с правильного адреса
          if (
            client.url.startsWith(self.registration.scope) && "focus" in client
          ) {
            return client.focus().then(() => {
              client.postMessage({ type: "WAKE_UP_CALL", caller: caller });
            });
          }
        }

        // Открываем правильный URL внутри PWA
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      },
    ).catch((err) => console.error("[SW] Ошибка клика:", err)),
  );
});
