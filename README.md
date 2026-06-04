# Southpaw

A martial arts AI analysis platform and coach marketplace. Athletes upload boxing, Muay Thai, or MMA training footage and get AI-generated pose skeleton overlays, strike detection, and coaching feedback. Coaches review footage asynchronously through a credit-based marketplace, leaving timestamped comments directly on the video timeline.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, React Router v6 |
| Backend | FastAPI (Python 3.13) |
| Auth | Clerk (managed) |
| Job Queue | Celery + Redis |
| Blob Storage | AWS S3 (multipart upload) |
| Database | PostgreSQL via Supabase |
| ORM | SQLAlchemy async (asyncpg) |
| Pose Estimation | YOLOv8 small (COCO 17 keypoints) |
| Strike Classification | Rules-based velocity detection |
| LLM | DeepSeek V3 (OpenAI-compatible API) |
| Payments | Stripe (credits, subscriptions, Connect payouts) |
| Progress Delivery | SSE via Redis pub/sub |
| Local Dev | Redis via Homebrew, Postgres via Supabase |

---

## Features

### Athlete
- Upload training clips — YOLOv8 pose analysis runs automatically
- Canvas overlay player with skeleton rendering, strike timeline, and seek-on-click
- Per-strike metrics: arm extension, guard discipline, strike type
- Session management — group clips from the same training day
- AI coaching feedback at clip, session, and trend level
- Advanced analytics: combo detection, fatigue curve, head movement score
- Dashboard stats: week streak, strikes this week, guard discipline
- Browse coach marketplace and request paid clip or session reviews
- Credit system — buy credits via Stripe, spend on coach reviews

### Coach
- Profile with bio, specializations, intro video, credit rate, review preference
- Admin-moderated marketplace listing (approved coaches only)
- Review queue — accept clip or session reviews, leave timestamped comments
- Mark complete to receive 80% of credits; cash out via Stripe Connect
- Star rating system — athlete rates each completed review

### Platform
- Subscription tiers (Free / Pro / Elite) with Stripe billing and monthly credit grants
- Notification system — bell icon with unread count, click-to-navigate
- Admin panel for coach moderation (approve / reject / feature)

---

## Project Structure

```
southpaw/
├── docker-compose.yaml
├── frontend/
│   └── src/
│       ├── api/client.js
│       ├── components/
│       │   ├── CanvasPlayer.jsx       # Video + skeleton overlay + strike timeline
│       │   ├── ClipCard.jsx
│       │   ├── SessionCard.jsx
│       │   ├── StatsBar.jsx
│       │   ├── StarRating.jsx
│       │   ├── NotificationBell.jsx
│       │   ├── BuyCreditsModal.jsx
│       │   ├── RequestReviewModal.jsx # Clip/session picker with coach preference
│       │   └── UploadButton.jsx       # Multipart S3 upload + SSE progress
│       ├── hooks/
│       │   └── useCurrentUser.js
│       ├── pages/
│       │   ├── HomePage.jsx
│       │   ├── OnboardingPage.jsx
│       │   ├── DashboardPage.jsx
│       │   ├── SessionPage.jsx
│       │   ├── PlayerPage.jsx
│       │   ├── CoachProfilePage.jsx
│       │   ├── CoachPublicProfilePage.jsx
│       │   ├── CoachReviewQueuePage.jsx
│       │   ├── CoachReviewPlayerPage.jsx
│       │   ├── MarketplacePage.jsx
│       │   ├── PricingPage.jsx
│       │   └── AdminPage.jsx
│       └── utils/
│           └── skeletonRenderer.js
└── backend/
    ├── main.py
    ├── dependencies.py
    ├── core/
    │   ├── config.py
    │   └── s3.py                      # Presigned URLs + multipart upload helpers
    ├── db/
    │   └── session.py
    ├── models/
    │   ├── clip.py
    │   ├── clip_comment.py
    │   ├── clip_review.py
    │   ├── coach_profile.py
    │   ├── credit_transaction.py
    │   ├── job.py
    │   ├── notification.py
    │   ├── session.py
    │   ├── strike.py
    │   └── user.py
    ├── routers/
    │   ├── admin.py                   # Coach moderation (is_admin gated)
    │   ├── clips.py
    │   ├── coaches.py
    │   ├── jobs.py
    │   ├── notifications.py
    │   ├── payments.py                # Credits, subscriptions, Connect payouts
    │   ├── reviews.py
    │   ├── sessions.py
    │   ├── strikes.py
    │   ├── uploads.py                 # Single + multipart upload flow
    │   ├── users.py
    │   └── webhooks.py                # Clerk webhook handler
    ├── services/
    │   ├── feedback.py                # LLM pipeline (DeepSeek)
    │   └── notifications.py          # Async + sync notification helpers
    └── worker/
        ├── celery_app.py
        ├── db.py
        └── tasks.py                   # YOLOv8 + metrics + thumbnail + feedback
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Python 3.13+
- Redis (via Homebrew: `brew install redis`)
- A [Clerk](https://clerk.com) account
- An AWS S3 bucket
- A [Supabase](https://supabase.com) Postgres project
- A [Stripe](https://stripe.com) account (with Connect enabled)
- A [DeepSeek](https://platform.deepseek.com) API key

### Local dev

```bash
# Terminal 1 — Redis
brew services start redis

