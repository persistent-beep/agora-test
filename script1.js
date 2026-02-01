let currentState = "HOME";

// Переменные для звонка
let callTimerInterval;
let animationFrameId;
let isCalling = false;
let isMuted = false;
let currentSource = "HEADPHONES"; // или 'SPEAKERS'
let seconds = 0;

const logo = document.getElementById("logo");
const menu = document.getElementById("menu");
const contentArea = document.getElementById("content-area");
const moduleTitle = document.getElementById("module-title");
const moduleContent = document.getElementById("module-content");

// --- ЛОГИКА НАВИГАЦИИ --- ЛОГИКА ПОВЕДЕНИЯ ЛОГОТИПА ---

function handleLogoClick() {
    const token = localStorage.getItem("agora_token");

    if (currentState === "HOME") {
        if (token) toMenu();
        else {
            renderAuthModule();
        }
    } else if (currentState === "MENU") {
        toHome();
    } else {
        // Из любого места возвращаемся в меню
        stopCallSimulation(); // Остановить звонок если он идет
        toMenu();
    }
}

function toMenu() {
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
    if (input.value.lenght > 0) {
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
            "http://127.0.0.1:8000/auth/login",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: tokenValue }),
            },
        );

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem("agora_token", data.access_token);
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
} // end of handle auth

// --- УНИВЕРСАЛЬНАЯ ФУНКЦИЯ ДЛЯ ПРОСТЫХ МОДУЛЕЙ ---
function openModule(title, text) {
    currentState = "CONTENT";
    menu.classList.remove("menu-visible");
    moduleTitle.innerText = title;

    if (title === "PLAY") {
        moduleContent.innerHTML = `
            <div class="logout-section">
                <div class="placeholder" style="margin-bottom: 30px;">${text}</div>
                <button class="btn-large btn-red" onclick="handleLogout()" style="width: 100%; max-width: 400px;">TERMINATE SESSION (LOGOUT)</button>
            </div>`;
    } else {
        moduleContent.innerHTML = `<div class="placeholder">${text}</div>`;
    }
    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}
//функция логаут

function handleLogout() {
    localStorage.removeItem("agora_token");
    location.reload();
}

// --- ЛОГИКА МОДУЛЯ CONNECT ---

// 1. Показать список контактов
function renderConnectModule() {
    currentState = "CONTENT";
    menu.classList.remove("menu-visible");
    moduleTitle.innerText = "CONNECT";

    //clone template
    const template = document.getElementById("template-contacts");
    //its set up
    moduleContent.innerHTML = template.innerHTML;

    setTimeout(() => {
        contentArea.classList.add("content-visible");
    }, 300);
}

// 2. Инициализация интерфейса звонка

let callTemplateCache = null;

function initCallInterface(name) {
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

// --- ЛОГИКА ЗВОНКА И ИНТЕРАКТИВА ---

function toggleCallAction() {
    const btn = document.getElementById("btn-action");
    const statusEl = document.getElementById("call-status");

    if (!isCalling) {
        // НАЧАТЬ ЗВОНОК
        isCalling = true;
        btn.innerText = "END CALL";
        btn.className = "btn-large btn-red";
        statusEl.innerText = "CALLING...";

        // Имитация соединения через 1.5 сек
        setTimeout(() => {
            if (isCalling) {
                statusEl.innerText = "CONNECTED";
                statusEl.style.color = "#4aff4a"; // Светло-зеленый текст
                startTimer();
            }
        }, 1500);
    } else {
        // ЗАВЕРШИТЬ ЗВОНОК
        endCall();
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

function stopCallSimulation() {
    isCalling = false;
    stopTimer();
    cancelAnimationFrame(animationFrameId);
}

function startWaveAnimation() {
    const ctxRemote = document.getElementById("remote-canvas").getContext("2d");
    const ctxMic = document.getElementById("mic-canvas").getContext("2d");

    // Функция рисования волны
    function draw(ctx, color, active, isMutedState) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Настройки
        ctx.fillStyle = color;
        const bars = 50;
        const barWidth = w / bars;

        for (let i = 0; i < bars; i++) {
            let barHeight;

            if (active && !isMutedState) {
                // Случайная высота для эффекта голоса
                // Если статус CONNECTED - высота большая, если нет - маленькая "шум"
                const multiplier =
                    document.getElementById("call-status").innerText ===
                            "CONNECTED"
                        ? 0.8
                        : 0.1;
                barHeight = Math.random() * h * multiplier;
            } else {
                // Тишина (полоска по центру)
                barHeight = 2;
            }

            const x = i * barWidth;
            const y = (h - barHeight) / 2;

            ctx.fillRect(x, y, barWidth - 2, barHeight);
        }
    }

    function loop() {
        // Цвет входящего (верхний) - #a0a0a0 или активный
        draw(ctxRemote, "#a0a0a0", isCalling, false);

        // Цвет исходящего (нижний) - зависит от Mute
        const micColor = isMuted ? "#552222" : "#a0a0a0";
        draw(ctxMic, micColor, isCalling, isMuted);

        animationFrameId = requestAnimationFrame(loop);
    }
    loop();
}

// Следим за ресайзом окна для канваса

function debounce(func, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

self.addEventListener("resize", debounce(updateCanvasDimensions, 100));

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
