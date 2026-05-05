// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И СОСТОЯНИЯ ==========

let currentState = "HOME";
let currentCallTarget = null; // роль того, с кем идёт звонок

// Переменные для звонка
let callTimerInterval;
let animationFrameId;
let isCalling = false;
let isMuted = false;
let currentSource = "HEADPHONES"; // или 'SPEAKERS'
let seconds = 0;
let callTemplateCache = null;

// Объект состояний WebRTC
let pc = null;
let localStream = null;
let signalingSocket = null;
let iceConfig = null;
let incomingCallPending = false; // входящий звонок, ждём нажатия ANSWER
let awaitingOffer = false; // нажали ANSWER, ждём оффер для автоответа
//Аудио
let audioContext = null;
let analyser = null;
let dataArray = null;
let remoteAnalyser;
let remoteDataArray;
let remoteAudioElement = null;
let pendingOffer = null;

const logo = document.getElementById("logo");
const menu = document.getElementById("menu");
const contentArea = document.getElementById("content-area");
const moduleTitle = document.getElementById("module-title");
const moduleContent = document.getElementById("module-content");

const API_URL = "http://127.0.0.1:8000"; // Адрес твоего Python сервера
let userRole = "guest"; // Будет обновляться при логине

// ========== СЛУЖЕБНЫЕ/ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function debounce(func, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

// ========== ОСНОВНАЯ НАВИГАЦИЯ И УПРАВЛЕНИЕ СОСТОЯНИЕМ ==========
// --- ЛОГИКА НАВИГАЦИИ --- ЛОГИКА ПОВЕДЕНИЯ ЛОГОТИПА ---

function handleLogoClick() {
    const token = localStorage.getItem("agora_session");

    if (currentState === "HOME") {
        if (token) toMenu();
        else {
            renderAuthModule();
        }
    } else if (currentState === "MENU") {
        toHome();
    } else if (currentState === "AUTH") {
        toHome();
    } else {
        // Из любого места возвращаемся в меню
        stopCallSimulation(); // Остановить звонок если он идет
        if (token) toMenu();
        else toHome();
    }
}

function toMenu() {
    if (!localStorage.getItem("agora_session")) {
        toHome();
        return;
    }

    currentState = "MENU";
    logo.className = "logo-side";
    menu.classList.add("menu-visible");
    contentArea.classList.remove("content-visible");
}

function toHome() {
    currentState = "HOME";
    logo.className = "logo-center";
    menu.classList.remove("menu-visible");
    contentArea.classList.remove("content-visible");
}
// --- УНИВЕРСАЛЬНАЯ ФУНКЦИЯ ДЛЯ МОДУЛЕЙ ---
function openModule(title, text) {
    currentState = "CONTENT";
    menu.classList.remove("menu-visible");
    moduleTitle.innerText = title;

    if (title === "PLAY") {
        const template = document.getElementById("template-logout");
        moduleContent.innerHTML = template.innerHTML;
    } else {
        moduleContent.innerHTML = `<div class="placeholder">${text}</div>`;
    }
    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}

// ========== АВТОРИЗАЦИЯ И АУТЕНТИФИКАЦИЯ ==========
// отрисовка модуля авторизации
function renderAuthModule() {
    currentState = "AUTH";
    logo.className = "logo-side"; // logo slide left
    moduleTitle.innerText = ""; // cleance of header

    const template = document.getElementById("template-auth");
    moduleContent.innerHTML = template.innerHTML;

    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}
