// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И КОНФИГУРАЦИЯ ==========
const BACKEND_URL = "https://agora-service.onrender.com";
const API_URL = BACKEND_URL;
const WS_URL = BACKEND_URL.replace(/^http/, "ws");
const PUBLIC_VAPID_KEY =
    "BIHSLdqb6TI9eFBKl5bCV2-WTTLVpXxoluqhudCaxFktv19Z_mKz39KjRTvBOG4dBgBDpyOzlvc8MGjr3QD0Ko8";

// Элементы UI
const logo = document.getElementById("logo");
const menu = document.getElementById("menu");
const contentArea = document.getElementById("content-area");
const moduleTitle = document.getElementById("module-title");
const moduleContent = document.getElementById("module-content");

// Состояние приложения (UI)
let currentUIState = "HOME"; // HOME, MENU, CONTENT, AUTH
let callTemplateCache = null;

// Состояние звонка (WebRTC)
let callState = "IDLE"; // IDLE, RINGING_OUT, RINGING_IN, AWAITING_OFFER, CONNECTING, CONNECTED
let currentCallTarget = null;
let userRole = "guest";

// WebRTC ресурсы
let pc = null;
let localStream = null;
let signalingSocket = null;
let iceConfig = [];
let iceQueue = [];
let remoteAudioElement = null;
let pendingOfferSdp = null; // Хранилище входящего оффера
let pingInterval = null;
let reconnectTimeout = null; // Таймер автосброса при обрыве

// [CALL_ID] Идентификатор звонка, выданный сервером. Все сигнальные
// сообщения (offer/answer/candidate/call_end/peer_disconnected) теперь
// несут call_id — всё, что пришло с чужим call_id, молча игнорируется.
// Гарантированно убивает «хвосты» старого звонка при быстрой смене.
let activeCallId = null;

// Таймаут безответности исходящего звонка
let ringTimeout = null;
let RING_TIMEOUT_MS = 60000; // 60 секунд

// [FIX RC-3] Счётчик "поколений" звонка. Каждая async-цепочка запоминает
// текущее значение и проверяет его после каждого await. hangUp() и начало
// нового звонка инкрементируют счётчик — все зависшие продолжения старого
// звонка видят, что их сессия мертва, и молча выходят. Это лечит "зомби"-
// состояния (например, onCallConnected() после того, как юзер уже нажал END).
let callSeq = 0;

// [FIX RC-2] Очередь сигнальных сообщений. Раньше каждый onmessage запускал
// СВОЙ async-обработчик, и они перемешивались на await-ах (offer мог
// обрабатываться параллельно с candidate/answer). Теперь сообщения
// обрабатываются строго по одному, в порядке прихода.
let signalingQueue = Promise.resolve();

// Аудио визуализация
let audioContext = null;
let localAnalyser = null;
let localDataArray = null;
let remoteAnalyser = null;
let remoteDataArray = null;

