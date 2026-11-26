import os
import json
import time
import uuid
import asyncio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pywebpush import webpush, WebPushException
from supabase import create_client, Client

load_dotenv()

app = FastAPI()

# [FIX] os.path.realpath('main.py') зависит от текущей рабочей директории:
# при запуске не из папки проекта (uvicorn main:app из корня, systemd, Docker)
# base_path становился неверным и /index + /static ломались. __file__ — нет.
base_path = os.path.dirname(os.path.abspath(__file__))


# Разрешаем корс
app.add_middleware(
    CORSMiddleware,
    allow_origins = ['*'],
    allow_methods = ['*'],
    allow_headers = ['*'],
)

class AuthRequest(BaseModel):
    token: str

class PushSubscriptionRequest(BaseModel):
    subscription: dict

class DeclineCallRequest(BaseModel):
    caller: str
    target: str

# Настройки Supabase и VAPID из .env
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
# [FIX] Если VAPID_SUB_EMAIL не задан, раньше получался невалидный "mailto:None",
# из-за которого падала вся отправка пушей.
VAPID_CLAIMS = {"sub": f"mailto:{os.getenv('VAPID_SUB_EMAIL', 'admin@example.com')}"}


supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Заменяем старый ConnectionManager на UserManager
class UserManager:
    def __init__(self):
        # user_id (role) → WebSocket
        self.online: dict[str, WebSocket] = {}

    async def connect_user(self, user_id: str, ws: WebSocket):
        # Если уже был онлайн с другого устройства — отключаем старый
        old_ws = self.online.get(user_id)
        if old_ws is not None and old_ws is not ws:
            try:
                await old_ws.close(code=4002, reason="replaced_by_new_session")
            except Exception:
                pass
        await ws.accept()
        self.online[user_id] = ws

    # [FIX RC-6] ГЛАВНАЯ СЕРВЕРНАЯ ГОНКА (race condition):
    # раньше disconnect_user(user_id) безусловно делал pop(user_id).
    # Сценарий: юзер переподключился → connect_user закрыл старый ws и
    # записал новый → finally старого хендлера сработал ПОЗЖЕ и выкинул
    # из словаря НОВЫЙ сокет → юзер числился оффлайн, звонки уходили
    # в push вместо WS. Теперь удаляем запись только если в словаре лежит
    # именно закрывающийся сокет.
    def disconnect_user(self, user_id: str, ws: WebSocket):
        if self.online.get(user_id) is ws:
            self.online.pop(user_id, None)

    def get_user_ws(self, user_id: str) -> WebSocket | None:
        return self.online.get(user_id)

user_manager = UserManager()