// change auth button to enter
function updateAuthBtn() {
    const input = document.getElementById("auth-token");
    const btn = document.getElementById("btn-auth-submit");
    if (input.value.length > 0) {
        btn.innerText = "SUBMIT";
    } else {
        btn.innerText = "GUEST";
    }
}
// Заглушка для отправки (пока без Python)
async function handleAuthSubmit() {
    const input = document.getElementById("auth-token");
    const btn = document.getElementById("btn-auth-submit");
    const tokenValue = input.value || "guest"; // если пусто - заходим как гость

    try {
        const response = await fetch(
            "https://exorable-nonmetrical-sena.ngrok-free.dev/auth/login",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: tokenValue }),
            },
        );

        if (response.ok) {
            const data = await response.json();
            const session = {
                token: tokenValue,
                contacts: data.contacts,
                role: data.role,
                userRole: data.role,
            };
            localStorage.setItem("agora_session", JSON.stringify(session));
            if (signalingSocket) signalingSocket.close();
            connectSignaling(tokenValue);
            toMenu();
        } else {
            input.style.borderColor = "#ff4a4a";
            input.value = "";
            input.placeholder = "ACCESS_DENIED";
        }
    } catch (error) {
        console.error("server_offline", error);
        input.placeholder = "SERVER_OFFLINE";
    }
}
// end of handle auth
//функция логаут
function handleLogout() {
    if (signalingSocket) signalingSocket.close();
    localStorage.removeItem("agora_session");
    location.reload();
}

// --- ЛОГИКА МОДУЛЯ CONNECT ---// ========== МОДУЛЬ CONNECT И РАБОТА С КОНТАКТАМИ ==========
// 1. Показать список контактов
// Получение текущей роли из localStorage и отрисовка модуля

function renderConnectModule() {
    currentState = "CONTENT";
    menu.classList.remove("menu-visible");
    moduleTitle.innerText = "CONNECT";

    //clone template
    const template = document.getElementById("template-contacts");
    const clone = template.content.cloneNode(true);
    const listContainer = clone.getElementById("dynamic-contact-list");

    // получаем данные из localstorage
    const sessionData = JSON.parse(
        localStorage.getItem("agora_session") || "{}",
    );
    const contacts = sessionData.contacts;
    // проверка на null, undefiend или {}
    if (!contacts || (Array.isArray(contacts) && contacts.length === 0)) {
        const noAccess = document.createElement("div");
        noAccess.className = "placeholder";
        noAccess.style.color = "#444";
        noAccess.textContent = "NO TARGETS";
        listContainer.appendChild(noAccess);
    } else { // Походу если пришло одно слово оно перестает быть массивом
        const contactsArray = Array.isArray(contacts)
            ? contacts
            : contacts.split(",");

        contactsArray.forEach((contactName) => {
            const btn = document.createElement("div");
            btn.className = "contact-item";
            btn.textContent = contactName.trim().toUpperCase();
            btn.onclick = () => initCallInterface(contactName.trim());
            listContainer.appendChild(btn);
        });
    }
    //its set up
    moduleContent.innerHTML = "";
    moduleContent.appendChild(clone);

    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}

