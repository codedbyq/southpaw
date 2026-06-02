from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import clips, jobs, sessions, strikes, uploads

app = FastAPI(title="Southpaw API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(uploads.router)
app.include_router(clips.router)
app.include_router(sessions.router)
app.include_router(jobs.router)
app.include_router(strikes.router)


@app.get("/health")
def health():
    return {"status": "ok"}
