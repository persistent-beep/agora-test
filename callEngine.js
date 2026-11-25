
class CallEngine extends EventTarget {
    constructor() {
        super(); // суперконструктор EventTarget

        // --- МАШИНА СОСТОЯНИЙ (FSM) ---
        this.states = Object.freeze({
            IDLE: "IDLE",
            RINGING_OUT: "RINGING_OUT",
            RINGING_IN: "RINGING_IN",
            AWAITING_OFFER: "AWAITING_OFFER",
            CONNECTING: "CONNECTING",
            CONNECTED: "CONNECTED",
            RECONNECTING: "RECONNECTING",
        });

        // Текущее состояние
        this._currentState = this.states.IDLE;

        // --- РЕСУРСЫ WEBRTC ---
        this.pc = null; // RTCPeerConnection
        this.localStream = null; // Поток нашего микрофона
        this.remoteAudioElement = null; // <audio> тег для звука собеседника
        this.audioContext = null; // для визуализации canvas
        this.localAnalyser = null;
        this.remoteAnalyser = null;
        this.iceQueue = []; // Очередь "ранних" кандидатов
        this.iceConfig = []; // Конфиг с серверов
        this.apiUrl = config.apiUrl;
        this.wsUrl = config.wsUrl;

        // --- СИГНАЛИНГ ---
        this.signalingSocket = null;
        this.pingInterval = null; // Используется для heartbeat
        this.reconnectTimeout = null;

        // --- ПЕРЕМЕННЫЕ ЗВОНКА ---
        this.currentCallTarget = null;
        this.pendingOfferSdp = null;
        this.isMuted = false;
        this.callTimerInterval = null;
        this.seconds = 0;
    }

    // ========== FSM: УПРАВЛЕНИЕ СОСТОЯНИЕМ ==========

    get currentState() {
        return this._currentState;
    }

    // Метод для смены состояния с валидацией (как setter в Python)
    _setState(newState) {
        if (this._currentState === newState) return; // Состояние не изменилось

        // Правила переходов (что из чего может следовать)
        const allowedTransitions = {
            [this.states.IDLE]: [
                this.states.RINGING_OUT,
                this.states.RINGING_IN,
            ],
            [this.states.RINGING_OUT]: [
                this.states.CONNECTING,
                this.states.IDLE,
            ],
            [this.states.RINGING_IN]: [
                this.states.AWAITING_OFFER,
                this.states.IDLE,
            ],
            [this.states.AWAITING_OFFER]: [
                this.states.CONNECTING,
                this.states.IDLE,
            ],
            [this.states.CONNECTING]: [
                this.states.CONNECTED,
                this.states.IDLE,
                this.states.RECONNECTING,
            ],
            [this.states.CONNECTED]: [
                this.states.IDLE,
                this.states.RECONNECTING,
            ],
            [this.states.RECONNECTING]: [
                this.states.CONNECTED,
                this.states.IDLE,
            ],
        };

        const allowed = allowedTransitions[this._currentState] || [];

        if (!allowed.includes(newState)) {
            console.error(
                `[FSM] ❌ Запрещенный переход: ${this._currentState} → ${newState}`,
            );
            return; // Игнорируем нелогичный запрос
        }

        const oldState = this._currentState;
        this._currentState = newState;
        console.log(`[FSM] ✅ Состояние: ${oldState} → ${newState}`);

        // Выбрасываем событие наружу! UI должен на него подписаться.
        this._emit("stateChanged", { oldState, newState });
    }

    // ========== HELPER: Отправка событий ==========