# [CALL REGISTRY] Реестр активных звонков (в памяти).
# call_id генерирует СЕРВЕР — клиентскому ID доверять нельзя.
# Отсюда: занятость (busy), call_id в сообщениях, уведомление партнёра
# при закрытии вкладки, и защита от «хвостов» старого звонка.
# Оговорка: при рестарте процесса (Render free tier засыпает) реестр
# теряется — медиа (ICE) продолжит идти напрямую, а вот мгновенное
# уведомление о закрытии вкладки для тех звонков уже не придёт.
class CallRegistry:
    def __init__(self):
        # call_id → {"caller", "callee", "state": RINGING|ACTIVE, "ts"}
        self.calls: dict[str, dict] = {}
        # user_id → call_id (у юзера один звонок одновременно)
        self.user_calls: dict[str, str] = {}

    def _purge(self, call_id: str) -> dict | None:
        call = self.calls.pop(call_id, None)
        if call:
            # Чистим индекс только если он указывает на ЭТОТ звонок
            # (защита от выкидывания более свежей записи — та же гонка,
            # что и в UserManager.disconnect_user).
            if self.user_calls.get(call["caller"]) == call_id:
                self.user_calls.pop(call["caller"], None)
            if self.user_calls.get(call["callee"]) == call_id:
                self.user_calls.pop(call["callee"], None)
        return call

    def cleanup_stale(self, ttl: float = 120.0) -> list:
        """Убирает зависшие RINGING-звонки (звонили, никто не взял,
        call_end потерялся). ACTIVE не трогаем — их закрывает
        WS-finally при разрыве. Возвращает список (call_id, call),
        чтобы вызывающий код мог погасить push-баннеры этих звонков."""
        purged = []
        now = time.time()
        for call_id in list(self.calls.keys()):
            call = self.calls[call_id]
            if call["state"] == "RINGING" and now - call["ts"] > ttl:
                self._purge(call_id)
                purged.append((call_id, call))
        return purged

    def call_of(self, user_id: str) -> tuple[str | None, dict | None]:
        """Звонок, в котором участвует юзер: (call_id, call) или (None, None)."""
        call_id = self.user_calls.get(user_id)
        if call_id is None:
            return None, None
        call = self.calls.get(call_id)
        if call is None:
            # Битый индекс — чиним на месте
            self.user_calls.pop(user_id, None)
            return None, None
        return call_id, call

    def create(self, caller: str, callee: str) -> str:
        call_id = uuid.uuid4().hex[:12]
        self.calls[call_id] = {
            "caller": caller,
            "callee": callee,
            "state": "RINGING",
            "ts": time.time(),
        }
        self.user_calls[caller] = call_id
        self.user_calls[callee] = call_id
        return call_id

    def activate(self, call_id: str):
        call = self.calls.get(call_id)
        if call:
            call["state"] = "ACTIVE"
            call["ts"] = time.time()

    def end_for_user(self, user_id: str) -> tuple[str, str, dict | None] | None:
        """Заканчивает звонок юзера. Возвращает (call_id, partner_id, call)
        или None, если юзер не в звонке. Словарь звонка нужен вызывающему
        коду, чтобы понять: сбросили ДО ответа (RINGING) или ПОСЛЕ (ACTIVE)."""
        call_id, call = self.call_of(user_id)
        if not call:
            return None
        self._purge(call_id)
        partner = call["callee"] if call["caller"] == user_id else call["caller"]
        return call_id, partner, call

call_registry = CallRegistry()

# Проверка токена (используем ту же логику, что и в /auth/login)
def get_user_from_token(token: str) -> dict | None:
    # [FIX] Битый USERS_JSON в .env раньше ронял каждый запрос 500-й ошибкой
    try:
        users = json.loads(os.getenv("USERS_JSON", "{}"))
    except json.JSONDecodeError:
        print("[AUTH] USERS_JSON повреждён — проверьте .env")
        return None
    return users.get((token or "").lower().strip())

# Функция получения конфига TURN для конкретной роли
def get_ice_servers(role: str):
    # [FIX] role могла быть None/пустой → IndexError на .split()[0].
    # Также убраны фейковые креды "default_user"/"default_pass": если
    # конфигурации для роли нет — отдаём только публичный STUN.
    role = (role or "").strip()
    env_prefix = role.split()[0].upper() if role else "GUEST"

    username = os.getenv(f"{env_prefix}_USER")
    credential = os.getenv(f"{env_prefix}_PASS")
    domain = os.getenv("TURN")

    if not (domain and username and credential):
        return [{"urls": "stun:stun.l.google.com:19302"}]

    return [
        { "urls": f"stun:stun.relay.metered.ca:80"},
        {
            "urls": [
                f"turn:{domain}:80",
                f"turn:{domain}:80?transport=tcp",
                f"turn:{domain}:443",
                f"turn:{domain}:443?transport=tcp"
            ],
            "username": username,
            "credential": credential
        },
        {
            "urls": f"turns:{domain}:443?transport=tcp",
            "username": username,
            "credential": credential
        }
    ]

# [FIX] Безопасная отправка: раньше send_json в протухший сокет цели
# кидал исключение ВНУТРИ хендлера отправителя и обрывал ЕГО websocket.
async def _safe_send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False

