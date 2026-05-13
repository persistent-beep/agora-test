const CACHE_NAME = "agora-hub-v38";
const ASSETS = [
  "./",
  "./index.html",
  "./script1.js",
  "./style1.css",
  "./logo.png",
  "./manifest.json",
];

// 1. При установке кэшируем основные файлы (App Shell)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }),
  );
  self.skipWaiting();
});

// Удаление старых кешей
self.addEventListener("activate", (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log("[SW] Удаляем старый кеш:", cacheName);
            return caches.delete(cacheName);
          }
        }),
      );
    }),
  );
  return self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then((networkResponse) => {
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
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      vibrate: [200, 100, 200, 100, 200, 100, 200],
      requireInteraction: true,
      silent: false,
      sound: "default",
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
  event.notification.close();

  const action = event.action;
  const payloadData = event.notification.data || {};
  const caller = payloadData.caller || "unknown";

  if (action === "decline") return;

  const targetUrl = self.registration.scope + "?call=" +
    encodeURIComponent(caller);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clientList) => {
        for (const client of clientList) {
          if (
            client.url.startsWith(self.registration.scope) && "focus" in client
          ) {
            return client.focus().then(() => {
              client.postMessage({ type: "WAKE_UP_CALL", caller: caller });
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      },
    ).catch((err) => console.error("[SW] Ошибка клика:", err)),
  );
});
