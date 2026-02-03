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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