// ========== МОДУЛЬ ЗВОНКОВ И АУДИО ИНТЕРФЕЙС ==========
//  Инициализация интерфейса звонка
function initCallInterface(name) {
    currentCallTarget = name.trim();
    moduleTitle.innerText = name; // Имя контакта в заголовок

    if (!callTemplateCache) {
        // находим шаблон для ui
        const template = document.getElementById("template-call-ui");
        callTemplateCache = template.innerHTML;
    }
    // Шаблон интерфейса copied
    moduleContent.innerHTML = callTemplateCache;
    // сброс состояний анимаций
    isCalling = false;
    isMuted = false;
    seconds = 0;
    updateCanvasDimensions();
    //start animations
    startWaveAnimation();
}
// Функция для получения ICE-серверов с бэкенда
async function fetchIceServers() {
    try {
        const response = await fetch(
            `${API_URL}/ice-servers?role=${encodeURIComponent(userRole)}`,
        );
        const data = await response.json();
        iceConfig = data.iceServers;
    } catch (e) {
        console.error("Ошибка получения ICE конфигурации:", e);
        // Резервный STUN на случай сбоя
        iceConfig = [{ urls: "stun:stun.l.google.com:19302" }];
    }
}
// --- ЛОГИКА ЗВОНКА И ИНТЕРАКТИВА ---
async function toggleCallAction() {
    const btn = document.getElementById("btn-action");
    const statusEl = document.getElementById("call-status");
    if (incomingCallPending) {
        try {
            // Отправляем сигнал, чтобы звонящий начал создавать оффер
            signalingSocket.send(JSON.stringify({
                type: "accept_call",
                target: currentCallTarget,
            }));

            // Готовимся к звонку
            if (!localStream) await setupAudio();
            if (!pc) await createPeerConnection();

            incomingCallPending = false;
            awaitingOffer = true;

            btn.innerText = "CONNECTING...";
            btn.className = "btn-large btn-blue";
            btn.disabled = true; // пока не получим оффер
            statusEl.innerText = "WAITING FOR OFFER";
            statusEl.style.color = "#aaa";
        } catch (err) {
            console.error(err);
            statusEl.innerText = "ERROR";
            stopCall();
        }
        return;
    }
    if (pendingOffer) {
        console.log("[Action] Answering incoming call...");
        try {
            if (!localStream) await setupAudio();
            if (!pc) await createPeerConnection();
            // 1. Принимаем данные звонящего
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: "offer", sdp: pendingOffer }),
            );

            // 2. Создаем ответ
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // 3. Отправляем ответ серверу
            //странная отправка ответа не пойму зачем
            signalingSocket.send(JSON.stringify({
                type: "accept_call",
                target: currentCallTarget, // тот, кто звонил
                sdp: answer.sdp,
            }));

            // 4. Обновляем UI: мы теперь в разговоре
            pendingOffer = null; // Сбрасываем флаг входящего
            awaitingOffer = false;
            isCalling = true; // Включаем флаг активного звонка

            btn.innerText = "END CALL";
            btn.className = "btn-large btn-red"; // Красная для сброса
            btn.disabled = false;
            statusEl.innerText = "CONNECTED";
            statusEl.style.color = "#4aff4a";

            startTimer();
        } catch (err) {
            console.error("Error answering call:", err);
            statusEl.innerText = "ANSWER FAILED";
            stopCall();
        }
        return; // Выходим, чтобы не идти дальше по коду
    }
    if (!isCalling) {
        try {
            if (!currentCallTarget) {
                statusEl.innerText = "NO TARGET";
                return;
            }
            // Проверка авторизации
            const sessionData = JSON.parse(
                localStorage.getItem("agora_session") || "{}",
            );
            if (!sessionData.token) {
                statusEl.innerText = "AUTH REQUIRED";
                renderAuthModule();
                return;
            }

            statusEl.innerText = "CONNECTING...";

            // 1. Получаем ICE серверы
            await fetchIceServers();

            // 2. Получаем микрофон с улучшенными настройками
            await setupAudio(); // Используем существующую функцию

            await createPeerConnection();

            signalingSocket.send(JSON.stringify(
                { type: "call_request", target: currentCallTarget },
            ));

            isCalling = true; // вот этот параметр тут нужет?
            btn.className = "btn-large btn-red"; // Лучше менять класс, чем style
            statusEl.innerText = "CONNECTION";
            startTimer();
        } catch (err) {
            console.error("call error", err);
            statusEl.innerText = err.message.includes("microphone")
                ? "MIC ACCESS DENIED"
                : "CONNECTION FAILED";
            statusEl.style.color = "#ff4a4a";
            //stopCall();
            return;
        }
    } else {
        // ЗАВЕРШИТЬ ЗВОНОК
        stopCall();
        // Возврат к списку контактов через секунду
        setTimeout(renderConnectModule, 1000);
    }
}

function endCall() {
    isCalling = false;
    stopTimer();
    const btn = document.getElementById("btn-action");
    const statusEl = document.getElementById("call-status");

    btn.innerText = "CALL";
    btn.className = "btn-large btn-green";
    statusEl.innerText = "ENDED";
    statusEl.style.color = "#ff4a4a";
    statusEl.classList.remove("blink");
}