    // Упрощенный метод для dispatchEvent (вместо длинного new CustomEvent)
    _emit(eventName, detail = {}) {
        this.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
    // ========== ПУБЛИЧНЫЙ API (Что может вызывать UI) ==========
    // В Питоне это было бы: def start_call(self, target):

    // ========== СИГНАЛИНГ (WebSocket) ==========

    async connect(token) {
        this._token = token; // Сохраняем токен для реконнектов
        this._connectSignaling(token);
    }

    _connectSignaling(token) {
        if (this.pingInterval) clearInterval(this.pingInterval);

        this.signalingSocket = new WebSocket(
            `${this.wsUrl}/ws?token=${encodeURIComponent(token)}`,
        );

        this.signalingSocket.onopen = () => {
            console.log("[Engine] WS Connected");
            this._emit("socketConnected"); // Событие для UI (можно убрать индикатор "Нет сети")

            // Пинг
            this.pingInterval = setInterval(() => {
                if (this.signalingSocket?.readyState === WebSocket.OPEN) {
                    this._sendSignal({ type: "ping" });
                }
            }, 20000);
        };

        this.signalingSocket.onmessage = async (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "pong") return; // Игнорируем понги

            // Роутим сообщение в обработчик
            await this._handleSignalingMessage(msg);
        };

        this.signalingSocket.onclose = (event) => {
            clearInterval(this.pingInterval);
            console.log(`[Engine] WS Disconnected. Code: ${event.code}`);
            this._emit("socketDisconnected", { code: event.code });

            // Если ws упал во время звонка (кроме CONNECTED, там WebRTC живет сам по себе)
            if (
                this._currentState !== this.states.IDLE &&
                this._currentState !== this.states.CONNECTED
            ) {
                this.hangUp(); // Сбрасываем, если только пытались соединиться
            }

            // Реконнект через 3 секунды
            setTimeout(() => {
                if (this._token) this._connectSignaling(this._token);
            }, 3000);
        };

        this.signalingSocket.onerror = (err) => {
            console.error("[Engine] WS Error", err);
        };
    }

