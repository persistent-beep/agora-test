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
// Готово к замене на класс FSM (например, fsm.transition('RINGING'))
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

async function fetchIceServers() {
    if (iceConfig.length > 0) return iceConfig;
    try {
        const response = await fetch(
            `${API_URL}/ice-servers?role=${encodeURIComponent(userRole)}`,
        );
        const data = await response.json();
        iceConfig = data.iceServers;
    } catch (e) {
        console.error("Ошибка ICE, используем резервный:", e);
        iceConfig = [{ urls: "stun:stun.l.google.com:19302" }];
    }
    return iceConfig;
}

async function waitIceGathering(peerConnection) {
    if (peerConnection.iceGatheringState === "complete") {
        console.log("[ICE] gathering уже complete, ждать не нужно");
        return;
    }
    console.log("[ICE] ожидаю завершения gathering...");
    await new Promise((resolve) => {
        const checkState = () => {
            if (peerConnection.iceGatheringState === "complete") {
                console.log("[ICE] gathering завершён (complete)");
                peerConnection.removeEventListener(
                    "icegatheringstatechange",
                    checkState,
                );
                resolve();
            }
        };
        peerConnection.addEventListener("icegatheringstatechange", checkState);
    });
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
    currentCallTarget = name.trim();
    moduleTitle.innerText = name;

    if (currentUIState !== "CONTENT") {
        currentUIState = "CONTENT";
        menu.classList.remove("menu-visible");
        setTimeout(() => contentArea.classList.add("content-visible"), 300);
    }

    if (!callTemplateCache) {
        callTemplateCache =
            document.getElementById("template-call-ui").innerHTML;
    }
    moduleContent.innerHTML = callTemplateCache;

    isMuted = false;
    seconds = 0;
    updateCanvasDimensions();
    startWaveAnimation();
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
            localStorage.setItem(
                "agora_session",
                JSON.stringify({
                    token: tokenValue,
                    contacts: data.contacts,
                    role: data.role,
                }),
            );

            if (signalingSocket) signalingSocket.close();
            connectSignaling(tokenValue);
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
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    // Запрашиваем права
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY),
        });

        // Отправляем подписку на ваш FastAPI сервер
        await fetch(
            `${API_URL}/push/subscribe?token=${encodeURIComponent(token)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription: subscription }),
            },
        );
        console.log("[Push] Успешно подписаны на звонки!");
    } catch (e) {
        console.error("[Push] Ошибка подписки:", e);
    }
}

function handleLogout() {
    if (signalingSocket) signalingSocket.close();
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
    pc = new RTCPeerConnection({
        iceServers: iceConfig,
        iceTransportPolicy: "all",
    });
    iceQueue = []; // Сбрасываем очередь для нового соединения

    // === ДИАГНОСТИКА ===
    const startTime = performance.now();
    console.log(
        "[ICE] PeerConnection создан, политика:",
        pc.iceTransportPolicy || "all",
    );

    pc.onicegatheringstatechange = () => {
        console.log(
            `[ICE] gathering state → ${pc.iceGatheringState} (через ${
                ((performance.now() - startTime) / 1000).toFixed(1)
            }s)`,
        );
    };

    pc.oniceconnectionstatechange = async () => {
        console.log(`[ICE] connection state → ${pc.iceConnectionState}`);

        // 1. ЕСЛИ СВЯЗЬ ВОССТАНОВИЛАСЬ
        if (
            pc.iceConnectionState === "connected" ||
            pc.iceConnectionState === "completed"
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
            pc.iceConnectionState === "disconnected" ||
            pc.iceConnectionState === "failed"
        ) {
            if (callState === "CONNECTED") {
                console.log(
                    "[ICE] Смена сети или обрыв! Запуск ICE Restart...",
                );
                updateCallUI(
                    "RECONNECTING...",
                    "btn-vosklet",
                    "RECONNECTING",
                    "#ff9900",
                    true,
                );

                // --- ЗАПУСКАЕМ ТАЙМЕР СМЕРТИ ЗВОНКА (40 секунд) ---
                if (!reconnectTimeout) {
                    reconnectTimeout = setTimeout(() => {
                        console.log(
                            "[ICE] Время на переподключение вышло. Сбрасываем звонок.",
                        );
                        hangUp();
                        // Слегка меняем текст после hangUp, чтобы было понятно, почему сбросилось
                        updateCallUI(
                            "CALL",
                            "btn-green",
                            "CONNECTION LOST",
                            "#ff4a4a",
                            false,
                        );
                    }, 40000);
                }

                try {
                    // Создаем оффер с флагом iceRestart
                    const offer = await pc.createOffer({ iceRestart: true });
                    await pc.setLocalDescription(offer);

                    // Отправляем собеседнику
                    if (signalingSocket?.readyState === WebSocket.OPEN) {
                        signalingSocket.send(JSON.stringify({
                            type: "offer",
                            target: currentCallTarget,
                            sdp: pc.localDescription.sdp,
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
    pc.onicecandidate = (event) => {
        // диагностика
        if (event.candidate) {
            console.log(
                `[ICE] кандидат: тип=${event.candidate.type}, протокол=${event.candidate.protocol}, адрес=${event.candidate.address}`,
            );
        } else {
            console.log(
                `[ICE] кандидаты закончились (end-of-candidates) через ${
                    ((performance.now() - startTime) / 1000).toFixed(1)
                }s`,
            );
        }
        // твоя существующая логика отправки
        if (event.candidate && signalingSocket?.readyState === WebSocket.OPEN) {
            signalingSocket.send(JSON.stringify({
                type: "candidate",
                target: currentCallTarget,
                candidate: event.candidate,
            }));
        }
    };

    pc.ontrack = (event) => {
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
            pc.addTrack(track, localStream)
        );
    }
}

// Надежное добавление ICE кандидатов (решение Race Condition)
async function addIceCandidate(candidate) {
    if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
        iceQueue.push(candidate);
    }
}

async function flushIceQueue() {
    while (iceQueue.length) {
        await pc.addIceCandidate(new RTCIceCandidate(iceQueue.shift()));
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
    try {
        updateCallUI("CALLING>>>", "btn-blue", "CONNECTING...", "#aaa", true);
        callState = "RINGING_OUT";

        await setupAudio();
        await createPeerConnection();

        signalingSocket.send(
            JSON.stringify({ type: "call_request", target: currentCallTarget }),
        );
        updateCallUI("CALLING>>>", "btn-blue", "RINGING>>>", "#aaa", true);
    } catch (err) {
        console.error("Call start error:", err);
        updateCallUI(
            "CALL",
            "btn-green",
            err.message.includes("microphone")
                ? "MIC ACCESS DENIED"
                : "CONNECTION FAILED",
            "#ff4a4a",
            false,
        );
        cleanupPeerConnection();
    }
}

async function answerCall() {
    try {
        updateCallUI(
            "CONNECTING...",
            "btn-blue",
            "WAITING FOR OFFER",
            "#aaa",
            true,
        );
        callState = "AWAITING_OFFER";

        await fetchIceServers();
        if (!localStream) await setupAudio();
        if (!pc) await createPeerConnection();

        signalingSocket.send(
            JSON.stringify({ type: "accept_call", target: currentCallTarget }),
        );
        // Если оффер уже пришел (сохранен в переменную), обрабатываем его сразу!
        if (pendingOfferSdp) {
            const sdp = pendingOfferSdp;
            pendingOfferSdp = null; // Чистим переменную
            await processOfferAndAnswer(sdp);
        }
    } catch (err) {
        console.error("Answer error:", err);
        updateCallUI("ANSWER", "btn-green", "ERROR", "#ff4a4a", false);
        callState = "RINGING_IN"; // Возврат в предыдущее состояние
    }
}

async function processOfferAndAnswer(sdp) {
    callState = "CONNECTING";
    updateCallUI("CONNECTING...", "btn-blue", "CONNECTING...", "#aaa", true);

    await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp }),
    );
    await flushIceQueue(); // Apply queued candidates

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    //await waitIceGathering(pc);

    signalingSocket.send(JSON.stringify({
        type: "answer",
        target: currentCallTarget,
        sdp: pc.localDescription.sdp,
    }));

    onCallConnected();
}

function onCallConnected() {
    callState = "CONNECTED";
    updateCallUI("END CALL", "btn-red", "CONNECTED", "#4aff4a", false);
    startTimer();
}

function hangUp() {
    if (callState === "IDLE") return;

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Проверяем, что сокет не просто существует, но и ОТКРЫТ
    if (
        signalingSocket && signalingSocket.readyState === WebSocket.OPEN &&
        currentCallTarget
    ) {
        signalingSocket.send(
            JSON.stringify({ type: "call_end", target: currentCallTarget }),
        );
    } else {
        console.warn("[Signal] Не удалось отправить call_end — нет сети.");
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
}

// ========== СИГНАЛИНГ (WebSocket) ==========

function connectSignaling(token) {
    if (pingInterval) clearInterval(pingInterval);
    signalingSocket = new WebSocket(
        `${WS_URL}/ws?token=${encodeURIComponent(token)}`,
    );

    signalingSocket.onopen = () => {
        console.log("[Signal] Connected as", token);

        pingInterval = setInterval(() => {
            if (signalingSocket.readyState === WebSocket.OPEN) {
                signalingSocket.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    };

    signalingSocket.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "pong") return;

        await handleSignalingMessage(msg);
    };

    signalingSocket.onclose = () => {
        clearInterval(pingInterval);
        console.log(
            `[Signal] Disconnected. Code ${event.code}, Reason: ${event.reason}`,
        );
        if (event.code === 1006) {
            console.warn("proxy (1006)");
        }
        if (callState !== "IDLE" && callState !== "CONNECTED") {
            hangUp();
        } else if (callState === "CONNECTED") {
            const statusEl = document.getElementById("call-status");
            if (statusEl) statusEl.innerText = "Webscoket пересоединяем";
        }

        setTimeout(() => {
            const session = JSON.parse(
                localStorage.getItem("agora_session") || "{}",
            );
            if (session.token) connectSignaling(session.token);
        }, 3000);
    };
    signalingSocket.onerror = (err) => console.error("[Signal] Error", err);
}

async function handleSignalingMessage(msg) {
    switch (msg.type) {
        case "start_offer": {
            if (callState !== "RINGING_OUT") return;
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                //await waitIceGathering(pc);
                signalingSocket.send(
                    JSON.stringify({
                        type: "offer",
                        target: currentCallTarget,
                        sdp: pc.localDescription.sdp,
                    }),
                );
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
            currentCallTarget = msg.from;
            initCallInterface(msg.from);
            callState = "RINGING_IN";
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

        case "offer": {
            if (callState === "CONNECTED") {
                // ЭТО ICE RESTART ОТ СОБЕСЕДНИКА (ОН СМЕНИЛ СЕТЬ)
                console.log(
                    "[ICE] Получен запрос на переподключение сети от собеседника!",
                );
                updateCallUI(
                    "RECONNECTING...",
                    "btn-vosklet",
                    "SYNC...",
                    "#ff9900",
                    true,
                );

                await pc.setRemoteDescription(
                    new RTCSessionDescription({ type: "offer", sdp: msg.sdp }),
                );
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                signalingSocket.send(JSON.stringify({
                    type: "answer",
                    target: currentCallTarget,
                    sdp: pc.localDescription.sdp,
                }));

                updateCallUI(
                    "END CALL",
                    "btn-red",
                    "CONNECTED",
                    "#4aff4a",
                    false,
                );
            } else if (callState === "AWAITING_OFFER") {
                await processOfferAndAnswer(msg.sdp);
            } else if (callState === "IDLE" || callState === "RINGING_IN") {
                // Оффер пришел ДО того, как пользователь нажал ANSWER
                initCallInterface(msg.from);
                callState = "RINGING_IN";
                updateCallUI(
                    "ANSWER",
                    "btn-green",
                    "INCOMING CALL",
                    "#ff9900",
                    false,
                );

                // Просто сохраняем SDP в переменную. Когда юзер нажмет кнопку,
                // функция answerCall() сама его подхватит.
                pendingOfferSdp = msg.sdp;
            }
            break;
        }

        case "answer": {
            if (callState !== "RINGING_OUT" && callState !== "CONNECTING") {
                return;
            }
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
            );
            await flushIceQueue();
            onCallConnected();
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
            if (pc) await addIceCandidate(msg.candidate);
            break;
        }

        case "peer_disconnected": {
            hangUp();
            break;
        }
    }
}

// ========== ИНТЕРАКТИВ ЗВОНКА ==========

function toggleMute() {
    if (callState !== "CONNECTED") return;
    isMuted = !isMuted;
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
        btn.innerText = "MIC OK ✓";
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
        btn.innerText = "MIC GRANTED ✓";
        btn.style.backgroundColor = "#2b9348";
        if (statusEl) statusEl.innerText = "MIC READY";
    } catch (err) {
        btn.innerText = "MIC BLOCKED ✗";
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
    const ctxMic = document.getElementById("mic-canvas")?.getContext("2d");
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

// ========== ИНИЦИАЛИЗАЦИЯ ==========

window.addEventListener("resize", debounce(updateCanvasDimensions, 100));

window.addEventListener("load", () => {
    const session = JSON.parse(localStorage.getItem("agora_session") || "{}");
    if (session.token) connectSignaling(session.token);

    const urlParams = new URLSearchParams(window.location.search);
    const callerFromPush = urlParams.get("call");

    if (callerFromPush) {
        // Очищаем URL (убираем ?call=... из адресной строки), чтобы не звонило повторно при F5
        window.history.replaceState({}, document.title, "/");

        // Разворачиваем интерфейс звонка
        initCallInterface(callerFromPush);
        callState = "RINGING_IN";
        updateCallUI("ANSWER", "btn-green", "INCOMING CALL", "#ff9900", false);
    }
});

// PWA Registration
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((e) =>
            console.error("[SW] Error:", e)
        );
    });
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "WAKE_UP_CALL") {
            const caller = event.data.caller;
            console.log(`[Push] Проснулись от звонка от ${caller}`);

            // Если WebSocket спал, он сам переподключится.
            // Мы принудительно открываем интерфейс звонка.
            initCallInterface(caller);
            callState = "RINGING_IN";
            updateCallUI(
                "ANSWER",
                "btn-green",
                "INCOMING CALL",
                "#ff9900",
                false,
            );
        }
    });
}
// ========== АВТО-ВОССТАНОВЛЕНИЕ АУДИО (Смена наушников / устройств) ==========
navigator.mediaDevices.addEventListener("devicechange", async () => {
    console.log("[Audio] Обнаружено изменение аудиоустройств!");

    // Делаем что-то только если звонок активен
    if (callState === "CONNECTED" && pc && localStream) {
        try {
            // Запрашиваем новый микрофон (браузер сам выберет активный по умолчанию)
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            const newTrack = newStream.getAudioTracks()[0];

            // Находим текущий аудио-поток, который отправляется собеседнику
            const sender = pc.getSenders().find((s) =>
                s.track?.kind === "audio"
            );

            if (sender) {
                // Горячая замена трека БЕЗ перезапуска звонка (без ICE Restart)
                await sender.replaceTrack(newTrack);

                // Обновляем наш локальный анализатор для визуализации волн
                localStream.getTracks().forEach((t) => t.stop()); // гасим старый микрофон
                localStream = newStream;

                if (audioContext && audioContext.state !== "closed") {
                    // Переподключаем визуализацию к новому микрофону
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