function toggleMute() {
    if (!isCalling) return; // Нельзя мутить если не звоним (опционально)

    isMuted = !isMuted;
    const micCanvas = document.getElementById("mic-canvas");
    const statusEl = document.getElementById("call-status");

    if (isMuted) {
        micCanvas.classList.add("muted-border");
        statusEl.innerText = "MUTED";
        statusEl.style.color = "yellow";
    } else {
        micCanvas.classList.remove("muted-border");
        statusEl.innerText = "CONNECTED";
        statusEl.style.color = "#4aff4a";
    }
}
// flip animation for sound source
function toggleSource() {
    const cube = document.getElementById("source-cube");

    // Переключаем класс переворота
    cube.classList.toggle("is-flipped");

    // Обновляем логическую переменную
    if (currentSource === "HEADPHONES") {
        currentSource = "SPEAKERS";
        // Текст не меняем, он прописан в HTML самой грани куба
    } else {
        currentSource = "HEADPHONES";
    }
}

function activateVosklet() {
    // Функция для кнопки VOSKLET (заглушка)
    console.log("Vosklet activated");
}

// ========== WebRTC И СИГНАЛИНГ ==========

function getRoomId(userA, userB) {
    return [userA, userB].sort().join("_");
}

//function initSignaling(roomId) {
//    return new Promise((resolve, reject) => {
//        const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
//        signalingSocket = new WebSocket(
//            `${wsProtocol}://${window.location.host}/ws/${roomId}`,
//        );
//        signalingSocket.onopen = () => {
//            console.log("[Signal] Connected to room:", roomId);
//            resolve();
//        }; // просто сообщение в консоль для отслеживания
//        signalingSocket.onerror = (err) => {
//            console.error("[Signal] SOCKET ERROR", err);
//            reject(err);
//        };
//
//        signalingSocket.onmessage = async (event) => {
//            const message = JSON.parse(event.data);
//            await handleSignalingMessage(message);
//        }; // обработчик сообщений от питона
//
//        signalingSocket.onclose = (event) => console.log("disconnected");
//        // обработчик события обрыва с переподключением можно вывести на экран
//    });
//}
// Функция подключения сигналинга
function connectSignaling(token) {
    const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
    signalingSocket = new WebSocket(
        `${wsProtocol}://${location.host}/ws?token=${
            encodeURIComponent(token)
        }`,
    );

    signalingSocket.onopen = () => {
        console.log("[Signal] Connected as", token);
    };

    signalingSocket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        await handleSignalingMessage(message);
    };

    signalingSocket.onclose = (event) => {
        console.log("[Signal] Disconnected", event.reason);
        // Если сессия ещё валидна, можно попробовать переподключиться через таймаут
    };

    signalingSocket.onerror = (err) => {
        console.error("[Signal] Error", err);
    };
}
async function createPeerConnection() {
    pc = new RTCPeerConnection({
        iceServers: iceConfig || [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // 1. Отправляем свои ICE кандидаты, когда они находятся
    pc.onicecandidate = (event) => {
        if (event.candidate && signalingSocket?.readyState === WebSocket.OPEN) {
            signalingSocket.send(JSON.stringify({
                type: "candidate",
                target: currentCallTarget,
                candidate: event.candidate,
            }));
        }
    };

    // 2. Обработка входящего потока (звук собеседника)
    pc.ontrack = (event) => {
        console.log("Remote track received");
        // Используем ваш код для воспроизведения
        if (remoteAudioElement) remoteAudioElement.srcObject = null;
        remoteAudioElement = new Audio();
        remoteAudioElement.srcObject = event.streams[0];
        remoteAudioElement.autoplay = true;
        remoteAudioElement.play().catch((e) =>
            console.log("Autoplay blocked", e)
        );

        // Визуализация (если нужно)
        if (audioContext && audioContext.state !== "closed") {
            const source = audioContext.createMediaStreamSource(
                event.streams[0],
            );
            remoteAnalyser = audioContext.createAnalyser();
            remoteAnalyser.fftSize = 256;
            source.connect(remoteAnalyser);
            remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);
        }
    };

    // 3. Добавляем свой микрофон в соединение
    if (localStream) {
        localStream.getTracks().forEach((track) =>
            pc.addTrack(track, localStream)
        );
    }

    console.log("PeerConnection initialized");
}
async function handleSignalingMessage(message) {
    switch (message.type) {
        case "start_offer": {
            // Сервер сказал: "Вы первый, начинайте звонок"
            console.log("[Signal] Creating Offer...");
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                signalingSocket.send(
                    JSON.stringify({
                        type: "offer",
                        target: currentCallTarget,
                        sdp: offer.sdp,
                    }),
                );
            } catch (e) {
                console.error("Offer error", e);
            }
            break;
        }
        case "incoming_call":
            // Входящий звонок: показываем UI, сохраняем pendingOffer = true
            console.log("[Signal] Incoming call from", message.from);
            currentCallTarget = message.from; // от кого звонок
            // Отображаем интерфейс звонка с кнопкой ANSWER
            renderCallInterfaceFromIncoming(message.from); // см. ниже
            break;

        case "offer": {
            console.log("[Signal] Offer received");
            if (awaitingOffer) {
                // Мы уже нажали ANSWER и ждём оффер – отвечаем автоматически
                pendingOffer = message.sdp; // временно сохраним для единообразного ответа
                // Вызываем тот же код, что и в ветке pendingOffer, но без клика
                try {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription({
                            type: "offer",
                            sdp: pendingOffer,
                        }),
                    );
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    signalingSocket.send(JSON.stringify({
                        type: "answer",
                        target: currentCallTarget,
                        sdp: answer.sdp,
                    }));
                    pendingOffer = null;
                    awaitingOffer = false;
                    isCalling = true;
                    const btn = document.getElementById("btn-action");
                    if (btn) {
                        btn.innerText = "END CALL";
                        btn.className = "btn-large btn-red";
                        btn.disabled = false;
                    }
                    const statusEl = document.getElementById("call-status");
                    if (statusEl) {
                        statusEl.innerText = "CONNECTED";
                        statusEl.style.color = "#4aff4a";
                    }
                    startTimer();
                } catch (e) {
                    console.error("Auto-answer failed", e);
                    stopCall();
                }
            } else {
                // Обычное ожидание – пользователь ещё не нажал ANSWER
                pendingOffer = message.sdp;
                const statusEl = document.getElementById("call-status");
                if (statusEl) {
                    statusEl.innerText = "INCOMING CALL";
                    statusEl.style.color = "#ff9900";
                    statusEl.classList.add("blink");
                }
                const btn = document.getElementById("btn-action");
                if (btn) {
                    btn.innerText = "ANSWER";
                    btn.className = "btn-large btn-green";
                    btn.disabled = false;
                }
            }
            break;
        }

        case "answer": {
            // Наш Offer приняли.
            console.log("[Signal] Received Answer");
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: "answer", sdp: message.sdp }),
            );
            document.getElementById("call-status").innerText = "CONNECTED";
            startTimer();
            break;
        }

        case "candidate": {
            // Настроили сетевой маршрут
            try {
                await pc.addIceCandidate(
                    new RTCIceCandidate(message.candidate),
                );
            } catch (e) {
                console.error("ICE Candidate Error", e);
            }
            break;
        }

        case "peer_disconnected":
            stopCall();
            alert("Peer disconnected");
            break;
    }
}
function renderCallInterfaceFromIncoming(callerName) {
    // Используем тот же UI, что и для исходящего, но с кнопкой ANSWER
    initCallInterface(callerName);
    incomingCallPending = true;
    awaitingOffer = false;
    pendingOffer = null;

    const btn = document.getElementById("btn-action");
    if (btn) {
        btn.innerText = "ANSWER";
        btn.className = "btn-large btn-green";
    }
    const statusEl = document.getElementById("call-status");
    if (statusEl) {
        statusEl.innerText = "INCOMING CALL";
        statusEl.style.color = "#ff9900";
    }
    // Запускаем анимацию
    startWaveAnimation();
}