# Terminal 2 — FastAPI
cd backend && source venv/bin/activate && uvicorn main:app --reload

# Terminal 3 — Celery worker
cd backend && source venv/bin/activate && celery -A worker.celery_app worker --loglevel=info

# Terminal 4 — React
cd frontend && npm run dev

# Terminal 5 — Stripe webhooks (local)
stripe listen --forward-to localhost:8000/payments/webhook
```

FastAPI docs: `http://localhost:8000/docs`  
App: `http://localhost:5173`

---

## Environment Variables

### `frontend/.env.local`

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `VITE_API_URL` | Backend URL (default: `http://localhost:8000`) |

### `backend/.env`

| Variable | Description |
|---|---|
| `CLERK_SECRET_KEY` | Clerk secret key |
| `CLERK_FRONTEND_API` | Clerk frontend API host |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins (default: `http://localhost:5173`) |
| `CLERK_WEBHOOK_SECRET` | Clerk webhook signing secret (`whsec_...`) |
| `DATABASE_URL` | Supabase async connection string (`postgresql+asyncpg://...`) |
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_REGION` | S3 bucket region (default: `us-east-1`) |
| `S3_BUCKET_NAME` | S3 bucket name |
| `REDIS_URL` | Redis connection URL (default: `redis://localhost:6379/0`) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `STRIPE_PRO_PRICE_ID` | Stripe Price ID for Pro tier (`price_...`) |
| `STRIPE_ELITE_PRICE_ID` | Stripe Price ID for Elite tier (`price_...`) |

---

## Upload & Processing Flow

1. **Multipart init** — `POST /uploads/multipart/init` creates a clip row and S3 multipart upload, returns presigned URLs for each 10MB chunk
2. **Chunk upload** — frontend uploads chunks in parallel (max 3 concurrent) directly to S3, collects ETags
3. **Complete** — `POST /uploads/multipart/complete` finalizes the S3 multipart assembly, triggers Celery job
4. **Processing** — Celery worker: downloads clip → extracts thumbnail → runs YOLOv8 per frame → detects strikes → computes metrics (arm extension, guard dropped, head movement, combos, fatigue curve) → generates AI feedback → marks job complete
5. **SSE** — `GET /jobs/:id/stream` forwards Redis pub/sub progress events to the browser in real time
6. **Results** — keypoint JSON written to S3, strike rows and metrics saved to Postgres, feedback stored on clip

---

## Canvas Overlay Player

The player uses a `<canvas>` absolutely positioned over a `<video>` element. A `requestAnimationFrame` loop reads `video.currentTime`, binary searches the keypoint index, and redraws the skeleton each frame.

- **React owns UI state** (strikes, filters, controls, comments)
- **rAF loop owns the canvas** via refs — no re-renders during playback
- Strike timeline below the video — click a tick to seek; yellow dots mark coach comments
- Timestamped comments pinned to specific moments via the scrubber

---

## Subscription Tiers

| | Free | Pro ($12/mo) | Elite ($29/mo) |
|---|---|---|---|
| Clips/month | 3 | Unlimited | Unlimited |
| Credits/month | 5 | 25 | 75 |
| Session feedback | ✗ | ✓ | ✓ |
| Trend feedback | ✗ | ✗ | ✓ |
| Marketplace | Browse | Request | Request |
