const CACHE_NAME = "agora-hub-v48";
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
      data: { caller: payload.caller, target: payload.target },
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
self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  const action = event.action;
  const payloadData = event.notification.data || {};
  const caller = payloadData.caller || "unknown";
  const target = payloadData.target || "unknown";

  // Добавляем параметр, чтобы скрипт понял, что мы нажали именно "Принять"
  const autoAnswerParam = action === "answer" ? "&auto_answer=1" : "";
  const targetUrl = self.registration.scope + "?call=" +
    encodeURIComponent(caller) + autoAnswerParam;

  console.log("[SW] notificationclick:", { action, caller, target });

  event.waitUntil(
    (async () => {
      // 🔴 Отклонить
      if (action === "decline") {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        let notified = false;

        for (const client of clients) {
          if (client.url.includes(self.registration.scope)) {
            client.postMessage({ type: "CALL_DECLINED", caller });
            notified = true;
          }
        }
        if (!notified) {
          try {
            await fetch(`${API_URL}/call/decline`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ caller, target }),
            });
          } catch (err) {
            console.error("[SW] Ошибка отправки decline:", err);
          }
        }
        return;
      }

      // 🟢 Принять (кнопка или клик по телу уведомления)
      if (action === "answer" || action === "" || action === undefined) {
        const clientsList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });

        for (const client of clientsList) {
          if (
            client.url.includes(self.registration.scope) && "focus" in client
          ) {
            try {
              // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Ждем, пока Android развернет окно
              const focusedClient = await client.focus();
              if (focusedClient) {
                focusedClient.postMessage({
                  type: "WAKE_UP_CALL",
                  caller: caller,
                  autoAnswer: action === "answer", // Передаем флаг "Авто-поднятие"
                });
              }
              return; // Теперь return срабатывает только когда фокус завершился
            } catch (e) {
              console.error("[SW] Ошибка фокуса:", e);
            }
          }
        }

        // Окно не найдено → открываем новое (холодный старт)
        if (typeof self.clients.openWindow === "function") {
          // ✅ Обязательно await
          await self.clients.openWindow(targetUrl);
          return;
        }
      }
    })().catch((err) => console.error("[SW] Ошибка notificationclick:", err)),
  );
});