function stopCall() {
    if (signalingSocket && currentCallTarget) {
        signalingSocket.send(JSON.stringify({
            type: "call_end",
            target: currentCallTarget,
        }));
    }
    pendingOffer = null;
    incomingCallPending = false;
    awaitingOffer = false;
    if (pc) {
        pc.close();
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }
    //if (signalingSocket) {
    //    signalingSocket.close();
    //    signalingSocket = null;
    //}
    if (remoteAudioElement) {
        remoteAudioElement.pause();
        remoteAudioElement.srcObject = null;
        remoteAudioElement = null;
    }
    // Возвращаем UI в состояние ожидания
    stopCallSimulation(); // Ваша старая функция для очистки анимации
    console.log("Звонок завершен");
}
// --- ТАЙМЕР ---
function startTimer() {
    stopTimer();
    seconds = 0;
    const timerEl = document.getElementById("call-timer");
    callTimerInterval = setInterval(() => {
        seconds++;
        const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
        const secs = (seconds % 60).toString().padStart(2, "0");
        timerEl.innerText = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(callTimerInterval);
}

// --- ВИЗУАЛИЗАЦИЯ (CANVAS) ---
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
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(localStream);

        analyser.fftSize = 256;
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        source.connect(analyser);

        console.log("Микрофон захвачен успешно");
    } catch (err) {
        console.error("Доступ к микрофону запрещен:", err);
        dataArray = new Uint8Array(128);
    }
}

