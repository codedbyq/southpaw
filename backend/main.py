from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import admin, clips, coaches, jobs, notifications, payments, reviews, sessions, strikes, uploads, users, webhooks

app = FastAPI(title="Southpaw API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:5174",
        "https://southpaw-beige.vercel.app",
        "https://trysouthpaw.com",
        "https://www.trysouthpaw.com",
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
app.include_router(users.router)
app.include_router(admin.router)
app.include_router(coaches.router)
app.include_router(notifications.router)
app.include_router(payments.router)
app.include_router(reviews.router)
app.include_router(webhooks.router)


@app.get("/health")
def health():
    return {"status": "ok"}
