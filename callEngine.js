class CallEngine extends EventTarget {
    constructor() {
        super(); // Обязательно вызываем суперконструктор EventTarget

        // --- МАШИНА СОСТОЯНИЙ (FSM) ---
        // Это как Enum в Питоне. Жестко задаем возможные состояния.
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

    async connect(token) {
        // Подключение к сигнальному серверу
        this._connectSignaling(token);
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
            await this._setupAudio();            // Просим микрофон
            await this._createPeerConnection();  // Создаем RTCPeerConnection
            
            // Шлем сигнал серверу
            this._sendSignal({ type: "call_request", target: this.currentCallTarget });

        } catch (err) {
            console.error("[Engine] Ошибка старта:", err);
            this.hangUp(); // Если микрофон не дали - сбрасываем
        }
    }

    async answer() {
        if (this._currentState !== this.states.RINGING_IN) return;
        
        this._setState(this.states.AWAITING_OFFER);
        
        try {
            await this._fetchIceServers(); // Предзагрузка ICE
            if (!this.localStream) await this._setupAudio();
            if (!this.pc) await this._createPeerConnection();

            this._sendSignal({ type: "accept_call", target: this.currentCallTarget });

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
        if (this.signalingSocket?.readyState === WebSocket.OPEN && this.currentCallTarget) {
            this._sendSignal({ type: "call_end", target: this.currentCallTarget });
        }

        this._cleanupPeerConnection();
        this._setState(this.states.IDLE); // Возвращаемся в начало
    }

    toggleMute() {
        if (this._currentState !== this.states.CONNECTED || !this.localStream) return;

        this.isMuted = !this.isMuted;
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = !this.isMuted;

        // Уведомляем UI, что mute изменился (чтобы поменять цвет кнопки/графики)
        this._emit('muteChanged', { isMuted: this.isMuted });
    }

    // ========== ПРИВАТНЫЕ МЕТОДЫ (Внутренняя кухня) ==========
    // В JS нет строгих приватных методов как в Python (def _method), 
    // но по договоренности мы используем знак подчеркивания _ в начале имени.
    // Современный JS поддерживает синтаксис #method, но _ - классика.

    async _setupAudio() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });

            // Восстанавливаем или создаем AudioContext (помнишь проблему с iOS?)
            if (!this.audioContext || this.audioContext.state === "closed") {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.audioContext.state === "suspended") {
                await this.audioContext.resume(); // Разбудили для iOS
            }

            // Настройка визуализации
            this.localAnalyser = this.audioContext.createAnalyser();
            this.localAnalyser.fftSize = 256;
            this.audioContext.createMediaStreamSource(this.localStream).connect(this.localAnalyser);

        } catch (err) {
            console.error("[Engine] Mic access denied:", err);
            this._emit('error', { message: "MIC_ACCESS_DENIED" });
            throw err; // Пробрасываем ошибку выше, чтобы startCall() её поймал
        }
    }

    async _createPeerConnection() {
        await this._fetchIceServers();
        this.pc = new RTCPeerConnection({ iceServers: this.iceConfig });
        this.iceQueue = [];

        // Передаем треки собеседнику
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => this.pc.addTrack(track, this.localStream));
        }

        // Коллбэки RTCPeerConnection
        this.pc.onicecandidate = (event) => { ... };
        this.pc.ontrack = (event) => { ... };
        this.pc.oniceconnectionstatechange = () => { ... }; // Сюда мы вставим ICE Restart
    }

    _cleanupPeerConnection() {
        if (this.pc) { this.pc.close(); this.pc = null; }
        if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
        // ... очистка remoteAudio, таймеров и т.д.
    }

    _sendSignal(data) {
        if (this.signalingSocket?.readyState === WebSocket.OPEN) {
            this.signalingSocket.send(JSON.stringify(data));
        } else {
            console.warn("[Engine] WebSocket не подключен, не могу отправить сигнал");
        }
    }
}
}

// Обязательно выше script1
// <script src="callEngine.js">
