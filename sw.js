const CACHE_NAME = "agora-hub-v61"; // [v61] Enter-логин + рингтон + unfreeze-хил сокета; ring.mp3 в кэше (нет файла — install переживёт)
const ASSETS = [
  "./",
  "./index.html",
  "./script1.js",
  "./style1.css",
  "./logo.png",
  "./manifest.json",
  "./ring.mp3", // [RING] рингтон входящего; файла может не быть — allSettled переживёт 404
];
const API_URL = "https://agora-service.onrender.com";

// 1. При установке кэшируем основные файлы (App Shell)
// [FIX] Раньше стоял cache.addAll(ASSETS) — он АТОМАРНЫЙ: если хоть один
// файл отдавался 404/500 (например, забыли залить logo.png), весь install
// падал, новый Service Worker никогда не активировался и приложение
// навсегда оставалось на старой версии. Кэшируем каждый файл отдельно:
// один битый файл больше не блокирует обновление.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    ),
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
self.addEventListener("push", function (event) {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    return;
  }

  // [PUSH-ALWAYS] Свои окна + признак «хотя бы одно открыто на экране»
  async function ownClients() {
    const all = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return all.filter((c) => c.url.includes(self.registration.scope));
  }

  function hasVisible(clients) {
    return clients.some((c) => c.visibilityState === "visible");
  }

  // [PUSH-ALWAYS] Входящий звонок: push теперь приходит ВСЕГДА (даже когда
  // страница «онлайн» по WebSocket — на Android свёрнутая вкладка замерзает
  // и WS-сообщение она не обрабатывает). Если приложение видно на экране —
  // пересылаем событие странице (у неё уже висит UI звонка), уведомление
  // НЕ показываем. Если свёрнуто/замерзло — показываем уведомление.
  if (payload.type === "INCOMING_CALL") {
    event.waitUntil((async function () {
      const clients = await ownClients();

      if (hasVisible(clients)) {
        clients.forEach((c) =>
          c.postMessage({
            type: "WAKE_UP_CALL",
            caller: payload.caller,
            call_id: payload.call_id,
          })
        );
        // Браузер не требует уведомления, когда вкладка видна — тихо уходим
        return;
      }

      // [RING] Скрытая, но ЖИВАЯ вкладка (только свернули, десктоп,
      // фон без заморозки): будим её тоже — она подхватит рингтон сама.
      // Замёрзшая вкладка получит сообщение при оттаивании — guard'ы
      // в странице не дадут задвоить состояние.
      clients.forEach((c) =>
        c.postMessage({
          type: "WAKE_UP_CALL",
          caller: payload.caller,
          call_id: payload.call_id,
        })
      );

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        vibrate: [200, 100, 200, 100, 200, 100, 200],
        requireInteraction: true, // Пуш не исчезнет сам
        silent: false,
        timestamp: Date.now(),
        tag: "incoming-call", // [PUSH-CANCEL] по этому тегу потом найдём баннер
        data: {
          caller: payload.caller,
          target: payload.target,
          call_id: payload.call_id,
        },
        // Убрали кнопку "Принять". Оставляем только "Отклонить".
        actions: [
          { action: "decline", title: "🔴 Отклонить" },
        ],
      });
    })());
    return;
  }

  // [PUSH-CANCEL] Звонок отменён до ответа (звонящий сбросил / истёк
  // таймаут дозвона / серверный TTL). Гасим висящий баннер «Входящий вызов»
  // и оставляем тихое «Пропущенный», как в мессенджерах.
  if (payload.type === "CALL_CANCELLED") {
    event.waitUntil((async function () {
      const ringing = await self.registration.getNotifications({
        tag: "incoming-call",
      });
      let hadBanner = false;
      ringing.forEach(function (n) {
        const d = n.data || {};
        // Гасим только совпавший call_id (или старый баннер без ID) —
        // так повторный звонок не убьёт баннер НОВОГО звонка
        if (!payload.call_id || !d.call_id || d.call_id === payload.call_id) {
          n.close();
          hadBanner = true;
        }
      });

      // Баннера не было (ответили/отклонили тапом). Если приложение открыто
      // на экране — ничего не показываем: оно всё узнает по WebSocket.
      if (!hadBanner) {
        const clients = await ownClients();
        if (hasVisible(clients)) return;
      }

      await self.registration.showNotification("Пропущенный вызов", {
        body: payload.body || "Звонок отменён",
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        silent: true,
        requireInteraction: false,
        timestamp: Date.now(),
        // Свой тег (не "incoming-call"!): не должен заменять баннер
        // НОВОГО входящего звонка при быстрых перезвонах
        tag: "missed-" + (payload.caller || "unknown"),
        data: {
          caller: payload.caller,
          call_id: payload.call_id,
          missed: true,
        },
      });
    })());
    return;
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
    // [PUSH-CANCEL] Клик по «Пропущенному вызову»: просто открываем
    // приложение, НЕ разворачивая интерфейс мёртвого звонка.
    const isMissed = !!payloadData.missed;
    const targetUrl = self.registration.scope +
      (isMissed ? "" : "?call=" + encodeURIComponent(caller));
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
                  if (focusedClient && !isMissed) {
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
