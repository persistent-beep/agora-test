import os
import json
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

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

## Менеджер подключений с комнатами
#class ConnectionManager:
#    def __init__(self):
#        self.rooms: dict[str, list[WebSocket]] = {}
#
#    async def connect(self, room_id: str, websocket: WebSocket):
#        await websocket.accept()
#        if room_id not in self.rooms:
#            self.rooms[room_id] = []
#        self.rooms[room_id].append(websocket)
#
#    def disconnect(self, room_id: str, websocket: WebSocket):
#        # proverka komnaty
#        if room_id in self.rooms:
#            try:
#                self.rooms[room_id].remove(websocket)
#            except ValueError:
#                pass
#            if not self.rooms[room_id]:
#                del self.rooms[room_id]
#
#    async def broadcast_json(self, room_id: str, sender: WebSocket, message: dict):
#        for connection in self.rooms.get(room_id, []):
#            if connection != sender:
#                await connection.send_json(message)

#manager = ConnectionManager()
# вместо коннектинг используем юзер менеджер ===================================================

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
    # Приводим роль к верхнему регистру для поиска в ENV (например, GHOST)
    env_prefix = role.split()[0].upper() # "sarah connor" -> "SARAH"
    
    username = os.getenv(f"{env_prefix}_USER", "default_user")
    credential = os.getenv(f"{env_prefix}_PASS", "default_pass")
    domain = os.getenv("TURN")
    
    return [
        { "urls": f"stun:stun.relay.metered.ca:80"
        },
        {
            "urls": [
                f"stun:{domain}:80",
                f"turn:{domain}:80",
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
            # send_push(target, {...})
            pass

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

# Новый маршрут для получения ICE-серверов (для getServers в JS-коде)
@app.get("/ice-servers")
async def get_ice_config(role: str="guest"):
    try:
        servers = get_ice_servers(role)
        return {"iceServers": servers}
    except Exception as e:  # обработаем случай ошибки чтения файла
        print(f"error gen {e}")
        return {"urls":[{"urls":"stun:stun.l.google.com:19302"}]}

# WebSocket endpoint для сигнализации
#@app.websocket("/ws/{room_id}")
#async def websocket_endpoint(websocket: WebSocket, room_id: str):
#    await manager.connect(room_id, websocket)
#    # Ждём, пока в комнате не будет 2 клиента (Peer-to-Peer звонок)
#    try:    
#        if len(manager.rooms[room_id]) == 2:
#            first = manager.rooms[room_id][0]
#        # Первый клиент начинает offer по сигналу
#            await first.send_json({"type": "start_offer"})
#        while True:
#            data = await websocket.receive_json()
#            await manager.broadcast_json(room_id, websocket, data)
#    except WebSocketDisconnect:
#        manager.disconnect(room_id, websocket)
#        await manager.broadcast_json(room_id, websocket, {"type":"peer_disconnected"})

# Новый WebSocket endpoint
@app.websocket("/ws")
async def websocket_call(websocket: WebSocket, token: str = Query("guest")):
    user_info = get_user_from_token(token)
    if not user_info:
        await websocket.close(code=4001, reason="Invalid token")
        return
    user_id = user_info["role"]   # например "ALICE"
    await user_manager.connect_user(user_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            await handle_signal_message(user_id, data, websocket)
    except WebSocketDisconnect:
        user_manager.disconnect_user(user_id)


@app.get("/index")
async def getindex():
    return FileResponse(os.path.join(base_path,'index.html'))

app.mount("/static", StaticFiles(directory=base_path), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
