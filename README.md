# Southpaw

A martial arts AI analysis platform. Upload boxing or Muay Thai sparring footage and get real-time pose skeleton overlays with automatic strike detection. The app identifies jabs, crosses, hooks, and roundhouse/rear kicks, renders them on an interactive canvas player with a strike timeline, and supports selecting individual fighters in multi-person clips.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite |
| Backend | FastAPI (Python) |
| Auth | Clerk |
| Job Queue | Celery + Redis |
| Blob Storage | AWS S3 |
| Database | PostgreSQL via Supabase |
| ORM | SQLAlchemy async (asyncpg) |
| Pose Estimation | YOLOv8 nano (COCO 17 keypoints) |
| Strike Classification | Rules-based velocity detection (MVP) |
| Progress Delivery | SSE via Redis pub/sub |
| Local Dev | Docker Compose |

---

## Project Structure

```
southpaw/
├── docker-compose.yaml
├── frontend/                        # React + Vite app
│   └── src/
│       ├── api/client.js            # useApi() hook — attaches Clerk Bearer token
│       ├── components/
│       │   ├── CanvasPlayer.jsx     # Video player with skeleton overlay + strike timeline
│       │   ├── ClipCard.jsx         # Clip list item with job status
│       │   └── UploadButton.jsx     # Upload flow — presigned S3 + SSE progress
│       ├── pages/
│       │   ├── HomePage.jsx
│       │   ├── DashboardPage.jsx
│       │   └── PlayerPage.jsx       # Canvas overlay player page
│       └── utils/
│           └── skeletonRenderer.js  # Pure canvas drawing — buildIndex, lookupFrame, drawFrame
└── backend/
    ├── main.py                      # App init, CORS, router registration
    ├── dependencies.py              # get_current_user — Clerk JWT verification
    ├── core/
    │   ├── config.py                # pydantic-settings, loads .env
    │   └── s3.py                    # Presigned URL generation, S3 client
    ├── db/
    │   └── session.py               # Async SQLAlchemy engine + get_db dependency
    ├── models/                      # SQLAlchemy models (Clip, Job, Strike)
    ├── schemas/                     # Pydantic request/response shapes
    ├── routers/
    │   ├── clips.py                 # GET/DELETE /clips
    │   ├── uploads.py               # POST /uploads/init, /uploads/complete
    │   ├── jobs.py                  # GET /jobs/:id, SSE /jobs/:id/stream
    │   └── strikes.py               # GET /clips/:id/strikes
    └── worker/
        ├── celery_app.py            # Celery app config
        ├── db.py                    # Sync SQLAlchemy session for Celery tasks
        └── tasks.py                 # process_clip — YOLOv8 inference + strike detection
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Python 3.13+
- Docker + Docker Compose
- A [Clerk](https://clerk.com) account
- An AWS S3 bucket
- A [Supabase](https://supabase.com) Postgres project

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local  # add VITE_CLERK_PUBLISHABLE_KEY
npm run dev                  # http://localhost:5173
```

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env         # fill in all values
uvicorn main:app --reload    # http://localhost:8000
```

### Docker (API + Celery Worker + Redis)

```bash
docker compose up --build
```

API docs available at `http://localhost:8000/docs`.

---

## Environment Variables

### `frontend/.env.local`

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key from the Clerk dashboard |

### `backend/.env`

| Variable | Description |
|---|---|
| `CLERK_SECRET_KEY` | Clerk secret key |
| `CLERK_FRONTEND_API` | Clerk frontend API host (e.g. `tolerant-kit-91.clerk.accounts.dev`) |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins (default: `http://localhost:5173`) |
| `DATABASE_URL` | Supabase async connection string (`postgresql+asyncpg://...`) |
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_REGION` | S3 bucket region (default: `us-east-1`) |
| `S3_BUCKET_NAME` | S3 bucket name |
| `REDIS_URL` | Redis connection URL (default: `redis://redis:6379/0`) |

---

## Upload & Processing Flow

1. `POST /uploads/init` — backend generates a presigned S3 URL and creates a `clips` row (`status=pending`)
2. Frontend uploads video **directly to S3** via the presigned URL (backend never touches video bytes)
3. `POST /uploads/complete` — backend marks clip `uploaded`, creates a `jobs` row, enqueues Celery task
4. Frontend opens SSE stream on `GET /jobs/:id/stream`
5. Celery worker runs YOLOv8 frame-by-frame, publishes progress to Redis pub/sub
6. FastAPI SSE endpoint forwards Redis events to the browser in real time
7. On completion, keypoint JSON is written to S3 and strike rows are saved to Postgres

---

## Canvas Overlay Player

The player uses a `<canvas>` absolutely positioned over a `<video>` element. A `requestAnimationFrame` loop reads `video.currentTime`, binary searches the keypoint index, and redraws the skeleton each frame.

- **React owns UI state** (strikes, filters, controls)
- **rAF loop owns the canvas** via refs — no `useState` for playback to avoid 60 re-renders/second
- Click a skeleton to select that fighter — updates `activeSubjectRef` directly, picked up on next rAF tick
- Strike timeline below the video — click a tick to seek to that moment