# [PUSH-ALWAYS] Отправка push юзеру по всем его подпискам.
# True — хотя бы одна доставка прошла; False — подписок нет или все упали.
async def _send_push_to_user(user_id: str, payload: dict, ttl: int = 45) -> bool:
    try:
        response = supabase.table("push_subs").select("sub_data").eq("user_id", user_id).execute()
    except Exception as e:
        print(f"[PUSH] Не удалось прочитать подписки {user_id}: {e}")
        return False

    if not response.data:
        return False

    headers = {
        "Urgency": "high",
        # Topic = collapse key: на Android push с тем же топиком заменяет
        # предыдущий (звонок отменили — «Пропущенный» сменит «Входящий»)
        "Topic": "incoming-calls",
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-expiration": "45"
    }

    sent_any = False
    for row in response.data:
        sub_data = row.get("sub_data") if isinstance(row, dict) else None
        if not sub_data:
            continue
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info=sub_data,
                data=json.dumps(payload),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS,
                ttl=ttl,
                headers=headers,
            )
            sent_any = True
        except WebPushException as e:
            print(f"[PUSH] Ошибка отправки {user_id}: {e}")
            # [FIX] Мёртвая подписка (410/404) — удаляем из БД,
            # иначе она будет вечно висеть и валить отправку.
            status = None
            if getattr(e, "response", None) is not None:
                status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                try:
                    dead_endpoint = (sub_data or {}).get("endpoint")
                    if dead_endpoint:
                        supabase.table("push_subs") \
                            .delete() \
                            .eq("sub_data->>endpoint", dead_endpoint) \
                            .execute()
                except Exception as del_e:
                    print(f"[PUSH] Не удалось удалить мёртвую подписку: {del_e}")
    return sent_any

# Эндпоинт для сохранения подписки от браузера
@app.post("/push/subscribe")
async def save_push_subscription(data: PushSubscriptionRequest, token: str = Query(...)):
    user_info = get_user_from_token(token)
    if not user_info:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        print(f"[Push] Сохраняю подписку для user_id={user_info['role']}")
        res = supabase.table("push_subs").upsert(
            {
                "user_id": user_info["role"],
                "sub_data": data.subscription,
            },
            on_conflict="user_id",
        ).execute()

        if hasattr(res, 'error') and res.error:
            raise Exception(f"Supabase error: {res.error}")
        print("[Push] Успешно сохранено")
        return {"status": "ok"}

    except Exception as e:
        print(f"[Push] Первая попытка не удалась ({e}), пробую upsert без on_conflict")
        try:
            supabase.table("push_subs").delete().eq("user_id", user_info["role"]).execute()
            res = supabase.table("push_subs").insert({
                "user_id": user_info["role"],
                "sub_data": data.subscription,
            }).execute()
            if hasattr(res, 'error') and res.error:
                raise Exception(f"Supabase insert error: {res.error}")
            print("[Push] Успешно сохранено (замена)")
            return {"status": "ok"}
        except Exception as inner_e:
            print(f"[Push] Полная ошибка: {inner_e}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Push subscription failed: {inner_e}")

# Эндпоинт для удаления подписки при выходе из аккаунта
@app.post("/push/unsubscribe")
async def unsubscribe_push(data: dict, token: str = Query(...)):
    user_info = get_user_from_token(token)
    if not user_info:
        raise HTTPException(status_code=401)

    endpoint = data.get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="Missing endpoint")

    supabase.table("push_subs") \
        .delete() \
        .eq("sub_data->>endpoint", endpoint) \
        .execute()

    return {"status": "ok"}