// Таймеры и анимации
let callTimerInterval = null;
let animationFrameId = null;
let seconds = 0;
let isMuted = false;

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function debounce(func, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

// [GLARE] Детерминированное разрешение конфликта «обе стороны послали
// оффер одновременно» алфавитным порядком ролей. Роли уникальны, обе
// стороны вычисляют одно и то же без переговоров:
//   моя роль > роли собеседника → я impolite (никогда не уступаю),
//   иначе → я polite (откатываю свой оффер и принимаю чужой).
// Ровно одна сторона уступает — всегда сходится.
function getMyRoleId() {
    const session = JSON.parse(localStorage.getItem("agora_session") || "{}");
    return (session.role || userRole || "").toLowerCase();
}

function isImpolitePeer() {
    const me = getMyRoleId();
    const them = (currentCallTarget || "").toLowerCase();
    if (!me || !them) return false; // не знаем роль — считаем себя polite
    return me > them;
}

// [CALL_ID] Сообщение чужого/прошлого звонка? Если у сообщения и у нас
// есть call_id и они разные — игнор. Если call_id нет (легаси-путь,
// например сервер перезапускался и потерял реестр) — пропускаем,
// дальше сработает фильтр по msg.from (вторая линия обороны).
function isStaleCallMsg(msg) {
    if (msg.call_id && activeCallId && msg.call_id !== activeCallId) {
        console.log("[Signal] Сообщение чужого звонка, игнорируем:", msg.type);
        return true;
    }
    return false;
}

// Таймаут безответности: если за 60с звонок не приняли — сбрасываем
function startRingTimeout() {
    clearRingTimeout();
    ringTimeout = setTimeout(() => {
        ringTimeout = null;
        if (callState === "RINGING_OUT") {
            console.log("[Call] Нет ответа за 60с — сбрасываем звонок");
            hangUp();
            updateCallUI("CALL", "btn-green", "NO ANSWER", "#ff4a4a", false);
        }
    }, RING_TIMEOUT_MS);
}

function clearRingTimeout() {
    if (ringTimeout) {
        clearTimeout(ringTimeout);
        ringTimeout = null;
    }
}

async function fetchIceServers() {
    if (iceConfig.length > 0) return iceConfig;
    try {
        // [FIX SECURITY] Передаём токен: без него сервер теперь отдаёт
        // только публичный STUN, а не TURN-кредитки (см. main.py /ice-servers).
        const session = JSON.parse(
            localStorage.getItem("agora_session") || "{}",
        );
        const tokenParam = session.token
            ? `&token=${encodeURIComponent(session.token)}`
            : "";
        const response = await fetch(
            `${API_URL}/ice-servers?role=${encodeURIComponent(userRole)}${tokenParam}`,
        );
        const data = await response.json();
        iceConfig = data.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    } catch (e) {
        console.error("Ошибка ICE, используем резервный:", e);
        iceConfig = [{ urls: "stun:stun.l.google.com:19302" }];
    }
    return iceConfig;
}

function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(
        /_/g,
        "/",
    );
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// ========== УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ (UI) ==========

function handleLogoClick() {
    const token = localStorage.getItem("agora_session");
    if (currentUIState === "HOME") {
        token ? toMenu() : renderAuthModule();
    } else if (currentUIState === "MENU" || currentUIState === "AUTH") {
        // [RING-FIX] Входящий звонок звенел, а экран звонка потерялся
        // (гонка пробуждения из фона) — лого из меню = отклонить звонок,
        // иначе отклонить его из меню невозможно.
        if (callState === "RINGING_IN") hangUp();
        toHome();
    } else if (currentUIState === "CONTENT") {
        if (callState !== "IDLE") hangUp();
        else if (token) toMenu();
        else toHome();
    }
}

function toMenu() {
    if (!localStorage.getItem("agora_session")) return toHome();
    currentUIState = "MENU";
    logo.className = "logo-side";
    menu.classList.add("menu-visible");
    contentArea.classList.remove("content-visible");
}

function toHome() {
    currentUIState = "HOME";
    logo.className = "logo-center";
    menu.classList.remove("menu-visible");
    contentArea.classList.remove("content-visible");
}

function openModule(title, text) {
    currentUIState = "CONTENT";
    menu.classList.remove("menu-visible");
    moduleTitle.innerText = title;

    if (title === "PLAY") {
        moduleContent.innerHTML =
            document.getElementById("template-logout").innerHTML;
    } else {
        moduleContent.innerHTML = `<div class="placeholder">${text}</div>`;
    }
    setTimeout(() => contentArea.classList.add("content-visible"), 300);
}

function renderAuthModule() {
    currentUIState = "AUTH";
    logo.className = "logo-side";
    moduleTitle.innerText = "";
    moduleContent.innerHTML =
        document.getElementById("template-auth").innerHTML;
    setTimeout(() => contentArea.classList.add("content-visible"), 300);
}

function updateAuthBtn() {
    const input = document.getElementById("auth-token");
    const btn = document.getElementById("btn-auth-submit");
    btn.innerText = input.value.length > 0 ? "SUBMIT" : "GUEST";
}

// --- Модуль контактов ---
function renderConnectModule() {
    currentUIState = "CONTENT";
    menu.classList.remove("menu-visible");
    moduleTitle.innerText = "CONNECT";

    const template = document.getElementById("template-contacts");
    const clone = template.content.cloneNode(true);
    const listContainer = clone.getElementById("dynamic-contact-list");

    const sessionData = JSON.parse(
        localStorage.getItem("agora_session") || "{}",
    );
    const contacts = sessionData.contacts;

    if (!contacts || (Array.isArray(contacts) && contacts.length === 0)) {
        listContainer.innerHTML =
            `<div class="placeholder" style="color: #444">NO TARGETS</div>`;
    } else {
        const contactsArray = Array.isArray(contacts)
            ? contacts
            : contacts.split(",");
        contactsArray.forEach((name) => {
            const btn = document.createElement("div");
            btn.className = "contact-item";
            btn.textContent = name.trim().toUpperCase();
            btn.onclick = () => initCallInterface(name.trim());
            listContainer.appendChild(btn);
        });
    }

    moduleContent.innerHTML = "";
    moduleContent.appendChild(clone);
    setTimeout(() => contentArea.classList.add("content-visible"), 300);
}

// --- UI Звонка (Абстракция над DOM) ---
function updateCallUI(
    buttonText,
    buttonClass,
    statusText,
    statusColor,
    isDisabled = false,
) {
    const btn = document.getElementById("btn-action");
    const status = document.getElementById("call-status");

    if (btn) {
        btn.innerText = buttonText;
        btn.className = `btn-large ${buttonClass}`;
        btn.disabled = isDisabled;
    }
    if (status) {
        status.innerText = statusText;
        status.style.color = statusColor;
        status.classList.toggle("blink", callState === "RINGING_IN");
    }
}

function initCallInterface(name) {
    try {
        currentCallTarget = name.trim();
        moduleTitle.innerText = name;
        currentUIState = "CONTENT";

        const logoEl = document.getElementById("logo");
        const menuEl = document.getElementById("menu");
        const contentEl = document.getElementById("content-area");

        // 1. ЖЕСТКО сдвигаем логотип и прячем меню
        logoEl.className = "logo-side";
        menuEl.classList.remove("menu-visible");

        // 2. Вставляем HTML интерфейса звонка
        if (!callTemplateCache) {
            callTemplateCache =
                document.getElementById("template-call-ui").innerHTML;
        }
        moduleContent.innerHTML = callTemplateCache;

        // 3. Даем браузеру 50мс на рендер шаблона, затем показываем область
        setTimeout(() => {
            contentEl.classList.add("content-visible");
            updateCanvasDimensions();
        }, 50);

        isMuted = false;
        seconds = 0;
        startWaveAnimation();
    } catch (error) {
        console.error("Ошибка при инициализации интерфейса:", error);
    }
}

// ========== АВТОРИЗАЦИЯ ==========

async function handleAuthSubmit() {
    const input = document.getElementById("auth-token");
    const tokenValue = input.value || "guest";

    try {
        const response = await fetch(`${API_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenValue }),
        });

        if (response.ok) {
            const data = await response.json();
            userRole = data.role;
            // [FIX] Сбрасываем кэш ICE: после смены аккаунта роль могла
            // измениться, а старый iceConfig остался бы от прошлой роли.
            iceConfig = [];
            localStorage.setItem(
                "agora_session",
                JSON.stringify({
                    token: tokenValue,
                    contacts: data.contacts,
                    role: data.role,
                }),
            );

            // [FIX RC-5] Старый сокет закрываем, но его onclose больше не
            // устраивает шторм reconnect-циклов: в connectSignaling/onclose
            // стоит identity-guard (см. ниже). Сначала создаём новый сокет,
            // потом закрываем старый — тогда onclose старого видит, что он
            // уже не актуален, и молчит.
            const oldSocket = signalingSocket;
            connectSignaling(tokenValue);
            if (oldSocket) oldSocket.close();

            subscribeToPush(tokenValue);
            toMenu();
        } else {
            input.style.borderColor = "#ff4a4a";
            input.value = "";
            input.placeholder = "ACCESS_DENIED";
        }
    } catch (error) {
        console.error("Auth error:", error);
        input.placeholder = "SERVER_OFFLINE";
    }
}

async function subscribeToPush(token) {
    // Защита от отсутствия токена или гостевого входа
    if (!token || token === "guest") {
        console.warn(
            "[Push] Пропускаем подписку (гостевой режим или нет токена)",
        );
        return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        console.warn("[Push] Браузер не поддерживает Push");
        return;
    }

    try {
        const registration = await navigator.serviceWorker.ready;

        const existing = await registration.pushManager.getSubscription();
        if (existing) await existing.unsubscribe();

        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            console.warn("[Push] Уведомления запрещены пользователем");
            return;
        }

        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY),
        });

        const response = await fetch(
            `${API_URL}/push/subscribe?token=${encodeURIComponent(token)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription }),
            },
        );

        if (response.ok) {
            console.log("[Push] Успешно подписан на звонки");
        } else {
            console.error(
                "[Push] Ошибка сохранения подписки, статус:",
                response.status,
            );
        }
    } catch (error) {
        console.error("[Push] Ошибка подписки:", error);
    }
}

async function handleLogout() {
    if (signalingSocket) {
        // [FIX RC-5] Гасим обработчики ДО close(), чтобы onclose не запустил
        // автопереподключение перед location.reload().
        signalingSocket.onclose = null;
        signalingSocket.onerror = null;
        signalingSocket.close();
    }

    // --- ОТПИСКА ОТ PUSH ПРИ ВЫХОДЕ ---
    if ("serviceWorker" in navigator) {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager
                .getSubscription();

            if (subscription) {
                const session = JSON.parse(
                    localStorage.getItem("agora_session") || "{}",
                );
                if (session.token) {
                    await fetch(
                        `${API_URL}/push/unsubscribe?token=${
                            encodeURIComponent(session.token)
                        }`,
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                endpoint: subscription.endpoint,
                            }),
                        },
                    );
                }
                await subscription.unsubscribe();
                console.log(
                    "[Push] Успешно деактивировали пуши для этого устройства.",
                );
            }
        } catch (e) {
            console.error("[Push] Ошибка при деактивации пушей:", e);
        }
    }
    // ----------------------------------

    localStorage.removeItem("agora_session");
    location.reload();
}

// ========== WEBRTC CORE ==========

