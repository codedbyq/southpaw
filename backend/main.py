from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from auth import get_current_user

app = FastAPI(title="Southpaw API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000"
        ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"message": "Hello from Southpaw API"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/me")
async def me(claims: dict = Depends(get_current_user)):
    """Protected route — returns the signed-in user's Clerk ID."""
    return {"user_id": claims["sub"], "email": claims.get("email")}