# Маршрутизация сообщений
async def handle_signal_message(sender_id: str, message: dict, sender_ws: WebSocket):
    msg_type = message.get("type")

    # Подчищаем зависшие RINGING-звонки при каждом сообщении
    # (реестр крошечный, итерация бесплатна).
    # [PUSH-CANCEL] Заодно гасим push-баннеры этих звонков: requireInteraction
    # держит «Входящий вызов» на экране, пока юзер не тапнет — а звонок мёртв.
    for stale_id, stale_call in call_registry.cleanup_stale():
        await _send_push_to_user(stale_call["callee"], {
            "title": "Пропущенный вызов",
            "body": f"{stale_call['caller']} — звонок отменён",
            "caller": stale_call["caller"],
            "target": stale_call["callee"],
            "call_id": stale_id,
            "type": "CALL_CANCELLED",
        })

    if msg_type == "call_request":
        # [FIX] message["target"] при отсутствии поля кидал KeyError,
        # который обрывал websocket ЗВОНЯЩЕГО (общий except в цикле).
        target = message.get("target")
        if not target or target == sender_id:
            return

        # [RETRY] Сначала разбираемся с СОБСТВЕННЫМ старым звонком звонящего —
        # ДО busy-проверки цели! Иначе повторный звонок тому же абоненту
        # (retry после потерянного call_end) получал busy от СВОЕГО ЖЕ
        # зависшего RINGING-звонка. Активный разговор не трогаем: случайный
        # call_request посреди беседы не должен перезапускать живой звонок.
        my_call_id, my_call = call_registry.call_of(sender_id)
        if my_call and my_call["state"] == "ACTIVE":
            # Звонящий уже разговаривает — это рассинхрон клиента,
            # вежливо отказываем, разговор продолжает жить
            await _safe_send(sender_ws, {"type": "busy"})
            return
        if my_call:
            # RINGING-хвост: прибиваем, старого партнёра оповещаем
            stale = call_registry.end_for_user(sender_id)
            if stale:
                stale_id, stale_partner, _stale_call = stale
                stale_ws = user_manager.get_user_ws(stale_partner)
                if stale_ws:
                    await _safe_send(stale_ws, {
                        "type": "peer_disconnected",
                        "call_id": stale_id,
                    })
                # Старый callee не ответил — у него висит баннер, гасим
                # (новый INCOMING_CALL, если звонят снова ему же, просто
                # заменит его тем же тегом)
                await _send_push_to_user(stale_partner, {
                    "title": "Пропущенный вызов",
                    "body": f"{sender_id} — звонок отменён",
                    "caller": sender_id,
                    "target": stale_partner,
                    "call_id": stale_id,
                    "type": "CALL_CANCELLED",
                })

        # [BUSY] Цель уже в звонке (RINGING или ACTIVE) — сразу отказ,
        # звонящий не висит 60 секунд в RINGING.
        _, target_call = call_registry.call_of(target)
        if target_call:
            print(f"[Call] {target} занят — отказ {sender_id}")
            await _safe_send(sender_ws, {"type": "busy"})
            return

        # [CALL_ID] Регистрируем звонок ДО доставки: без записи в реестре
        # accept_call из push-холодного старта не нашёл бы, что активировать.
        call_id = call_registry.create(sender_id, target)

        target_ws = user_manager.get_user_ws(target)
        delivered = False
        if target_ws is not None:
            delivered = await _safe_send(target_ws, {
                "type": "incoming_call",
                "from": sender_id,
                "call_id": call_id,
                "room_id": f"{sender_id}_{target}"   # для совместимости, если нужно
            })
            if not delivered:
                # [FIX] Протухший сокет в словаре — чистим и считаем цель оффлайн
                user_manager.disconnect_user(target, target_ws)

        if delivered:
            # [CALL_ID] Сообщаем ЗВОНЯЩЕМУ его же call_id — теперь он тоже
            # может отфильтровывать хвосты чужих звонков.
            await _safe_send(sender_ws, {
                "type": "call_created",
                "call_id": call_id,
                "target": target,
            })

        # [PUSH-ALWAYS] Раньше push уходил ТОЛЬКО если у цели не было сокета.
        # Но на Android свёрнутое приложение замерзает (tab freezing):
        # JS не выполняется, а TCP-сокет для сервера ЖИВ. Сервер считал
        # юзера «онлайн», отправлял incoming_call в пустоту (send_json в
        # замороженную вкладку не падает!) и не слал push. Теперь push
        # уходит ВСЕГДА параллельно с WS-доставкой, а service worker на
        # месте решает: страница видна — переслать WAKE_UP_CALL без
        # уведомления, скрыта/замерзла — показать уведомление.
        push_ok = await _send_push_to_user(target, {
            "title": "Входящий вызов",
            "body": f"{sender_id} вызывает вас...",
            "caller": sender_id,
            "target": target,
            "call_id": call_id,
            "type": "INCOMING_CALL",
        })

        if not delivered and not push_ok:
            # Абонент вообще недоступен (ни сокета, ни подписки) —
            # откатываем регистрацию звонка
            print(f"[Call] {target} недоступен: нет ни WS, ни push-подписки")
            call_registry._purge(call_id)
            await _safe_send(sender_ws, {"type": "peer_disconnected"})

    elif msg_type == "accept_call":
        target = message.get("target")
        call_id, call = call_registry.call_of(sender_id)

        # [CALL_ID] Звонок истёк (TTL) или реестр потерян при рестарте —
        # не даём принимающему висеть в AWAITING_OFFER.
        if (
            not call or
            call["callee"] != sender_id or
            (target and call["caller"] != target)
        ):
            await _safe_send(sender_ws, {"type": "peer_disconnected"})
            return

        # Защита от двойного нажатия ANSWER / дубликата accept_call
        if call["state"] == "ACTIVE":
            return

        call_registry.activate(call_id)

        caller_ws = user_manager.get_user_ws(call["caller"])
        if caller_ws:
            ok = await _safe_send(caller_ws, {
                "type": "start_offer",
                "target": sender_id,   # тому, кто звонил, говорим начинать
                "call_id": call_id,
            })
            if not ok:
                # Звонящий исчез, пока звонок звонел
                call_registry._purge(call_id)
                await _safe_send(sender_ws, {"type": "peer_disconnected"})
        else:
            call_registry._purge(call_id)
            await _safe_send(sender_ws, {"type": "peer_disconnected"})

    elif msg_type in ("offer", "answer", "candidate"):
        target = message.get("target")
        if target:
            target_ws = user_manager.get_user_ws(target)
            if target_ws:
                # Добавляем поле from для идентификации отправителя
                forwarded = {**message, "from": sender_id}
                # [CALL_ID] Штампуем из реестра (сервер — источник истины).
                # Нет записи (рестарт сервера) — релеим без call_id,
                # клиент тогда фильтрует по from (легаси-путь).
                call_id, _call = call_registry.call_of(sender_id)
                if call_id:
                    forwarded["call_id"] = call_id
                await _safe_send(target_ws, forwarded)

    elif msg_type == "call_end":
        # [CALL_ID] call_end работает ТОЛЬКО через реестр: сервер сам знает,
        # кому слать peer_disconnected. Клиентский call_id не используется —
        # доверять ему нельзя.
        ended = call_registry.end_for_user(sender_id)
        if ended:
            call_id, partner, ended_call = ended
            partner_ws = user_manager.get_user_ws(partner)
            if partner_ws:
                await _safe_send(partner_ws, {
                    "type": "peer_disconnected",
                    "call_id": call_id,
                })
            # [PUSH-CANCEL] Звонящий повесил трубку ДО ответа: у callee на
            # телефоне висит requireInteraction-баннер «Входящий вызов»,
            # который сам не исчезнет. Тихий push CALL_CANCELLED заставит
            # service worker погасить его и показать «Пропущенный вызов».
            if (
                ended_call and
                ended_call["state"] == "RINGING" and
                ended_call["caller"] == sender_id
            ):
                await _send_push_to_user(partner, {
                    "title": "Пропущенный вызов",
                    "body": f"{sender_id} отменил звонок",
                    "caller": sender_id,
                    "target": partner,
                    "call_id": call_id,
                    "type": "CALL_CANCELLED",
                })
        # Если записи нет (рестарт) — сознательно НИЧЕГО не делаем:
        # слепой релей по target мог бы убить ДЕЙСТВУЮЩИЙ звонок
        # другого юзера с таким же именем.