async function setupAudio() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        localAnalyser = audioContext.createAnalyser();
        localAnalyser.fftSize = 256;
        localDataArray = new Uint8Array(localAnalyser.frequencyBinCount);
        audioContext.createMediaStreamSource(localStream).connect(
            localAnalyser,
        );
    } catch (err) {
        console.error("Mic access denied:", err);
        localDataArray = new Uint8Array(128); // Пустой массив для тишины
    }
}

async function createPeerConnection() {
    await fetchIceServers();
    const newPc = new RTCPeerConnection({
        iceServers: iceConfig,
        iceTransportPolicy: "all",
    });
    // [FIX] Глобальная ссылка обновляется СРАЗУ после конструирования,
    // а не после всех await — между fetchIceServers и созданием pc
    // сигнальные сообщения больше могут поймать "pc ещё нет".
    pc = newPc;
    iceQueue = []; // Сбрасываем очередь для нового соединения

    // === ДИАГНОСТИКА ===
    const startTime = performance.now();
    console.log(
        "[ICE] PeerConnection создан, политика:",
        newPc.iceTransportPolicy || "all",
    );

    newPc.onicegatheringstatechange = () => {
        console.log(
            `[ICE] gathering state → ${newPc.iceGatheringState} (через ${
                ((performance.now() - startTime) / 1000).toFixed(1)
            }s)`,
        );
    };

    newPc.oniceconnectionstatechange = async () => {
        console.log(`[ICE] connection state → ${newPc.iceConnectionState}`);

        // [FIX RC-9] Соединение уже закрыто/заменено — выходим
        if (pc !== newPc) return;

        // 1. ЕСЛИ СВЯЗЬ ВОССТАНОВИЛАСЬ
        if (
            newPc.iceConnectionState === "connected" ||
            newPc.iceConnectionState === "completed"
        ) {
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout); // Выключаем таймер смерти
                reconnectTimeout = null;
                updateCallUI(
                    "END CALL",
                    "btn-red",
                    "CONNECTED",
                    "#4aff4a",
                    false,
                );
                console.log("[ICE] Переподключение успешно завершено!");
            }
        }

        // 2. ЕСЛИ СВЯЗЬ РАЗОРВАЛАСЬ (Смена сети, метро, сел телефон)
        if (
            newPc.iceConnectionState === "disconnected" ||
            newPc.iceConnectionState === "failed"
        ) {
            if (callState === "CONNECTED") {
                console.log(
                    "[ICE] Смена сети или обрыв! Запуск ICE Restart...",
                );
                // [FIX UX] Кнопка остается АКТИВНОЙ: пользователь должен иметь
                // возможность самому сбросить зависающий звонок, а не ждать
                // 40 секунд заблокированной кнопкой.
                updateCallUI(
                    "END CALL",
                    "btn-vosklet",
                    "RECONNECTING",
                    "#ff9900",
                    false,
                );

                // --- ЗАПУСКАЕМ ТАЙМЕР СМЕРТИ ЗВОНКА (40 секунд) ---
                if (!reconnectTimeout) {
                    reconnectTimeout = setTimeout(() => {
                        console.log(
                            "[ICE] Время на переподключение вышло. Сбрасываем звонок.",
                        );
                        reconnectTimeout = null;
                        hangUp();
                    }, 40000);
                }

                try {
                    const offer = await newPc.createOffer({ iceRestart: true });
                    // [FIX RC-9] Пока собирали оффер, звонок могли сбросить
                    if (pc !== newPc || callState !== "CONNECTED") return;
                    await newPc.setLocalDescription(offer);
                    if (pc !== newPc || callState !== "CONNECTED") return;

                    if (signalingSocket?.readyState === WebSocket.OPEN) {
                        signalingSocket.send(JSON.stringify({
                            type: "offer",
                            target: currentCallTarget,
                            sdp: newPc.localDescription.sdp,
                        }));
                    }
                } catch (err) {
                    console.error("Ошибка ICE Restart:", err);
                    hangUp();
                }
            } else {
                hangUp();
            }
        }
    };
    // +===== DIAGNOSTICS ends
    newPc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(
                `[ICE] кандидат: тип=${event.candidate.type}, протокол=${event.candidate.protocol}, адрес=${event.candidate.address}`,
            );
        } else {
            console.log(
                `[ICE] кандидаты закончились (end-of-candidates) через ${
                    ((performance.now() - startTime) / 1000).toFixed(1)
                }s)`,
            );
        }
        if (event.candidate && signalingSocket?.readyState === WebSocket.OPEN) {
            signalingSocket.send(JSON.stringify({
                type: "candidate",
                target: currentCallTarget,
                candidate: event.candidate,
            }));
        }
    };

    newPc.ontrack = (event) => {
        if (remoteAudioElement) remoteAudioElement.srcObject = null;
        remoteAudioElement = new Audio();
        remoteAudioElement.srcObject = event.streams[0];
        remoteAudioElement.autoplay = true;
        remoteAudioElement.play().catch((e) => {
            console.log("Autoplay blocked", e);
            alert("Нажмите 'ОК', чтобы разрешить звук в браузере");
        });

        if (audioContext && audioContext.state !== "closed") {
            remoteAnalyser = audioContext.createAnalyser();
            remoteAnalyser.fftSize = 256;
            remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);
            audioContext.createMediaStreamSource(event.streams[0]).connect(
                remoteAnalyser,
            );
        }
    };

    if (localStream) {
        localStream.getTracks().forEach((track) =>
            newPc.addTrack(track, localStream)
        );
    }
}

// Надежное добавление ICE кандидатов (решение Race Condition)
async function addIceCandidate(candidate) {
    // [FIX] pc может быть уже сброшен — не падаем.
    // [GLARE] В состоянии have-local-offer (наш оффер в полёте) кандидаты
    // применять нельзя — они относятся к другому поколению SDP. Кладём их
    // в очередь: flushIceQueue() применит после завершения negotiation.
    if (pc && pc.remoteDescription && pc.signalingState !== "have-local-offer") {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            // После rollback/ICE-restart могут прилетать кандидаты устаревшего
            // поколения — это ожидаемо, не роняем обработчик.
            console.warn("[ICE] Кандидат отклонён:", e?.message || e);
        }
    } else {
        iceQueue.push(candidate);
    }
}

async function flushIceQueue() {
    // [FIX] Проверяем pc на каждой итерации: звонок могли сбросить,
    // пока мы добавляли предыдущего кандидата.
    while (iceQueue.length && pc) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(iceQueue.shift()));
        } catch (e) {
            console.warn("[ICE] Кандидат из очереди отклонён:", e?.message || e);
        }
    }
}

// ========== ЛОГИКА ЗВОНКОВ (Чистые функции действий) ==========

// Роутер кнопки
function onCallButtonClick() {
    switch (callState) {
        case "IDLE":
            startOutgoingCall();
            break;
        case "RINGING_IN":
            answerCall();
            break;
        case "AWAITING_OFFER":
            break; // Ждем, кнопка заблокирована
        case "RINGING_OUT":
        case "CONNECTING":
        case "CONNECTED":
            hangUp();
            break;
    }
}

