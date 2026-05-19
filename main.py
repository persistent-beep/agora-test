import os
import json
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

base_path = os.path.dirname(os.path.realpath('main.py'))


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

# BIHSLdqb6TI9eFBKl5bCV2-WTTLVpXxoluqhudCaxFktv19Z_mKz39KjRTvBOG4dBgBDpyOzlvc8MGjr3QD0Ko8

# Настройки Supabase и VAPID из .env
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_CLAIMS = {"sub": f"mailto:{os.getenv('VAPID_SUB_EMAIL')}"} 


supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Заменяем старый ConnectionManager на UserManager
class UserManager:
    def __init__(self):
        # user_id (role) → WebSocket
        self.online: dict[str, WebSocket] = {}

    async def connect_user(self, user_id: str, ws: WebSocket):
        # Если уже был онлайн с другого устройства — отключаем старый
        if user_id in self.online:
            old_ws = self.online[user_id]
            try:
                await old_ws.close(code=4002, reason="replaced_by_new_session")
            except:
                pass
        await ws.accept()
        self.online[user_id] = ws

    def disconnect_user(self, user_id: str):
        self.online.pop(user_id, None)

    def get_user_ws(self, user_id: str) -> WebSocket | None:
        return self.online.get(user_id)

user_manager = UserManager()

# Проверка токена (используем ту же логику, что и в /auth/login)
def get_user_from_token(token: str) -> dict | None:
    users = json.loads(os.getenv("USERS_JSON", "{}"))
    return users.get(token.lower().strip())

# Функция получения конфига TURN для конкретной роли
def get_ice_servers(role: str):
    # Приводим роль к верхнему регистру для поиска в ENV 
    env_prefix = role.split()[0].upper() 
    
    username = os.getenv(f"{env_prefix}_USER", "default_user")
    credential = os.getenv(f"{env_prefix}_PASS", "default_pass")
    domain = os.getenv("TURN")
    
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
            "urls":f"turns:{domain}:443?transport=tcp",
            "username": username,
            "credential": credential
        }
    ]

# Эндпоинт для сохранения подписки от браузера
@app.post("/push/subscribe")
async def save_push_subscription(data: PushSubscriptionRequest, token: str = Query(...)):
    user_info = get_user_from_token(token)
    if not user_info:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        print(f"[Push] Сохраняю подписку для user_id={user_info['role']}")
        # Попытка upsert с явным указанием конфликтной колонки (если она уникальна)
        # Если user_id не уникален, вызовем ошибку, которую обработаем ниже
        res = supabase.table("push_subs").upsert(
            {
                "user_id": user_info["role"],
                "sub_data": data.subscription,
            },
            on_conflict="user_id",   # <-- укажите, если user_id уникален
        ).execute()

        # Проверка результата (зависит от версии supabase-py)
        if hasattr(res, 'error') and res.error:
            raise Exception(f"Supabase error: {res.error}")
        print("[Push] Успешно сохранено")
        return {"status": "ok"}

    except Exception as e:
        # Если on_conflict не сработал, попробуем без него
        print(f"[Push] Первая попытка не удалась ({e}), пробую upsert без on_conflict")
        try:
            # Удаляем старую запись по user_id и вставляем новую
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
            # Возвращаем ошибку с деталями в CORS-совместимом ответе
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
    
    # Удаляем запись из Supabase, где endpoint совпадает с тем, который прислал клиент
    supabase.table("push_subs") \
        .delete() \
        .eq("sub_data->>endpoint", endpoint) \
        .execute()
        
    return {"status": "ok"}

