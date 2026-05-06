// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И СОСТОЯНИЯ ==========
let currentState = "HOME";
let currentCallTarget = null;
let callTemplateCache = null;

let callTimerInterval;
let animationFrameId;
let isMuted = false;
let currentSource = "HEADPHONES";
let seconds = 0;

let isTerminating = false;
let isCalling = false;
let incomingCallPending = false;
let awaitingOffer = false;

let pc = null;
let localStream = null;
let signalingSocket = null;
let iceConfig = null;
let pendingOffer = null;

let audioContext = null;
let analyser = null;
let dataArray = null;
let remoteAnalyser;
let remoteDataArray;
let remoteAudioElement = null;

const logo = document.getElementById("logo");
const menu = document.getElementById("menu");
const contentArea = document.getElementById("content-area");
const moduleTitle = document.getElementById("module-title");
const moduleContent = document.getElementById("module-content");

const BACKEND_URL = "https://agora-service.onrender.com";
const API_URL = "https://agora-service.onrender.com";
let userRole = "guest";
const WS_URL = BACKEND_URL.replace(/^http/, "ws");

// ========== СЛУЖЕБНЫЕ ФУНКЦИИ ==========
function debounce(func, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

// ========== ОСНОВНАЯ НАВИГАЦИЯ ==========
function handleLogoClick() {
    const token = localStorage.getItem("agora_session");

    if (currentState === "HOME") {
        if (token) toMenu();
        else renderAuthModule();
    } else if (currentState === "MENU") {
        toHome();
    } else if (currentState === "AUTH") {
        toHome();
    } else {
        // Из любого места возвращаемся в меню, корректно завершая звонок
        if (currentState === "CONTENT") {
            if (incomingCallPending || awaitingOffer) {
                cancelIncomingCall();
            }
            if (isCalling) {
                stopCall();
            }
            stopCallSimulation();
        }
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

function openModule(title, text) {
    // При переходе в другой модуль завершаем активный звонок
    if (currentState === "CONTENT" && isCalling) {
        stopCall();
    }
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

// ========== АВТОРИЗАЦИЯ ==========
function renderAuthModule() {
    currentState = "AUTH";
    logo.className = "logo-side";
    moduleTitle.innerText = "";
    const template = document.getElementById("template-auth");
    moduleContent.innerHTML = template.innerHTML;
    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}

function updateAuthBtn() {
    const input = document.getElementById("auth-token");
    const btn = document.getElementById("btn-auth-submit");
    btn.innerText = input.value.length > 0 ? "SUBMIT" : "GUEST";
}

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
            const session = {
                token: tokenValue,
                contacts: data.contacts,
                role: data.role,
                userRole: data.role,
            };
            userRole = data.role;
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

function handleLogout() {
    if (signalingSocket) signalingSocket.close();
    localStorage.removeItem("agora_session");
    location.reload();
}

// ========== МОДУЛЬ CONNECT ==========
function renderConnectModule() {
    currentState = "CONTENT";
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
        const noAccess = document.createElement("div");
        noAccess.className = "placeholder";
        noAccess.style.color = "#444";
        noAccess.textContent = "NO TARGETS";
        listContainer.appendChild(noAccess);
    } else {
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

    moduleContent.innerHTML = "";
    moduleContent.appendChild(clone);
    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}

// ========== ИНТЕРФЕЙС ЗВОНКА ==========
function initCallInterface(name) {
    isTerminating = false;
    currentCallTarget = name.trim();
    moduleTitle.innerText = name;

    if (!callTemplateCache) {
        const template = document.getElementById("template-call-ui");
        callTemplateCache = template.innerHTML;
    }
    moduleContent.innerHTML = callTemplateCache;
    isCalling = false;
    isMuted = false;
    seconds = 0;
    updateCanvasDimensions();
    startWaveAnimation();
}

async function fetchIceServers() {
    try {
        const response = await fetch(
            `${API_URL}/ice-servers?role=${encodeURIComponent(userRole)}`,
        );
        const data = await response.json();
        iceConfig = data.iceServers;
    } catch (e) {
        console.error("Ошибка получения ICE конфигурации:", e);
        iceConfig = [{ urls: "stun:stun.l.google.com:19302" }];
    }
}

async function toggleCallAction() {
    const btn = document.getElementById("btn-action");
    const statusEl = document.getElementById("call-status");

    // ----- Обработка входящего звонка (нажата ANSWER) -----
    if (incomingCallPending) {
        try {
            signalingSocket.send(JSON.stringify({
                type: "accept_call",
                target: currentCallTarget,
            }));

            if (!localStream) await setupAudio();
            if (!pc) await createPeerConnection();

            incomingCallPending = false;
            awaitingOffer = true;

            btn.innerText = "CONNECTING...";
            btn.className = "btn-large btn-blue";
            btn.disabled = true;
            statusEl.innerText = "WAITING FOR OFFER";
            statusEl.style.color = "#aaa";
        } catch (err) {
            console.error(err);
            statusEl.innerText = "ERROR";
            stopCall();
        }
        return;
    }

    // ----- Если уже есть ожидающий оффер (маловероятно, но возможно) -----
    if (pendingOffer) {
        console.log("[Action] Answering incoming call...");
        try {
            if (!localStream) await setupAudio();
            if (!pc) await createPeerConnection();
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: "offer", sdp: pendingOffer }),
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
            btn.innerText = "END CALL";
            btn.className = "btn-large btn-red";
            btn.disabled = false;
            statusEl.innerText = "CONNECTED";
            statusEl.style.color = "#4aff4a";
            startTimer();
        } catch (err) {
            console.error("Error answering call:", err);
            statusEl.innerText = "ANSWER FAILED";
            stopCall();
        }
        return;
    }

    // ----- Начало нового исходящего звонка -----
    if (!isCalling) {
        try {
            if (!currentCallTarget) {
                statusEl.innerText = "NO TARGET";
                return;
            }
            const sessionData = JSON.parse(
                localStorage.getItem("agora_session") || "{}",
            );
            if (!sessionData.token) {
                statusEl.innerText = "AUTH REQUIRED";
                renderAuthModule();
                return;
            }
            statusEl.innerText = "CONNECTING...";
            await fetchIceServers();
            await setupAudio();
            await createPeerConnection();
            signalingSocket.send(
                JSON.stringify({
                    type: "call_request",
                    target: currentCallTarget,
                }),
            );
            btn.innerText = "CALLING>>>";
            btn.className = "btn-large btn-blue";
            btn.disabled = true;
            statusEl.innerText = "CONNECTION";
        } catch (err) {
            console.error("call error", err);
            statusEl.innerText = err.message.includes("microphone")
                ? "MIC ACCESS DENIED"
                : "CONNECTION FAILED";
            statusEl.style.color = "#ff4a4a";
            if (pc) {
                pc.close();
                pc = null;
            }
            if (localStream) {
                localStream.getTracks().forEach((t) => t.stop());
                localStream = null;
            }
        }
        return;
    }

    // ----- Завершение активного звонка -----
    stopCall();
    setTimeout(renderConnectModule, 1000);
}

function toggleMute() {
    if (!isCalling) return;
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

function toggleSource() {
    const cube = document.getElementById("source-cube");
    cube.classList.toggle("is-flipped");
    currentSource = currentSource === "HEADPHONES" ? "SPEAKERS" : "HEADPHONES";
}

function activateVosklet() {
    console.log("Vosklet activated");
}

// ========== WebRTC И СИГНАЛИНГ ==========
function getRoomId(userA, userB) {
    return [userA, userB].sort().join("_");
}

function connectSignaling(token) {
    const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
    signalingSocket = new WebSocket(
        `${WS_URL}/ws?token=${encodeURIComponent(token)}`,
    );

    signalingSocket.onopen = () => console.log("[Signal] Connected as", token);
    signalingSocket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        await handleSignalingMessage(message);
    };
    signalingSocket.onclose = (event) =>
        console.log("[Signal] Disconnected", event.reason);
    signalingSocket.onerror = (err) => console.error("[Signal] Error", err);
}

async function createPeerConnection() {
    pc = new RTCPeerConnection({
        iceServers: iceConfig || [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
        if (event.candidate && signalingSocket?.readyState === WebSocket.OPEN) {
            signalingSocket.send(JSON.stringify({
                type: "candidate",
                target: currentCallTarget,
                candidate: event.candidate,
            }));
        }
    };

    pc.ontrack = (event) => {
        console.log("Remote track received");
        if (remoteAudioElement) remoteAudioElement.srcObject = null;
        remoteAudioElement = new Audio();
        remoteAudioElement.srcObject = event.streams[0];
        remoteAudioElement.autoplay = true;
        remoteAudioElement.play().catch((e) =>
            console.log("Autoplay blocked", e)
        );

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

    if (localStream) {
        localStream.getTracks().forEach((track) =>
            pc.addTrack(track, localStream)
        );
    }
}

async function handleSignalingMessage(message) {
    switch (message.type) {
        case "start_offer": {
            console.log("[Signal] Creating Offer...");
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                signalingSocket.send(JSON.stringify({
                    type: "offer",
                    target: currentCallTarget,
                    sdp: offer.sdp,
                }));
                const statusEl = document.getElementById("call-status");
                if (statusEl) statusEl.innerText = "RINGING>>>";
            } catch (e) {
                console.error("Offer error", e);
            }
            break;
        }
        case "incoming_call": {
            console.log("[Signal] Incoming call from", message.from);
            currentCallTarget = message.from;
            renderCallInterfaceFromIncoming(message.from);
            break;
        }
        case "offer": {
            console.log("[Signal] Offer received");
            if (awaitingOffer) {
                pendingOffer = message.sdp;
                try {
                    if (!localStream) await setupAudio();
                    if (!pc) await createPeerConnection();
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
            console.log("[Signal] Received Answer");
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: "answer", sdp: message.sdp }),
            );
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
            break;
        }
        case "candidate": {
            try {
                await pc.addIceCandidate(
                    new RTCIceCandidate(message.candidate),
                );
            } catch (e) {
                console.error("ICE Candidate Error", e);
            }
            break;
        }
        case "peer_disconnected": {
            stopCall();
            alert("Peer disconnected");
            break;
        }
    }
}

function renderCallInterfaceFromIncoming(callerName) {
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
    startWaveAnimation();
}

function stopCall() {
    if (isTerminating) return;
    isTerminating = true;
    if (signalingSocket && currentCallTarget) {
        signalingSocket.send(
            JSON.stringify({ type: "call_end", target: currentCallTarget }),
        );
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
    if (remoteAudioElement) {
        remoteAudioElement.pause();
        remoteAudioElement.srcObject = null;
        remoteAudioElement = null;
    }
    stopCallSimulation();
    console.log("Звонок завершен");
}

function cancelIncomingCall() {
    if (incomingCallPending || awaitingOffer) {
        if (signalingSocket && currentCallTarget) {
            signalingSocket.send(
                JSON.stringify({ type: "call_end", target: currentCallTarget }),
            );
        }
        incomingCallPending = false;
        awaitingOffer = false;
        pendingOffer = null;
        if (pc) {
            pc.close();
            pc = null;
        }
        if (localStream) {
            localStream.getTracks().forEach((t) => t.stop());
            localStream = null;
        }
    }
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

// --- ВИЗУАЛИЗАЦИЯ ---
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

    function draw(ctx, color, active, volumeData) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = color;
        const bars = 80;
        const barWidth = w / bars;

        for (let i = 0; i < bars; i++) {
            const val = active ? (volumeData[i] || 0) : 0;
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
        if (analyser && !isMuted && dataArray) {
            analyser.getByteFrequencyData(dataArray);
        } else if (dataArray) {
            dataArray.fill(0);
        }
        if (remoteAnalyser && remoteDataArray) {
            remoteAnalyser.getByteFrequencyData(remoteDataArray);
        } else if (remoteDataArray) {
            remoteDataArray.fill(0);
        }
        draw(ctxRemote, "#a0a0a0", isCalling, remoteDataArray || []);
        draw(ctxMic, isMuted ? "#552222" : "#a0a0a0", isCalling, dataArray);
        animationFrameId = requestAnimationFrame(loop);
    }
    loop();
}

// ========== PWA ==========
if ("serviceWorker" in navigator) {
    self.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js")
            .then((reg) => console.log("[SW] Зарегистрирован:", reg.scope))
            .catch((err) => console.error("[SW] Ошибка регистрации:", err));
    });
}

let deferredPrompt;
self.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
});
self.addEventListener("appinstalled", () => {
    console.log("[PWA] Приложение установлено");
    deferredPrompt = null;
});

// ========== ИНИЦИАЛИЗАЦИЯ ==========
window.addEventListener("resize", debounce(updateCanvasDimensions, 100));
window.addEventListener("load", () => {
    const session = JSON.parse(localStorage.getItem("agora_session") || "{}");
    if (session.token) {
        connectSignaling(session.token);
    }
});