async function startOutgoingCall() {
    const seq = ++callSeq; // [FIX RC-3] фиксируем поколение звонка
    try {
        // [FIX] Раньше signalingSocket.send() без проверки readyState кидал
        // TypeError и показывал "CONNECTION FAILED" вместо понятной причины.
        if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
            throw new Error("NO_SIGNALING");
        }

        updateCallUI("CALLING>>>", "btn-blue", "CONNECTING...", "#aaa", true);
        callState = "RINGING_OUT";

        await setupAudio();
        if (seq !== callSeq) return; // [FIX RC-3] звонок уже сброшен
        await createPeerConnection();
        if (seq !== callSeq) return;

        signalingSocket.send(
            JSON.stringify({ type: "call_request", target: currentCallTarget }),
        );
        startRingTimeout(); // [TIMEOUT] 60с на ответ, иначе NO ANSWER
        updateCallUI("CALLING>>>", "btn-blue", "RINGING>>>", "#aaa", true);
    } catch (err) {
        console.error("Call start error:", err);
        // [FIX] Определяем отказ в микрофоне по стандартному err.name,
        // а не по подстроке в сообщении (зависит от языка браузера).
        const micDenied =
            err?.name === "NotAllowedError" || err?.name === "NotFoundError";
        updateCallUI(
            "CALL",
            "btn-green",
            micDenied
                ? "MIC ACCESS DENIED"
                : (err?.message === "NO_SIGNALING"
                    ? "NO CONNECTION"
                    : "CONNECTION FAILED"),
            "#ff4a4a",
            false,
        );
        // [FIX] Раньше callState зависал в RINGING_OUT после ошибки
        callState = "IDLE";
        cleanupPeerConnection();
    }
}

async function answerCall() {
    const seq = ++callSeq; // [FIX RC-3]
    try {
        updateCallUI(
            "CONNECTING...",
            "btn-blue",
            "WAITING FOR OFFER",
            "#aaa",
            true,
        );
        stopRingtone(); // [RING] юзер нажал ANSWER — хватит звонить
        callState = "AWAITING_OFFER";

        await fetchIceServers();
        if (seq !== callSeq) return; // [FIX RC-3]
        if (!localStream) await setupAudio();
        if (seq !== callSeq) return;
        if (!pc) await createPeerConnection();
        if (seq !== callSeq) return;

        if (signalingSocket?.readyState === WebSocket.OPEN) {
            signalingSocket.send(
                JSON.stringify({ type: "accept_call", target: currentCallTarget }),
            );
        }

        // [FIX RC-1] Если оффер уже пришел, пока мы готовили pc (несколько
        // await выше) — он лежит в pendingOfferSdp, забираем его.
        // Обратная гонка (оффер придет чуть позже) закрыта в case "offer":
        // там при AWAITING_OFFER и отсутствующем pc оффер тоже кладется
        // в pendingOfferSdp, а не валился в null pc.
        if (pendingOfferSdp) {
            const sdp = pendingOfferSdp;
            pendingOfferSdp = null;
            await processOfferAndAnswer(sdp, seq);
        }
    } catch (err) {
        console.error("Answer error:", err);
        pendingOfferSdp = null; // [FIX] не тащим битый оффер в следующую попытку
        updateCallUI("ANSWER", "btn-green", "ERROR", "#ff4a4a", false);
        callState = "RINGING_IN"; // Возврат в предыдущее состояние
        startRingtone(); // [RING] ошибка ответа — снова звеним
    }
}

async function processOfferAndAnswer(sdp, seq = callSeq) {
    if (!pc) return; // [FIX] null-guard
    const myPc = pc;

    callState = "CONNECTING";
    updateCallUI("CONNECTING...", "btn-blue", "CONNECTING...", "#aaa", true);

    await myPc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp }),
    );
    if (pc !== myPc || seq !== callSeq) return; // [FIX RC-3] сбросили, пока ждали

    await flushIceQueue(); // Apply queued candidates
    if (pc !== myPc || seq !== callSeq) return;

    const answer = await myPc.createAnswer();
    if (pc !== myPc || seq !== callSeq) return;
    await myPc.setLocalDescription(answer);
    if (pc !== myPc || seq !== callSeq) return;
    await flushIceQueue(); // [GLARE] кандидаты, накопленные за время negotiation
    if (pc !== myPc || seq !== callSeq) return;

    if (signalingSocket?.readyState === WebSocket.OPEN) {
        signalingSocket.send(JSON.stringify({
            type: "answer",
            target: currentCallTarget,
            sdp: myPc.localDescription.sdp,
        }));
    }

    onCallConnected();
}

function onCallConnected() {
    // [FIX RC-3] Если звонок уже сброшен (hangUp успел пройти мимо),
    // не "оживляем" его: не поднимаем callState и не запускаем таймер.
    if (callState !== "CONNECTING" && callState !== "RINGING_OUT") return;
    stopRingtone(); // [RING] страховка (answerCall уже остановил)
    clearRingTimeout(); // [TIMEOUT] дозвонились — таймаут не нужен
    callState = "CONNECTED";
    updateCallUI("END CALL", "btn-red", "CONNECTED", "#4aff4a", false);
    startTimer();
}

function hangUp() {
    stopRingtone(); // [RING] звонок сброшен — гасим рингтон до любых проверок

    if (callState === "IDLE") return;

    // [FIX RC-3] Аннулируем все незавершённые async-цепочки этого звонка
    callSeq++;

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    clearRingTimeout(); // [TIMEOUT]

    // Проверяем, что сокет не просто существует, но и ОТКРЫТ
    if (
        signalingSocket && signalingSocket.readyState === WebSocket.OPEN &&
        currentCallTarget
    ) {
        signalingSocket.send(
            JSON.stringify({
                type: "call_end",
                target: currentCallTarget,
                call_id: activeCallId, // [CALL_ID] сервер валидирует по своему реестру
            }),
        );
    } else if (currentCallTarget) {
        // [FIX UNFREEZE] Сокет не открыт: страница только разморозилась,
        // а сервер уже мог убить наш зомби-сокет по таймауту пинга.
        // Откладываем call_end — отправим первым сообщением после
        // реконнекта, иначе партнёр слушает гудки до серверного GC (~40с).
        pendingCallEnd = { target: currentCallTarget, call_id: activeCallId };
        console.warn("[Signal] Сокет не открыт — call_end уйдёт после реконнекта.");
    } else {
        console.warn("[Signal] Не удалось отправить call_end — нет цели.");
    }

    callState = "IDLE";
    cleanupPeerConnection();

    updateCallUI("CALL", "btn-green", "ENDED", "#ff4a4a", false);
    stopTimer();
    stopCallSimulation();

    setTimeout(() => {
        if (currentUIState === "CONTENT") renderConnectModule();
    }, 1000);
}

function cleanupPeerConnection() {
    if (pc) {
        pc.close();
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
    }
    if (remoteAudioElement) {
        remoteAudioElement.pause();
        remoteAudioElement.srcObject = null;
        remoteAudioElement = null;
    }
    if (audioContext && audioContext.state !== "closed") audioContext.close();

    audioContext = null;
    localAnalyser = null;
    localDataArray = null;
    remoteAnalyser = null;
    remoteDataArray = null;
    iceQueue = [];
    // [CALL_ID] ID звонка живёт ровно столько же, сколько соединение
    activeCallId = null;
    // [FIX RC-4] Обязательно чистим отложенный оффер. Раньше SDP от
    // ПРОШЛОГО (пропущенного) звонка доживал до следующего звонка, и
    // answerCall() строил соединение по устаревшему описанию.
    pendingOfferSdp = null;
}

