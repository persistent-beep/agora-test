from fastapi import FastAPI, HTTPException
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

@app.post("/auth/login")
async def login(data: AuthRequest):
    if data.token == "ghost":
        return {"status": "succes", "access_token": "secret-jwt-payload", "role": "admin"}
    elif data.token == "guest":
        return {"status": "succes", "access_token": "guest-session", "role": "guest"}
    else:
        raise HTTPException(status_code=401, detail="UNVALID_TOKEN")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
