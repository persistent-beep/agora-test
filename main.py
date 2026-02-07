import os
import json
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()

# Разрешаем корс 
app.add_middleware(
    CORSMiddleware,
    allow_origins = ['*'],
    allow_methods = ['*'],
    allow_headers = ['*'],
)

class AuthRequest(BaseModel):
    token: str

USERS = {
        "ghost": {
            "access_token": "ghost",
            "role": "ghost",
            "display_name": "GHOST"
        },
        "sarah": {
            "access_token": "sarah connor", 
            "role": "sarah connor",
            "display_name": "SARAH CONNOR"
        },
        "neo": {
            "access_token": "neo",
            "role": "neo",
            "display_name": "NEO"
        },
        "operator": {
            "access_token": "operator",
            "role": "operator",
            "display_name": "OPERATOR"
        },
        "guest": {
            "access_token": "guest",
            "role": "guest",
            "display_name": "GUEST"
        }
    }

@app.post("/auth/login")
async def login(data: AuthRequest):
    token = data.token.lower().strip()
    
    user = USERS.get(token)
        
    if not user:
        raise HTTPException(status_code=401, detail="INVALID_TOKEN")
            
    return {
        "status": "success",
        "access_token": user["access_token"],
        "role": user["role"],
        "display_name": user["display_name"]
    }


# Загрузка ICE-серверов для TURN/STUN
def load_ice_servers(filename="ice_servers.json"):
    with open(filename, "r") as f:
        return json.load(f)

# Менеджер подключений с комнатами
class ConnectionManager:
    def __init__(self):
        self.rooms: Dict[str, List[WebSocket]] = {}

    async def connect(self, room_id: str, websocket: WebSocket):
        await websocket.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = []
        self.rooms[room_id].append(websocket)

    def disconnect(self, room_id: str, websocket: WebSocket):
        self.rooms[room_id].remove(websocket)
        if not self.rooms[room_id]:
            del self.rooms[room_id]

    async def broadcast(self, room_id: str, sender: WebSocket, message: str):
        for connection in self.rooms.get(room_id, []):
            if connection != sender:
                await connection.send_text(message)

manager = ConnectionManager()


# Новый маршрут для получения ICE-серверов (для getServers в JS-коде)
@app.get("/turn")
async def get_turn():
    try:
        ice_servers = load_ice_servers("ice_servers.json")
    except Exception:  # обработаем случай ошибки чтения файла
        return JSONResponse(content={"iceServers": []}, status_code=500)
    return JSONResponse(content=ice_servers)

# WebSocket endpoint для сигнализации
@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await manager.connect(room_id, websocket)
    # Ждём, пока в комнате не будет 2 клиента (Peer-to-Peer звонок)
    try:    
        if len(manager.rooms[room_id]) == 2:
            first = manager.rooms[room_id][0]
        # Первый клиент начинает offer по сигналу
            await first.send_json({"type": "start_offer"})
        while True:
            data = await websocket.receive_text()
            await manager.broadcast(room_id, websocket, data)
    except WebSocketDisconnect:
        manager.disconnect(room_id, websocket)





if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