// ========== СИГНАЛИНГ (WebSocket) ==========

function connectSignaling(token) {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }

    // [FIX RC-5] Держим ЛОКАЛЬНУЮ ссылку на создаваемый сокет. В onclose
    // сравниваем signalingSocket с ней: если нас уже заменили новым сокетом —
    // это закрытие устаревшего, его игнорируем. Это лечит:
    //   - убийство ping-интервала НОВОГО сокета старым onclose;
    //   - двойной reconnect (два живых сокета одновременно).
    const socket = new WebSocket(
        `${WS_URL}/ws?token=${encodeURIComponent(token)}`,
    );
    signalingSocket = socket;

    socket.onopen = () => {
        if (signalingSocket !== socket) return; // уже не актуален
        console.log("[Signal] Connected as", token);

        // [FIX UNFREEZE] call_end, не ушедший из-за мёртвого сокета
        // (hangUp во время разрыва) — доставляем первым же сообщением
        if (pendingCallEnd) {
            const pe = pendingCallEnd;
            pendingCallEnd = null;
            if (callState === "IDLE") {
                socket.send(JSON.stringify({
                    type: "call_end",
                    target: pe.target,
                    call_id: pe.call_id,
                }));
            }
        }

        pingInterval = setInterval(() => {
            if (signalingSocket === socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    };

    socket.onmessage = (event) => {
        if (signalingSocket !== socket) return; // сообщения старого сокета
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            console.warn("[Signal] Некорректный JSON:", e);
            return;
        }
        if (msg.type === "pong") {
            pongReceived = true; // [FIX UNFREEZE] ответ на liveness-пинг
            if (livenessWatchdog) {
                clearTimeout(livenessWatchdog);
                livenessWatchdog = null;
            }
            return;
        }

        // [FIX RC-2] Все сообщения обрабатываются строго последовательно
        signalingQueue = signalingQueue
            .then(() => handleSignalingMessage(msg))
            .catch((e) => console.error("[Signal] Ошибка обработки:", e));
    };

    socket.onclose = (event) => {
        // [FIX RC-5] Закрытие устаревшего сокета — нас уже заменили
        if (signalingSocket !== socket) return;

        clearInterval(pingInterval);
        pingInterval = null;
        console.log(
            `[Signal] Disconnected. Code ${event.code}, Reason: ${event.reason}`,
        );

        // [FIX RC-5] 4002 = сервер заменил нас новой сессией (второе
        // устройство / повторный логин). Автопереподключение здесь устроило
        // бы бесконечную "войну сокетов" между устройствами.
        if (event.code === 4002) {
            console.warn(
                "[Signal] Сессия заменена новым подключением (4002). Автопереподключение отключено.",
            );
            return;
        }

        if (event.code === 1006) {
            console.warn("proxy (1006)");
        }
        if (callState !== "IDLE" && callState !== "CONNECTED") {
            hangUp();
        } else if (callState === "CONNECTED") {
            const statusEl = document.getElementById("call-status");
            if (statusEl) {
                statusEl.innerText = "WEBSOCKET RECONNECTING";
                statusEl.style.color = "#ff9900";
            }
        }

        setTimeout(() => {
            if (signalingSocket !== socket) return; // уже переподключились
            const session = JSON.parse(
                localStorage.getItem("agora_session") || "{}",
            );
            if (session.token) connectSignaling(session.token);
        }, 3000);
    };

    socket.onerror = (err) => console.error("[Signal] Error", err);
}

async function handleSignalingMessage(msg) {
    switch (msg.type) {
        case "start_offer": {
            if (callState !== "RINGING_OUT") return;
            if (!pc) return; // [FIX] null-guard
            if (msg.call_id) activeCallId = msg.call_id; // [CALL_ID] резервная подстраховка
            try {
                const offer = await pc.createOffer();
                if (!pc || callState !== "RINGING_OUT") return; // [FIX RC-3]
                await pc.setLocalDescription(offer);
                if (!pc || callState !== "RINGING_OUT") return;
                if (signalingSocket?.readyState === WebSocket.OPEN) {
                    signalingSocket.send(
                        JSON.stringify({
                            type: "offer",
                            target: currentCallTarget,
                            sdp: pc.localDescription.sdp,
                        }),
                    );
                }
                updateCallUI(
                    "CALLING>>>",
                    "btn-blue",
                    "RINGING>>>",
                    "#aaa",
                    true,
                );
            } catch (e) {
                console.error("Offer creation failed:", e);
                hangUp();
            }
            break;
        }

        case "incoming_call": {
            if (callState !== "IDLE") return; // Защита: если уже звоним, игнорируем
            callSeq++; // [FIX RC-3] новое поколение — гасим хвосты старого
            currentCallTarget = msg.from;
            activeCallId = msg.call_id || null; // [CALL_ID]
            initCallInterface(msg.from);
            callState = "RINGING_IN";
            startRingtone(); // [RING] звоним, пока юзер не ответил
            fetchIceServers(); // Предзагрузка ICE в фоне
            updateCallUI(
                "ANSWER",
                "btn-green",
                "INCOMING CALL",
                "#ff9900",
                false,
            );
            break;
        }

        case "call_created": {
            // [CALL_ID] Сервер зарегистрировал наш исходящий звонок и выдал ID.
            // Придёт сразу после call_request — раньше, чем любые offer/candidate.
            if (callState === "RINGING_OUT") {
                activeCallId = msg.call_id || null;
            }
            break;
        }

        case "busy": {
            // [BUSY] Абонент уже в звонке — сервер сказал сразу, не ждём 60с.
            if (callState !== "RINGING_OUT") return;
            console.log("[Call] Абонент занят");
            stopRingtone(); // [RING] на случай рассинхрона — тишина
            callSeq++; // гасим незавершённые async-цепочки
            clearRingTimeout();
            callState = "IDLE";
            cleanupPeerConnection();
            updateCallUI("CALL", "btn-green", "LINE BUSY", "#ff4a4a", false);
            stopTimer();
            stopCallSimulation();
            setTimeout(() => {
                if (currentUIState === "CONTENT") renderConnectModule();
            }, 1500);
            break;
        }

        case "offer": {
            // [CALL_ID] хвосты чужого/прошлого звонка — молча игнорируем
            if (isStaleCallMsg(msg)) return;

            // [FIX] Офферы не от текущего собеседника игнорируем,
            // кроме случая IDLE/RINGING_IN (тогда это новый входящий).
            if (
                msg.from && currentCallTarget &&
                msg.from !== currentCallTarget &&
                callState !== "IDLE" && callState !== "RINGING_IN"
            ) {
                console.warn("[Signal] Оффер от постороннего абонента, игнорируем:", msg.from);
                return;
            }

            if (callState === "CONNECTED") {
                // ЭТО ICE RESTART ОТ СОБЕСЕДНИКА (ОН СМЕНИЛ СЕТЬ)
                console.log(
                    "[ICE] Получен запрос на переподключение сети от собеседника!",
                );
                if (!pc) return; // [FIX] null-guard
                const myPc = pc; // [FIX RC-3]

                // [GLARE] ОБА одновременно послали оффер (мы только что
                // отправили свой restart-оффер, он ещё в полёте).
                // Решаем детерминированно, по алфавиту ролей — см. isImpolitePeer().
                if (myPc.signalingState === "have-local-offer") {
                    if (isImpolitePeer()) {
                        // Мы impolite: наш оффер главнее, входящий игнорируем.
                        // Своё состояние получит answer от собеседника.
                        console.log("[Glare] Мы impolite — игнорируем входящий оффер, ждём answer на свой");
                        return;
                    }
                    // Мы polite: откатываем свой оффер и принимаем их.
                    console.log("[Glare] Мы polite — откатываем свой оффер, принимаем входящий");
                    await myPc.setRemoteDescription(
                        new RTCSessionDescription({ type: "rollback" }),
                    );
                    if (pc !== myPc || callState !== "CONNECTED") return; // [FIX RC-3]
                }

                updateCallUI(
                    "END CALL",
                    "btn-vosklet",
                    "SYNC...",
                    "#ff9900",
                    false,
                );

                try {
                    await myPc.setRemoteDescription(
                        new RTCSessionDescription({ type: "offer", sdp: msg.sdp }),
                    );
                    if (pc !== myPc || callState !== "CONNECTED") return; // [FIX RC-3]
                    const answer = await myPc.createAnswer();
                    if (pc !== myPc || callState !== "CONNECTED") return;
                    await myPc.setLocalDescription(answer);
                    if (pc !== myPc || callState !== "CONNECTED") return;
                    await flushIceQueue(); // [GLARE] кандидаты, ждущие в очереди
                    if (pc !== myPc || callState !== "CONNECTED") return;

                    if (signalingSocket?.readyState === WebSocket.OPEN) {
                        signalingSocket.send(JSON.stringify({
                            type: "answer",
                            target: currentCallTarget,
                            sdp: myPc.localDescription.sdp,
                        }));
                    }

                    updateCallUI(
                        "END CALL",
                        "btn-red",
                        "CONNECTED",
                        "#4aff4a",
                        false,
                    );
                } catch (e) {
                    console.error("[ICE] Ошибка обработки restart-оффера:", e);
                }
            } else if (callState === "AWAITING_OFFER") {
                // [FIX RC-1] КЛЮЧЕВАЯ ТОЧКА: оффер пришел, пока answerCall()
                // еще внутри своих await (fetchIceServers/setupAudio/
                // createPeerConnection). Раньше здесь сразу звался
                // processOfferAndAnswer и падал на null pc — оффер терялся,
                // звонок зависал. Теперь кладем в pendingOfferSdp: answerCall()
                // заберет его сразу после создания pc.
                if (!pc) {
                    pendingOfferSdp = msg.sdp;
                } else {
                    await processOfferAndAnswer(msg.sdp);
                }
            } else if (callState === "IDLE" || callState === "RINGING_IN") {
                // Оффер пришел ДО того, как пользователь нажал ANSWER
                initCallInterface(msg.from);
                callState = "RINGING_IN";
                startRingtone(); // [RING]
                updateCallUI(
                    "ANSWER",
                    "btn-green",
                    "INCOMING CALL",
                    "#ff9900",
                    false,
                );

                // [CALL_ID] холодный старт из push: incoming_call мы не видели
                // (ушёл в мёртвый сокет), ID приходит вместе с оффером
                if (msg.call_id) activeCallId = msg.call_id;

                // Просто сохраняем SDP в переменную. Когда юзер нажмет кнопку,
                // функция answerCall() сама его подхватит.
                pendingOfferSdp = msg.sdp;
            }
            break;
        }

        case "answer": {
            // [CALL_ID] хвосты чужого звонка игнорируем
            if (isStaleCallMsg(msg)) return;

            // [FIX RESTART-ANSWER] Раньше здесь был жёсткий фильтр
            // "RINGING_OUT|CONNECTING" — из-за него answer на наш
            // ICE-restart (мы уже CONNECTED, signalingState = have-local-offer)
            // ВЫБРАСЫВАЛСЯ, и рестарт зависал навсегда. Теперь такой answer
            // легально применяется.
            const isRestartAnswer =
                callState === "CONNECTED" && pc &&
                pc.signalingState === "have-local-offer";
            if (
                callState !== "RINGING_OUT" && callState !== "CONNECTING" &&
                !isRestartAnswer
            ) {
                return;
            }
            if (!pc) return; // [FIX] null-guard
            try {
                await pc.setRemoteDescription(
                    new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
                );
                if (!pc) return; // [FIX RC-3] сбросили, пока ждали
                await flushIceQueue();
                if (isRestartAnswer) {
                    // Это ответ на наш ICE-restart — звонок уже подключён,
                    // таймер идёт. Просто восстанавливаем UI после SYNC...
                    updateCallUI(
                        "END CALL",
                        "btn-red",
                        "CONNECTED",
                        "#4aff4a",
                        false,
                    );
                    if (reconnectTimeout) {
                        clearTimeout(reconnectTimeout);
                        reconnectTimeout = null;
                    }
                } else {
                    onCallConnected();
                }
            } catch (e) {
                console.error("[Signal] Не удалось применить answer:", e);
                hangUp();
            }
            break;
        }

        case "candidate": {
            // Игнорируем запоздалые пакеты от старых сессий, если мы уже в IDLE
            if (callState === "IDLE") {
                console.log(
                    "[Signal] Проигнорирован запоздалый кандидат (мы уже оффлайн)",
                );
                return;
            }
            // [CALL_ID] хвосты чужого звонка игнорируем
            if (isStaleCallMsg(msg)) return;
            // [FIX] Кандидат не от текущего собеседника — мусор прошлой сессии
            if (msg.from && currentCallTarget && msg.from !== currentCallTarget) {
                return;
            }
            if (pc) await addIceCandidate(msg.candidate);
            break;
        }

        case "peer_disconnected": {
            // [CALL_ID] сброс чужого/прошлого звонка не должен ронять текущий
            if (isStaleCallMsg(msg)) return;
            hangUp();
            break;
        }
    }
}

// ========== ИНТЕРАКТИВ ЗВОНКА ==========

function toggleMute() {
    if (callState !== "CONNECTED" || !localStream) return;

    isMuted = !isMuted;

    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !isMuted;
    }

    const micCanvas = document.getElementById("mic-canvas");
    micCanvas?.classList.toggle("muted-border", isMuted);

    const statusEl = document.getElementById("call-status");
    if (statusEl) {
        statusEl.innerText = isMuted ? "MUTED" : "CONNECTED";
        statusEl.style.color = isMuted ? "yellow" : "#4aff4a";
    }
}