function stopCallSimulation() {
    isCalling = false;
    stopTimer();
    cancelAnimationFrame(animationFrameId);
}

function startWaveAnimation() {
    const ctxRemote = document.getElementById("remote-canvas").getContext("2d");
    const ctxMic = document.getElementById("mic-canvas").getContext("2d");

    // Функция рисования волны
    function draw(ctx, color, active, volumeData) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Настройки
        ctx.fillStyle = color;
        const bars = 80; // вот тут бы поиграть количеством
        const barWidth = w / bars;

        for (let i = 0; i < bars; i++) {
            // Если звонок идет, берем данные из анализатора, иначе 0
            const val = active ? volumeData[i] || 0 : 0;
            // Рассчитываем высоту (минимум 2 пикселя для "линии жизни")
            const barHeight = (val / 255) * h * 0.9 + 2;
            const x = i * barWidth;
            const y = (h - barHeight) / 2;

            ctx.fillRect(x, y, barWidth - 2, barHeight);
        }
    }

    function loop() {
        if (currentState !== "CONTENT") {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
            return;
        }
        // 1. Получаем данные своего микрофона
        if (analyser && !isMuted && dataArray) {
            analyser.getByteFrequencyData(dataArray);
        } else if (dataArray) {
            dataArray.fill(0); // Тишина, если выключен микрофон
        }

        // 2. Получаем данные собеседника
        if (remoteAnalyser && remoteDataArray) {
            remoteAnalyser.getByteFrequencyData(remoteDataArray);
        } else if (remoteDataArray) {
            remoteDataArray.fill(0);
        }

        // Цвет входящего (верхний) - #a0a0a0 или активный
        draw(ctxRemote, "#a0a0a0", isCalling, remoteDataArray || []);

        // Цвет исходящего (нижний) - зависит от Mute
        const micColor = isMuted ? "#552222" : "#a0a0a0";
        draw(ctxMic, micColor, isCalling, dataArray);

        animationFrameId = requestAnimationFrame(loop);
    }
    loop();
}

// ========== PWA И SERVICE WORKER ==========

// Регистрация Service Worker для PWA
if ("serviceWorker" in navigator) {
    self.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js")
            .then((registration) => {
                console.log("[SW] Зарегистрирован:", registration.scope);
            })
            .catch((error) => {
                console.error("[SW] Ошибка регистрации:", error);
            });
    });
}

// Проверка поддержки PWA и предложение установки
let deferredPrompt;

self.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Можно показать кнопку "Установить приложение"
    // showInstallPromotion();
});

// Отслеживание установки
self.addEventListener("appinstalled", () => {
    console.log("[PWA] Приложение установлено");
    deferredPrompt = null;
});
// ========== ИНИЦИАЛИЗАЦИЯ И ОБРАБОТЧИКИ СОБЫТИЙ ==========
window.addEventListener("resize", debounce(updateCanvasDimensions, 100));
window.addEventListener("load", () => {
    const session = JSON.parse(localStorage.getItem("agora_session") || "{}");
    if (session.token) {
        connectSignaling(session.token);
    }
});
