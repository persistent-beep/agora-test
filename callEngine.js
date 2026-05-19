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
}

// Обязательно выше script1
// <script src="callEngine.js">