function toggleSource() {
    const cube = document.getElementById("source-cube");
    cube?.classList.toggle("is-flipped");
    // Логика переключения аудио выхода (если потребуется)
}

async function activateVosklet() {
    const btn = document.getElementById("btn-vosklet");
    const statusEl = document.getElementById("call-status");

    if (localStream?.getAudioTracks()[0]?.enabled) {
        btn.innerText = "MIC OK";
        btn.style.backgroundColor = "#2b9348";
        return;
    }

    btn.innerText = "REQUESTING...";
    try {
        const testStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
        });
        if (callState === "CONNECTED" && pc) {
            const newTrack = testStream.getAudioTracks()[0];
            const sender = pc.getSenders().find((s) =>
                s.track?.kind === "audio"
            );
            if (sender) await sender.replaceTrack(newTrack);
            localStream = testStream;
        } else {
            testStream.getTracks().forEach((t) => t.stop());
        }
        btn.innerText = "MIC GRANTED";
        btn.style.backgroundColor = "#2b9348";
        if (statusEl) statusEl.innerText = "MIC READY";
    } catch (err) {
        btn.innerText = "MIC BLOCKED";
        btn.style.backgroundColor = "#bc2d2d";
        if (statusEl) {
            statusEl.innerText = "ALLOW MIC IN BROWSER";
            statusEl.style.color = "#ff4a4a";
        }
    }
}

