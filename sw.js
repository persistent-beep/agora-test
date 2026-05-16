const CACHE_NAME = "agora-hub-v54";
const ASSETS = [
  "./",
  "./index.html",
  "./script1.js",
  "./style1.css",
  "./logo.png",
  "./manifest.json",
];
const API_URL = "https://agora-service.onrender.com";

// 1. При установке кэшируем основные файлы (App Shell)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }),
  );
  self.skipWaiting();
});
// 2. реакция на запрос
self.addEventListener("message", (event) => {
  if (event.data === "GET_CACHE_NAME") {
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        client.postMessage({ type: "CACHE_NAME", name: CACHE_NAME });
      });
    });
  }
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
//self.addEventListener("push", function (event) {
//  if (!event.data) return;
//
//  const payload = event.data.json();
//
//  if (payload.type === "INCOMING_CALL") {
//    const options = {
//      body: payload.body,
//      icon: "./icons/icon-192.png",
//      badge: "./icons/icon-192.png",
//      vibrate: [200, 100, 200, 100, 200, 100, 200],
//      requireInteraction: true,
//      silent: false,
//      sound: "default",
//      data: { caller: payload.caller, target: payload.target },
//      actions: [
//        { action: "answer", title: "🟢 Принять" },
//        { action: "decline", title: "🔴 Отклонить" },
//      ],
//    };
//
//    event.waitUntil(
//      self.registration.showNotification(payload.title, options),
//    );
//  }
//});
//
//self.addEventListener("notificationclick", function (event) {
//  event.notification.close();
//
//  const action = event.action;
//  const payloadData = event.notification.data || {};
//  const caller = payloadData.caller || "unknown";
//  const target = payloadData.target || "unknown";
//  const targetUrl = self.registration.scope + "?call=" +
//    encodeURIComponent(caller);
//
//  console.log("[SW] notificationclick:", { action, caller, target });
//
//  event.waitUntil(
//    (async () => {
//      // 🔴 Отклонить
//      if (action === "decline") {
//        const clients = await self.clients.matchAll({
//          type: "window",
//          includeUncontrolled: true,
//        });
//        let notified = false;
//
//        for (const client of clients) {
//          if (client.url.includes(self.registration.scope)) {
//            client.postMessage({ type: "CALL_DECLINED", caller });
//            notified = true;
//            break;
//          }
//        }
//        if (!notified) {
//          try {
//            await fetch(`${API_URL}/call/decline`, {
//              method: "POST",
//              headers: { "Content-Type": "application/json" },
//              body: JSON.stringify({ caller, target }),
//            });
//          } catch (err) {
//            console.error("[SW] Ошибка отправки decline:", err);
//          }
//        }
//        return;
//      }
//
//      // 🟢 Принять (кнопка или тело уведомления)
//      if (action === "answer" || action === "" || action === undefined) {
//        const clientsList = await self.clients.matchAll({
//          type: "window",
//          includeUncontrolled: true,
//        });
//
//        for (const client of clientsList) {
//          if (
//            client.url.includes(self.registration.scope) && "focus" in client
//          ) {
//            client.focus();
//            client.postMessage({
//              type: "WAKE_UP_CALL",
//              caller: caller,
//            });
//            return;
//          }
//        }
//
//        // Окно не найдено → открываем новое
//        if (typeof self.clients.openWindow === "function") {
//          return self.clients.openWindow(targetUrl);
//        }
//      }
//    })().catch((err) => console.error("[SW] Ошибка notificationclick:", err)),
//  );
//});
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
      requireInteraction: true, // Пуш не исчезнет сам
      silent: false,
      sound: "default",
      data: { caller: payload.caller, target: payload.target },
      // Убрали кнопку "Принять". Оставляем только "Отклонить".
      actions: [
        { action: "decline", title: "🔴 Отклонить" },
      ],
    };

    event.waitUntil(
      self.registration.showNotification(payload.title, options),
    );
  }
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  const action = event.action;
  const payloadData = event.notification.data || {};
  const caller = payloadData.caller || "unknown";
  const target = payloadData.target || "unknown";

  console.log("[SW] notificationclick:", { action, caller, target });

  // 🔴 1. Нажали кнопку "ОТКЛОНИТЬ"
  if (action === "decline") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(
        function (clients) {
          let notified = false;

          // Если приложение свернуто - кидаем ему команду на сброс
          clients.forEach(function (client) {
            if (client.url.includes(self.registration.scope)) {
              client.postMessage({ type: "CALL_DECLINED", caller: caller });
              notified = true;
            }
          });

          // Если приложение вообще закрыто - шлем запрос на сервер
          if (!notified) {
            return fetch(`${API_URL}/call/decline`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ caller: caller, target: target }),
            }).catch((err) =>
              console.error("[SW] Ошибка отправки decline:", err)
            );
          }
        },
      ),
    );
    return;
  }

  // 🟢 2. Нажали НА ТЕЛО УВЕДОМЛЕНИЯ (action пустой) -> открываем/разворачиваем звонок
  if (!action) {
    // Надежный способ склеить URL для Android
    const urlObj = new URL(self.registration.scope);
    urlObj.searchParams.set("call", caller);
    const targetUrl = self.registration.scope + "?call=" +
      encodeURIComponent(caller);
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then(
          function (clientsList) {
            // Пытаемся найти уже открытую вкладку
            for (let i = 0; i < clientsList.length; i++) {
              const client = clientsList[i];
              if (
                client.url.includes(self.registration.scope) &&
                "focus" in client
              ) {
                return client.focus().then(function (focusedClient) {
                  if (focusedClient) {
                    focusedClient.postMessage({
                      type: "WAKE_UP_CALL",
                      caller: caller,
                    });
                  }
                });
              }
            }

            // Если вкладки нет (убита) -> Открываем приложение с нуля
            if (self.clients.openWindow) {
              return self.clients.openWindow(targetUrl);
            }
          },
        ),
    );
  }
});