    async _handleSignalingMessage(msg) {
        switch (msg.type) {
            case "start_offer": {
                if (this._currentState !== this.states.RINGING_OUT) return;
                try {
                    const offer = await this.pc.createOffer();
                    await this.pc.setLocalDescription(offer);
                    this._sendSignal({
                        type: "offer",
                        target: this.currentCallTarget,
                        sdp: this.pc.localDescription.sdp,
                    });
                    this._setState(this.states.RINGING_OUT); // Обновляем UI на "RINGING"
                } catch (e) {
                    console.error("Offer creation failed:", e);
                    this.hangUp();
                }
                break;
            }

            case "incoming_call": {
                if (this._currentState !== this.states.IDLE) return; // Защита: уже в звонке

                this.currentCallTarget = msg.from;
                this._setState(this.states.RINGING_IN);
                this._fetchIceServers(); // Предзагрузка ICE в фоне

                // ВАЖНО: Мы не рисуем UI! Мы просто кричим наружу.
                this._emit("incomingCall", { from: msg.from });
                break;
            }

            case "offer": {
                if (this._currentState === this.states.CONNECTED) {
                    // ICE RESTART от собеседника
                    console.log("[Engine] Получен ICE Restart (offer)");
                    this._setState(this.states.RECONNECTING);
                    await this.pc.setRemoteDescription(
                        new RTCSessionDescription({
                            type: "offer",
                            sdp: msg.sdp,
                        }),
                    );
                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);
                    this._sendSignal({
                        type: "answer",
                        target: this.currentCallTarget,
                        sdp: this.pc.localDescription.sdp,
                    });
                } else if (this._currentState === this.states.AWAITING_OFFER) {
                    // Нормальный ответ на звонок
                    await this._processOfferAndAnswer(msg.sdp);
                } else if (
                    this._currentState === this.states.IDLE ||
                    this._currentState === this.states.RINGING_IN
                ) {
                    // Оффер пришел до того, как юзер нажал ANSWER (или ws-пуш опередил реакцию)
                    this.currentCallTarget = msg.from;
                    this._setState(this.states.RINGING_IN);
                    this.pendingOfferSdp = msg.sdp; // Сохраняем в буфер

                    this._emit("incomingCall", { from: msg.from }); // Просим UI отрисовать
                }
                break;
            }

            case "answer": {
                if (
                    this._currentState !== this.states.RINGING_OUT &&
                    this._currentState !== this.states.CONNECTING
                ) return;

                await this.pc.setRemoteDescription(
                    new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
                );
                await this._flushIceQueue();
                //this._onCallConnected(); // Вызовет смену состояния на CONNECTED
                break;
            }

            case "candidate": {
                if (this._currentState === this.states.IDLE) return; // Опоздавший кандидат
                if (this.pc) await this._addIceCandidate(msg.candidate);
                break;
            }

            case "peer_disconnected": {
                this.hangUp();
                break;
            }
        }
    }

    async startCall(target) {
        // 1. Проверка состояния (FSM в действии!)
        if (this._currentState !== this.states.IDLE) {
            console.warn("[Engine] Невозможно начать звонок, мы не в IDLE");
            return;
        }

        this.currentCallTarget = target;
        this._setState(this.states.RINGING_OUT); // Меняем состояние -> UI увидит это

        try {
            await this._setupAudio(); // Просим микрофон
            await this._createPeerConnection(); // Создаем RTCPeerConnection

            // Шлем сигнал серверу
            this._sendSignal({
                type: "call_request",
                target: this.currentCallTarget,
            });
        } catch (err) {
            console.error("[Engine] Ошибка старта:", err);
            this.hangUp(); // Если микрофон не дали - сбрасываем
        }
    }
    // === Обработка оффера ===
    async _processOfferAndAnswer(sdp) {
        this._setState(this.states.CONNECTING);
        await this.pc.setRemoteDescription(
            new RTCSessionDescription({ type: "offer", sdp }),
        );
        await this._flushIceQueue();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        this._sendSignal({
            type: "answer",
            target: this.currentCallTarget,
            sdp: this.pc.localDescription.sdp,
        });
        // this._onCallConnected();
    }

    // === Успешное соединение ===
    _onCallConnected() {
        this._setState(this.states.CONNECTED);
        this._startTimer(); // Запускаем таймер 00:00
    }

    async answer() {
        if (this._currentState !== this.states.RINGING_IN) return;

        this._setState(this.states.AWAITING_OFFER);

        try {
            await this._fetchIceServers(); // Предзагрузка ICE
            if (!this.localStream) await this._setupAudio();
            if (!this.pc) await this._createPeerConnection();

            this._sendSignal({
                type: "accept_call",
                target: this.currentCallTarget,
            });

            // Если оффер уже пришел и ждет в очереди, сразу обрабатываем
            if (this.pendingOfferSdp) {
                const sdp = this.pendingOfferSdp;
                this.pendingOfferSdp = null;
                await this._processOfferAndAnswer(sdp);
            }
        } catch (err) {
            console.error("[Engine] Ошибка ответа:", err);
            this.hangUp();
        }
    }

    hangUp() {
        if (this._currentState === this.states.IDLE) return;

        // Очищаем таймеры
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        // Шлем сигнал собеседнику, что мы кладем трубку
        if (
            this.signalingSocket?.readyState === WebSocket.OPEN &&
            this.currentCallTarget
        ) {
            this._sendSignal({
                type: "call_end",
                target: this.currentCallTarget,
            });
        }

        this._cleanupPeerConnection();
        this._setState(this.states.IDLE); // Возвращаемся в начало
    }

    toggleMute() {
        if (this._currentState !== this.states.CONNECTED || !this.localStream) {
            return;
        }

        this.isMuted = !this.isMuted;
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = !this.isMuted;

        // Уведомляем UI, что mute изменился (чтобы поменять цвет кнопки/графики)
        this._emit("muteChanged", { isMuted: this.isMuted });
    }

    // ========== ПРИВАТНЫЕ МЕТОДЫ (Внутренняя кухня) ==========
    // В JS нет строгих приватных методов как в Python (def _method),
    // но по договоренности мы используем знак подчеркивания _ в начале имени.
    // Современный JS поддерживает синтаксис #method, но _ - классика.

    async _setupAudio() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            // Восстанавливаем или создаем AudioContext (помнишь проблему с iOS?)
            if (!this.audioContext || this.audioContext.state === "closed") {
                this.audioContext =
                    new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.audioContext.state === "suspended") {
                await this.audioContext.resume(); // Разбудили для iOS
            }

            // Настройка визуализации
            this.localAnalyser = this.audioContext.createAnalyser();
            this.localAnalyser.fftSize = 256;
            this.audioContext.createMediaStreamSource(this.localStream).connect(
                this.localAnalyser,
            );
        } catch (err) {
            console.error("[Engine] Mic access denied:", err);
            this._emit("error", { message: "MIC_ACCESS_DENIED" });
            throw err; // Пробрасываем ошибку выше, чтобы startCall() её поймал
        }
    } // ========== УПРАВЛЕНИЕ ICE КАНДИДАТАМИ ==========
    async _addIceCandidate(candidate) {
        try {
            if (this.pc && this.pc.remoteDescription) {
                // Если оффер уже применен, добавляем кандидата сразу
                await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } else {
                // Иначе кладем в очередь
                this.iceQueue.push(candidate);
            }
        } catch (e) {
            console.error("[Engine] Error adding ICE candidate:", e);
        }
    }

    async _flushIceQueue() {
        // Вызывается после setRemoteDescription
        while (this.iceQueue.length) {
            try {
                await this.pc.addIceCandidate(
                    new RTCIceCandidate(this.iceQueue.shift()),
                );
            } catch (e) {
                console.error("[Engine] Error flushing ICE candidate:", e);
            }
        }
    }
    // ========== ЗАГРУЗКА КОНФИГА ==========
    async _fetchIceServers() {
        if (this.iceConfig.length > 0) return this.iceConfig; // Кэшируем

        try {
            // Предполагаем, что роль тоже передается в конфиге при создании движка
            const response = await fetch(
                `${this.apiUrl}/ice-servers?role=${
                    encodeURIComponent(this.userRole || "guest")
                }`,
            );
            const data = await response.json();
            this.iceConfig = data.iceServers;
        } catch (e) {
            console.error("[Engine] Ошибка ICE, используем резервный STUN:", e);
            this.iceConfig = [{ urls: "stun:stun.l.google.com:19302" }];
        }
        return this.iceConfig;
    }

    // === Создание PeerConnection (с обработкой обрывов) ===
    async _createPeerConnection() {
        await this._fetchIceServers();
        this.pc = new RTCPeerConnection({ iceServers: this.iceConfig });
        this.iceQueue = [];

        // Добавляем локальный аудиотрек
        if (this.localStream) {
            this.localStream.getTracks().forEach((track) =>
                this.pc.addTrack(track, this.localStream)
            );
        }

        // Приходят кандидаты от нас -> отправляем собеседнику
        this.pc.onicecandidate = (event) => {
            if (
                event.candidate &&
                this.signalingSocket?.readyState === WebSocket.OPEN
            ) {
                this._sendSignal({
                    type: "candidate",
                    target: this.currentCallTarget,
                    candidate: event.candidate,
                });
            }
        };

        // Приходит аудиопоток от собеседника
        this.pc.ontrack = (event) => {
            // Создаем невидимый <audio> элемент для воспроизведения
            if (this.remoteAudioElement) {
                this.remoteAudioElement.srcObject = null;
            }
            this.remoteAudioElement = new Audio();
            this.remoteAudioElement.srcObject = event.streams[0];
            this.remoteAudioElement.autoplay = true;
            this.remoteAudioElement.play().catch((e) =>
                console.log("Autoplay blocked", e)
            );

            // Подключаем анализатор громкости собеседника
            if (this.audioContext && this.audioContext.state !== "closed") {
                this.remoteAnalyser = this.audioContext.createAnalyser();
                this.remoteAnalyser.fftSize = 256;
                this.audioContext.createMediaStreamSource(event.streams[0])
                    .connect(this.remoteAnalyser);
            }

            this._emit("remoteStreamReady"); // UI может убрать иконку "нет звука"
        };

        // === МАГИЯ ICE RESTART И ОБРЫВОВ СЕТИ ===
        this.pc.oniceconnectionstatechange = async () => {
            console.log(`[Engine] ICE state → ${this.pc.iceConnectionState}`);

            if (
                this.pc.iceConnectionState === "connected" ||
                this.pc.iceConnectionState === "completed"
            ) {
                // Сеть восстановилась!
                if (this.reconnectTimeout) {
                    clearTimeout(this.reconnectTimeout);
                    this.reconnectTimeout = null;
                }
                if (this._currentState !== this.states.CONNECTED) {
                    //this._setState(this.states.CONNECTED); // Возвращаем из RECONNECTING
                    this._onCallConnected();
                }
            }

            if (
                this.pc.iceConnectionState === "disconnected" ||
                this.pc.iceConnectionState === "failed"
            ) {
                if (
                    this._currentState === this.states.CONNECTED ||
                    this._currentState === this.states.RECONNECTING
                ) {
                    this._setState(this.states.RECONNECTING);

                    // Таймер смерти (40 секунд)
                    if (!this.reconnectTimeout) {
                        this.reconnectTimeout = setTimeout(() => {
                            console.log(
                                "[Engine] Время реконнекта вышло. Сброс.",
                            );
                            this.hangUp();
                            this._emit("reconnectFailed"); // Событие для UI
                        }, 40000);
                    }

                    // Если обрыв инициировал наш браузер, пытаемся сделать ICE Restart
                    if (
                        this.pc.iceConnectionState === "disconnected" ||
                        this.pc.iceConnectionState === "failed"
                    ) {
                        try {
                            const offer = await this.pc.createOffer({
                                iceRestart: true,
                            });
                            await this.pc.setLocalDescription(offer);
                            this._sendSignal({
                                type: "offer",
                                target: this.currentCallTarget,
                                sdp: this.pc.localDescription.sdp,
                            });
                        } catch (err) {
                            console.error("ICE Restart error:", err);
                            this.hangUp();
                        }
                    }
                } else {
                    this.hangUp(); // Если обрыв на этапе подключения — просто сброс
                }
            }
        };
    }

    // ========== ОЧИСТКА РЕСУРСОВ ==========
    _cleanupPeerConnection() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.callTimerInterval) {
            clearInterval(this.callTimerInterval);
            this.callTimerInterval = null;
        }

        if (this.pc) {
            this.pc.onicecandidate = null; // Убираем листенеры
            this.pc.ontrack = null;
            this.pc.oniceconnectionstatechange = null;
            this.pc.close();
            this.pc = null;
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach((t) => t.stop());
            this.localStream = null;
        }

        if (this.remoteAudioElement) {
            this.remoteAudioElement.pause();
            this.remoteAudioElement.srcObject = null;
            this.remoteAudioElement = null;
        }

        // ВНИМАНИЕ: AudioContext мы НЕ закрываем! (проблема iOS)
        // Мы только обнуляем анализаторы.
        this.localAnalyser = null;
        this.remoteAnalyser = null;

        this.iceQueue = [];
        this.pendingOfferSdp = null;
        this.isMuted = false;
        this.currentCallTarget = null;
    }
    // ========== ТАЙМЕР ЗВОНКА ==========

    _startTimer() {
        this._stopTimer();
        this.seconds = 0;
        this._emit("timerTick", { seconds: this.seconds }); // Сразу 00:00

        this.callTimerInterval = setInterval(() => {
            this.seconds++;
            this._emit("timerTick", { seconds: this.seconds });
        }, 1000);
    }

    _stopTimer() {
        if (this.callTimerInterval) {
            clearInterval(this.callTimerInterval);
            this.callTimerInterval = null;
        }
    }
    // Вызвать этот метод один раз при инициализации движка
    _setupDeviceChangeListener() {
        navigator.mediaDevices.addEventListener("devicechange", async () => {
            console.log("[Engine] Обнаружено изменение аудиоустройств!");

            if (
                this._currentState === this.states.CONNECTED && this.pc &&
                this.localStream
            ) {
                try {
                    // 1. Запрашиваем новый поток
                    const newStream = await navigator.mediaDevices.getUserMedia(
                        {
                            audio: {
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true,
                            },
                        },
                    );
                    const newTrack = newStream.getAudioTracks()[0];

                    // 2. Ищем отправителя в текущем соединении
                    const sender = this.pc.getSenders().find((s) =>
                        s.track?.kind === "audio"
                    );

                    if (sender) {
                        // 3. ЗАМЕНЯЕМ трек
                        await sender.replaceTrack(newTrack);

                        // 4. ТОЛЬКО ТЕПЕРЬ глушим старый микрофон
                        this.localStream.getTracks().forEach((t) => t.stop());
                        this.localStream = newStream; // Обновляем ссылку

                        // Переподключаем визуализатор
                        if (
                            this.audioContext &&
                            this.audioContext.state !== "closed"
                        ) {
                            this.localAnalyser = this.audioContext
                                .createAnalyser();
                            this.localAnalyser.fftSize = 256;
                            this.audioContext.createMediaStreamSource(
                                this.localStream,
                            ).connect(this.localAnalyser);
                        }
                        console.log(
                            "[Engine] Микрофон успешно переключен на лету!",
                        );
                    }
                } catch (e) {
                    console.error(
                        "[Engine] Ошибка при смене аудиоустройства:",
                        e,
                    );
                }
            }
        });
    }

    _sendSignal(data) {
        if (this.signalingSocket?.readyState === WebSocket.OPEN) {
            this.signalingSocket.send(JSON.stringify(data));
        } else {
            console.warn(
                "[Engine] WebSocket не подключен, не могу отправить сигнал",
            );
        }
    }
}

// Обязательно выше script1
// <script src="callEngine.js">