// ========== ТАЙМЕР И ВИЗУАЛИЗАЦИЯ ==========

function startTimer() {
    stopTimer();
    seconds = 0;
    const timerEl = document.getElementById("call-timer");
    callTimerInterval = setInterval(() => {
        seconds++;
        const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
        const secs = (seconds % 60).toString().padStart(2, "0");
        if (timerEl) timerEl.innerText = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(callTimerInterval);
}

function stopCallSimulation() {
    stopTimer();
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
}

function updateCanvasDimensions() {
    const c1 = document.getElementById("remote-canvas");
    const c2 = document.getElementById("mic-canvas");
    if (c1 && c2) {
        c1.width = c1.offsetWidth;
        c1.height = c1.offsetHeight;
        c2.width = c2.offsetWidth;
        c2.height = c2.offsetHeight;
    }
}

function startWaveAnimation() {
    const ctxRemote = document.getElementById("remote-canvas")?.getContext(
        "2d",
    );
    const ctxMic = document.getElementById("mic-canvas")?.getContext(
        "2d",
    );
    if (!ctxRemote || !ctxMic) return;

    function draw(ctx, color, volumeData) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = color;

        const bars = 80;
        const barWidth = w / bars;
        for (let i = 0; i < bars; i++) {
            const val = (callState === "CONNECTED") ? (volumeData[i] || 0) : 0;
            const barHeight = (val / 255) * h * 0.9 + 2;
            ctx.fillRect(
                i * barWidth,
                (h - barHeight) / 2,
                barWidth - 2,
                barHeight,
            );
        }
    }

    function loop() {
        if (currentUIState !== "CONTENT") {
            animationFrameId = null;
            return;
        }

        if (localAnalyser && !isMuted && localDataArray) {
            localAnalyser.getByteFrequencyData(localDataArray);
        } else if (localDataArray) {
            localDataArray.fill(0);
        }

        if (remoteAnalyser && remoteDataArray) {
            remoteAnalyser.getByteFrequencyData(remoteDataArray);
        } else if (remoteDataArray) {
            remoteDataArray.fill(0);
        }

        draw(ctxRemote, "#a0a0a0", remoteDataArray || []);
        draw(ctxMic, isMuted ? "#552222" : "#a0a0a0", localDataArray);

        animationFrameId = requestAnimationFrame(loop);
    }
    loop();
}

// ========== РИНГТОН ВХОДЯЩЕГО ЗВОНКА ==========
// Почему так: Web Push API НЕ позволяет прикрепить звук к баннеру —
// на Android звук уведомления определяет системный канал уведомлений
// сайта (включается в настройках Android один раз). Поэтому, пока
// страница жива, звоним сами:
//   - ring.mp3 в корне сайта (нет файла — синтезируем гудок 425Гц);
//   - луп-аудио делает вкладку «звучащей» → Chrome не замораживает её;
//   - вибрация на Android;
//   - если автоплей запрещён (холодный старт из push) — начнём звонить
//     с первым касанием экрана (bindRingRetry).
let ringStopFn = null;
let ringActive = false;
let ringRetryBound = false;

// [FIX UNFREEZE] состояние проверки живости сокета после фона
let pendingCallEnd = null; // call_end, не ушедший из-за мёртвого сокета
let pongReceived = false;
let livenessWatchdog = null;

const RING_VIBRATE = [
    600, 400, 600, 400, 600, 400, 600, 400,
    600, 400, 600, 400, 600, 400, 600, 400,
];

function startRingtone() {
    if (ringActive || ringStopFn) return; // уже звоним
    ringActive = true;

    try {
        if (navigator.vibrate) navigator.vibrate(RING_VIBRATE);
    } catch (e) { /* вибрация не критична */ }

    // 1) Свой рингтон: положите ring.mp3 в корень сайта
    let el = null;
    try {
        el = new Audio("ring.mp3");
        el.loop = true;
    } catch (e) { /* древний браузер — сразу синтез */ }

    if (el) {
        let p = null;
        try {
            p = el.play();
        } catch (e) { /* синхронный запрет — в catch ниже */ }

        if (p && typeof p.then === "function") {
            p.then(() => {
                ringStopFn = () => {
                    try { el.pause(); } catch (e) {}
                    ringStopFn = null;
                };
            }).catch(() => {
                // нет файла ИЛИ автоплей запрещён — синтез
                ringActive = false;
                startSynthRing();
            });
        } else {
            ringActive = false;
            startSynthRing();
        }
    } else {
        ringActive = false;
        startSynthRing();
    }
}

function startSynthRing() {
    let ctx = null;
    try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}

    const begin = () => {
        if (!ctx || ctx.state !== "running") {
            // Автоплей запрещён (страница только из push) — ждём жеста
            try { if (ctx) ctx.close(); } catch (e) {}
            ringActive = false;
            bindRingRetry();
            return;
        }
        try {
            // Расписание гудков на 2 минуты вперёд: WebAudio-таймлайн
            // живёт на аудиопотоке и не зависит от троттлинга таймеров
            const t0 = ctx.currentTime + 0.05;
            for (let i = 0; i < 50; i++) {
                const s = t0 + i * 2.4;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = 425; // RU-стандарт звонка
                gain.gain.setValueAtTime(0.0001, s);
                gain.gain.exponentialRampToValueAtTime(0.4, s + 0.05);
                gain.gain.setValueAtTime(0.4, s + 0.8);
                gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.9);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(s);
                osc.stop(s + 1.0);
            }
            ringStopFn = () => {
                try { ctx.close(); } catch (e) {}
                ringStopFn = null;
            };
        } catch (e) {
            ringActive = false;
            bindRingRetry();
        }
    };

    let resume = null;
    try {
        resume = ctx && ctx.resume();
    } catch (e) {}
    if (resume && typeof resume.then === "function") {
        resume.then(begin).catch(begin);
    } else {
        begin();
    }
}

function bindRingRetry() {
    if (ringRetryBound || ringStopFn) return;
    try {
        if (typeof document === "undefined" || !document.addEventListener) {
            return;
        }
    } catch (e) { return; }
    ringRetryBound = true;
    const retry = () => {
        ringRetryBound = false;
        document.removeEventListener("pointerdown", retry);
        if (callState === "RINGING_IN") startRingtone();
    };
    document.addEventListener("pointerdown", retry);
}