@app.post("/auth/login")
async def login(data: AuthRequest):
    token = data.token.lower().strip()

    users = json.loads(os.getenv("USERS_JSON","{}"))
    user = users.get(token)
    contacts = json.loads(os.getenv("ACCESS_MATRIX","{}"))
    addressee = contacts.get(token)

    if not user:
        raise HTTPException(status_code=401, detail="INVALID_TOKEN")

    return {
        "status": "success",
        "contacts": addressee,
        "role": user["role"],
        "display_name": user["display_name"]
    }

@app.post("/call/decline")
async def decline_call(data: DeclineCallRequest):
    # Отклонение из push-уведомления. Ищем звонок между этими двумя
    # участниками в реестре (кто из них звонивший — проверяем по полям).
    call_id = None
    reg_id, call = call_registry.call_of(data.target)
    if call and call["caller"] == data.caller and call["callee"] == data.target:
        call_id = reg_id
        call_registry._purge(reg_id)
    else:
        # Fallback: реестр пуст (рестарт) — пробуем по звонящему напрямую
        reg_id2, call2 = call_registry.call_of(data.caller)
        if call2 and call2["callee"] == data.target:
            call_id = reg_id2
            call_registry._purge(reg_id2)

    caller_ws = user_manager.get_user_ws(data.caller)
    if caller_ws:
        payload = {"type": "peer_disconnected"}
        if call_id:
            payload["call_id"] = call_id
        await _safe_send(caller_ws, payload)
        print(f"[Call] Звонок от {data.caller} был отклонен пользователем {data.target} через Push")
    return {"status": "ok"}