# Маршрутизация сообщений
async def handle_signal_message(sender_id: str, message: dict, sender_ws: WebSocket):
    msg_type = message.get("type")
    
    if msg_type == "call_request":
        target = message["target"]
        target_ws = user_manager.get_user_ws(target)
        if target_ws:
            # Пересылаем входящий вызов
            await target_ws.send_json({
                "type": "incoming_call",
                "from": sender_id,
                "room_id": f"{sender_id}_{target}"   # для совместимости, если нужно
            })
        else:
            # Здесь будет отправка push (опционально)
            print(f"[PUSH] {target} оффлайн. Ищем подписку в БД...")
            response = supabase.table("push_subs").select("sub_data").eq("user_id", target).execute()
            
            if response.data:
                for row in response.data:
                    sub_data = row["sub_data"]
                    payload = json.dumps({
                        "title": "Входящий вызов",
                        "body": f"{sender_id} вызывает вас...",
                        "caller": sender_id,
                        "target": target,
                        "type": "INCOMING_CALL"
                    })
                    headers = {
                        "Urgency":"high",
                        "Topic":"incoming-calls",
                        "apns-priority": "10",           # 10 означает немедленную доставку и пробуждение экрана
                        "apns-push-type": "alert",       # Указывает, что это системное видимое уведомление
                        "apns-expiration": "45" 
                    }
                    try:
                        await asyncio.to_thread (webpush,
                            subscription_info=sub_data,
                            data=payload,
                            vapid_private_key=VAPID_PRIVATE_KEY,
                            vapid_claims=VAPID_CLAIMS,
                            ttl=45,
                            headers=headers
                        )
                        print(f"[PUSH] Уведомление отправлено {target}")
                    except WebPushException as e:
                        print(f"[PUSH] Ошибка отправки: {e}")
                        # Если подписка устарела (код 410), можно удалить её из БД
            else:
                # Абонент вообще недоступен
                await sender_ws.send_json({"type": "peer_disconnected"})

    elif msg_type == "accept_call":
        target = message["target"]
        target_ws = user_manager.get_user_ws(target)
        if target_ws:
            await target_ws.send_json({
                "type": "start_offer",
                "target": sender_id   # тому, кто звонил, говорим начинать
            })

    elif msg_type in ("offer", "answer", "candidate"):
        target = message.get("target")
        if target:
            target_ws = user_manager.get_user_ws(target)
            if target_ws:
                # Добавляем поле from для идентификации отправителя
                forwarded = {**message, "from": sender_id}
                await target_ws.send_json(forwarded)

    elif msg_type == "call_end":
        target = message.get("target")
        if target:
            target_ws = user_manager.get_user_ws(target)
            if target_ws:
                await target_ws.send_json({"type": "peer_disconnected"})

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
    # Находим сокет звонящего по его ID (caller)
    caller_ws = user_manager.get_user_ws(data.caller)
    if caller_ws:
        # Отправляем ему сигнал завершения вызова
        await caller_ws.send_json({"type": "peer_disconnected"})
        print(f"[Call] Звонок от {data.caller} был отклонен пользователем {data.target} через Push")
    return {"status": "ok"}

# Новый маршрут для получения ICE-серверов (для getServers в JS-коде)
@app.get("/ice-servers")
async def get_ice_config(role: str="guest"):
    try:
        servers = get_ice_servers(role)
        return {"iceServers": servers}
    except Exception as e:  # обработаем случай ошибки чтения файла
        print(f"error gen {e}")
        return {"urls":[{"urls":"stun:stun.l.google.com:19302"}]}


# Новый WebSocket endpoint
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
            # Если тишина больше 40 секунд — считаем клиента мертвым (выключил интернет/телефон)
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=40.0)
            except asyncio.TimeoutError:
                print(f"[WS] Таймаут пинга от {user_id}. Убиваем зомби-соединение.")
                break # Выходим из цикла, чтобы закрыть сокет и почистить словарь
            
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
        # Эта блочная выполнится В ЛЮБОМ СЛУЧАЕ (даже при таймауте)
        user_manager.disconnect_user(user_id)

@app.post("/debug/push-error")
async def debug_push_error(request: Request):
    try:
        data = await request.json()
        log_line = f"[PUSH_DEBUG] {json.dumps(data, ensure_ascii=False)}"
        
        # Этого достаточно для логов хостинга
        print(log_line, flush=True)
        
        return {"status": "logged"}
    except Exception as e:
        print(f"[PUSH_DEBUG_ERROR] {e}", flush=True)
        return {"status": "error"}

@app.get("/index")
async def getindex():
    return FileResponse(os.path.join(base_path,'index.html'))

app.mount("/static", StaticFiles(directory=base_path), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