function stopRingtone() {
    ringActive = false;
    try {
        if (navigator.vibrate) navigator.vibrate(0);
    } catch (e) {}
    if (ringStopFn) {
        const fn = ringStopFn;
        ringStopFn = null;
        fn();
    }
}

// [FIX UNFREEZE] Проверка «жив ли сокет» при возврате из фона
function checkSocketLiveness() {
    if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
        return; // закрыт/переподключается — штатный путь разберётся
    }
    pongReceived = false;
    try {
        signalingSocket.send(JSON.stringify({ type: "ping" }));
    } catch (e) {
        return;
    }
    if (livenessWatchdog) clearTimeout(livenessWatchdog);
    livenessWatchdog = setTimeout(() => {
        livenessWatchdog = null;
        if (
            !pongReceived && signalingSocket &&
            signalingSocket.readyState === WebSocket.OPEN
        ) {
            console.warn("[Signal] Сокет не отвечает после сна — пересобираем.");
            signalingSocket.close(); // onclose → реконнект через 3с
        }
    }, 3500);
}

// ========== ИНИЦИАЛИЗАЦИЯ ==========

window.addEventListener("resize", debounce(updateCanvasDimensions, 100));

// ========== ИНИЦИАЛИЗАЦИЯ И РАБОТА С PUSH ==========

window.addEventListener("load", () => {
    // 1. Подключаем сокеты, если юзер уже залогинен
    const session = JSON.parse(localStorage.getItem("agora_session") || "{}");
    if (session.token) {
        // [FIX] Роль не восстанавливалась после перезагрузки страницы —
        // userRole оставался "guest" (нужен для glare-сравнения и ICE)
        userRole = session.role || "guest";
        connectSignaling(session.token);
        if (Notification.permission === "granted") {
            subscribeToPush(session.token);
        }
    }

    // 2. Регистрируем Service Worker и слушаем от него команды
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js")
            .then((reg) => {
                console.log("[SW] Registered successfully");

                // Первичная проверка обновлений при загрузке
                reg.update();

                // Проверка обновлений при возвращении вкладки из фона
                document.addEventListener("visibilitychange", () => {
                    if (document.visibilityState === "visible") {
                        reg.update().catch((e) =>
                            console.error("[SW] Update failed on focus:", e)
                        );
                    }
                });
            })
            .catch((e) => {
                console.error("[SW] Registration failed:", e);
            });
    }
    // Ловим WAKE_UP_CALL (если приложение УЖЕ БЫЛО открыто, но висело в фоне)
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (!event.data) return;

        if (event.data.type === "WAKE_UP_CALL") {
            const caller = event.data.caller;
            console.log(`[Push] Проснулись от звонка от ${caller}`);

            // [FIX RC-8] Пуш больше НЕ перезаписывает активный звонок.
            // Раньше клик по уведомлению от другого абонента во время
            // разговора подменял UI и callState, а старый звонок продолжал
            // жить (поток-сирота).
            if (callState === "IDLE") {
                callSeq++;
                // [PUSH-ALWAYS] SW пересылает серверный call_id — принимаем
                // его, чтобы фильтр хвостов isStaleCallMsg работал и тут
                if (event.data.call_id) activeCallId = event.data.call_id;
                initCallInterface(caller);
                callState = "RINGING_IN";
                startRingtone(); // [RING]
                updateCallUI(
                    "ANSWER",
                    "btn-green",
                    "INCOMING CALL",
                    "#ff9900",
                    false,
                );
            }
        }
        if (event.data.type === "CALL_DECLINED") {
            console.log("[Push] Звонок был отклонен или сброшен");

            // hangUp() сам сбросит состояние и вернёт список контактов.
            // [FIX] Убран updateCallUI с чёрным текстом (#000000) и
            // заблокированной кнопкой — раньше после отклонения звонка
            // кнопка CALL оставалась навсегда disabled.
            hangUp();
        }
    });

    // 3. Обработка холодного старта из Push-уведомления (если приложение было убито)
    const urlParams = new URLSearchParams(window.location.search);
    const callerFromPush = urlParams.get("call");

    if (callerFromPush && callState === "IDLE") {
        // Очищаем URL от ?call=..., НО сохраняем правильную папку (например, /agora-test/)
        window.history.replaceState(
            {},
            document.title,
            window.location.pathname,
        );

        // Разворачиваем интерфейс звонка
        callSeq++;
        initCallInterface(callerFromPush);
        callState = "RINGING_IN";
        startRingtone(); // [RING]
        updateCallUI("ANSWER", "btn-green", "INCOMING CALL", "#ff9900", false);
    }
});

// [FIX] Два одинаковых обработчика visibilitychange объединены в один.
document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;

    if (currentUIState === "CONTENT") {
        logo.className = "logo-side";
        contentArea.classList.add("content-visible");
    }

    // [FIX UNFREEZE] Вкладка проснулась из фона. Сокет мог умереть, пока
    // мы спали (Android замораживает JS, сервер убивает зомби по таймауту
    // пинга), а readyState об этом ещё не знает. Пингуем: нет pong за
    // 3.5с — считаем сокет мёртвым и пересобираем подключение штатно.
    checkSocketLiveness();
});

// ========== АВТО-ВОССТАНОВЛЕНИЕ АУДИО (Смена наушников / устройств) ==========
// [FIX] devicechange не поддерживается в Safari/iOS — добавлен guard
if (
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.addEventListener === "function"
) {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
        console.log("[Audio] Обнаружено изменение аудиоустройств!");

        // Делаем что-то только если звонок активен
        if (callState === "CONNECTED" && pc && localStream) {
            try {
                const newStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });

                // [FIX RC-3] Пока просили микрофон, звонок могли сбросить
                if (callState !== "CONNECTED" || !pc) {
                    newStream.getTracks().forEach((t) => t.stop());
                    return;
                }

                const newTrack = newStream.getAudioTracks()[0];
                const sender = pc.getSenders().find((s) =>
                    s.track?.kind === "audio"
                );

                if (sender) {
                    await sender.replaceTrack(newTrack);

                    localStream.getTracks().forEach((t) => t.stop()); // гасим старый микрофон
                    localStream = newStream;

                    if (audioContext && audioContext.state !== "closed") {
                        const source = audioContext.createMediaStreamSource(
                            localStream,
                        );
                        source.connect(localAnalyser);
                    }
                    console.log("[Audio] Микрофон успешно переключен на лету!");
                }
            } catch (e) {
                console.error("[Audio] Ошибка при смене аудиоустройства:", e);
            }
        }
    });
}

// Отображение CACHE_NAME в футере
(function initCacheDisplay() {
    const label = document.getElementById("cache-label");
    if (!label) return;

    function requestCache() {
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage("GET_CACHE_NAME");
        }
    }

    // Запрос сразу, если SW уже под контролем
    if (navigator.serviceWorker.controller) requestCache();

    // Ждём готовности SW
    navigator.serviceWorker.ready.then(() => requestCache());

    // Слушаем ответ от SW
    navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "CACHE_NAME") {
            label.textContent = `${e.data.name}`;
        }
    });
})();