# Маршрут для получения ICE-серверов
@app.get("/ice-servers")
async def get_ice_config(role: str = "guest", token: str = Query(None)):
    # [FIX SECURITY] Раньше эндпоинт был ПОЛНОСТЬЮ без авторизации: кто угодно
    # мог получить TURN-кредиты, просто указав ?role=admin. Теперь без
    # валидного токена отдаём только публичный STUN, а роль TURN-аккаунта
    # берём из токена (клиентский параметр role игнорируется).
    user_info = get_user_from_token(token) if token else None
    if not user_info:
        return {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}

    try:
        servers = get_ice_servers(user_info.get("role") or "guest")
        return {"iceServers": servers}
    except Exception as e:
        print(f"error gen {e}")
        return {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}


# WebSocket endpoint
@app.websocket("/ws")
async def websocket_call(websocket: WebSocket, token: str = Query("guest")):
    user_info = get_user_from_token(token)
    if not user_info:
        await websocket.close(code=4001, reason="Invalid token")
        return

    user_id = user_info["role"]
    await user_manager.connect_user(user_id, websocket)

    try:
        while True:
            # Ждем сообщение от клиента.
            # Если тишина больше 40 секунд — считаем клиента мертвым
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=40.0)
            except asyncio.TimeoutError:
                print(f"[WS] Таймаут пинга от {user_id}. Убиваем зомби-соединение.")
                break

            # Обработка пинга-понга (НЕ пускаем это в основную логику звонков)
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            # Если это не пинг — отправляем в основную маршрутизацию
            await handle_signal_message(user_id, data, websocket)

    except WebSocketDisconnect:
        # Клиент отключился нормально (например, закрыл вкладку)
        pass
    except Exception as e:
        # Случайная ошибка (например, отправили кривой JSON)
        print(f"[WS] Ошибка у {user_id}: {e}")
    finally:
        # [FIX RC-6] Передаём сам сокет: запись будет удалена только если
        # в словаре всё ещё лежит ОН (а не его более свежая замена).
        user_manager.disconnect_user(user_id, websocket)

        # [TAB-CLOSE] Юзер закрыл вкладку / убил приложение / потерял сеть
        # во время звонка — мгновенно сообщаем партнёру. Раньше партнёр
        # звонил в пустоту до собственного таймаута.
        ended = call_registry.end_for_user(user_id)
        if ended:
            call_id, partner, _ended_call = ended
            print(f"[WS] {user_id} оборвал соединение посреди звонка — оповещаем {partner}")
            partner_ws = user_manager.get_user_ws(partner)
            if partner_ws:
                await _safe_send(partner_ws, {
                    "type": "peer_disconnected",
                    "call_id": call_id,
                })

@app.post("/debug/push-error")
async def debug_push_error(request: Request):
    try:
        data = await request.json()
        log_line = f"[PUSH_DEBUG] {json.dumps(data, ensure_ascii=False)}"

        print(log_line, flush=True)

        return {"status": "logged"}
    except Exception as e:
        print(f"[PUSH_DEBUG_ERROR] {e}", flush=True)
        return {"status": "error"}

@app.get("/index")
async def getindex():
    return FileResponse(os.path.join(base_path, 'index.html'))

app.mount("/static", StaticFiles(directory=base_path), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
