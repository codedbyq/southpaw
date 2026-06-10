# Southpaw

A martial arts AI analysis platform and coach marketplace. Athletes upload boxing, Muay Thai, or MMA training footage and get AI-generated pose skeleton overlays, strike detection, and coaching feedback. Coaches review footage asynchronously through a credit-based marketplace, leaving timestamped comments directly on the video timeline.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, React Router v7 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) — Electric Kiwi design system |
| Icons | lucide-react |
| Backend | FastAPI (Python 3.13) |
| Auth | Clerk (managed) |
| Inference | **Modal** (serverless GPU/CPU functions) |
| Blob Storage | AWS S3 (multipart upload) |
| Database | PostgreSQL via Supabase |
| ORM | SQLAlchemy async (asyncpg) |
| Pose Estimation | YOLO11-pose (COCO 17 keypoints) — small for Free/Pro (beta floor), medium for Elite |
| Multi-person Tracking | ByteTrack (via `supervision`) — persistent subject IDs across frames |
| Strike Classification | Rules classifier v2 — time-based windows, torso-length normalization, stance-aware naming, per-strike confidence |
| LLM | DeepSeek (V3 / R1 by tier, OpenAI-compatible API) |
| Payments | Stripe (credits, subscriptions, Connect payouts) |
| Progress Delivery | SSE via Redis pub/sub (Upstash in prod) |
| Deployment | Railway (API) · Modal (inference) · Vercel (frontend) |
| Local Dev | Redis via Homebrew, Postgres via Supabase |

> **Note:** Video processing moved from a **Celery + Redis worker** to **Modal** serverless functions. FastAPI spawns inference fire-and-forget (`modal.Function.from_name(...).spawn.aio(...)`); there is no long-running worker process to manage. Redis is still used for SSE pub/sub progress.

---

## Features

### Athlete
- Upload training clips — YOLO11 pose analysis + ByteTrack subject tracking runs automatically on Modal
- Canvas overlay player with color-coded skeletons per tracked subject, strike timeline, and seek-on-click
- Subject selector — pick which fighter's metrics to show on multi-person clips (color-matched chips, hover-highlight on video); manual picks double as identity labels
- Per-strike metrics with confidence scores: type (stance-aware jab/cross), arm extension (torso-normalized), guard discipline, peak velocity, hip rotation, recovery time
- Footage-quality score per clip — banner names the issue (too dark, too far, occluded, multi-person ambiguity) and the AI hedges accordingly
- Strike labeling — confirm/reject/correct detections and mark missed strikes; every tap is ML training data
- Session management — group clips from the same training day
- AI coaching feedback at clip, session, and trend level (trends only consume identity-confident clips)
- Advanced analytics: combo detection, fatigue curve, head movement score, stance detection
- Failed uploads show a friendly reason + one-click retry (idempotent reprocessing)
- Dashboard stats: week streak, strikes this week, guard discipline
- Biometric consent controls — identity data (skeletal proportions) stored only with explicit opt-in, deletable anytime
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
- Admin panel — coach moderation (approve / reject / feature) + processing-jobs debug view (status, error codes, stage timings, quality scores)
- Production-hardened pipeline: idempotent processing runs, job heartbeats with a stale-job reaper cron, structured error codes, per-stage diagnostics, `pipeline_version` stamped on every clip for selective reprocessing
- Golden-set evaluation harness — replays the strike classifier on recorded keypoints (no GPU) against hand labels for threshold tuning

---

## Design System — Electric Kiwi

The frontend uses the **Electric Kiwi** design system: electric-lime `#CCFF00` on true black, athletic **Barlow Condensed** display type, sharp 4px rectangular sport/status tags, and a lime→green→orange strike data-viz ramp.

- **Tokens** live in `frontend/src/index.css` as a Tailwind v4 `@theme` block (`bg-ink`, `bg-surface`, `text-kiwi`, `border-line`, `font-display`, …), plus CSS recipes (`.btn`, `.tag`, `.chip`, `.input`).
- **Shared shell** components:
  - `AppLayout.jsx` — 72px lucide icon rail + top utility bar (experience level, plan badge, credits, notifications). Every signed-in page renders its content inside it.
  - `Button.jsx` — `variant="primary|outline|secondary|ghost|danger"`. Owns the one contrast rule: **text on lime is always black**.
  - `Tag.jsx` — sharp sport/status badges, plus `SportTag` / `SessionTypeTag`.
- Headings/stats use `font-display` (Barlow Condensed); body uses `font-sans` (Barlow). The Clerk auth modal is themed lime/black via the `appearance` prop in `main.jsx`.

---

## Project Structure

```
southpaw/
├── frontend/
│   └── src/
│       ├── main.jsx                    # ClerkProvider (lime/black appearance) + BrowserRouter
│       ├── index.css                   # Tailwind v4 @theme — Electric Kiwi tokens + recipes
│       ├── api/client.js
│       ├── components/
│       │   ├── AppLayout.jsx           # Sidebar rail + top utility bar (shared shell)
│       │   ├── Button.jsx              # Variant button — owns text-black-on-lime
│       │   ├── Tag.jsx                 # Sharp sport/status tags + SportTag/SessionTypeTag
│       │   ├── CanvasPlayer.jsx        # Video + skeleton overlay + strike timeline
│       │   ├── ClipCard.jsx
│       │   ├── SessionCard.jsx
│       │   ├── StatsBar.jsx
│       │   ├── StarRating.jsx
│       │   ├── NotificationBell.jsx
│       │   ├── BuyCreditsModal.jsx
│       │   ├── RequestReviewModal.jsx  # Clip/session picker with coach preference
│       │   └── UploadButton.jsx        # Multipart S3 upload + SSE progress
│       ├── hooks/
│       │   └── useCurrentUser.js
│       ├── pages/                      # all wrapped in <AppLayout> when signed in
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
│           └── skeletonRenderer.js     # Pure canvas helpers; lime skeleton + strike ramp
├── docs/
│   ├── subject-identity-and-reid.md    # Subject selection + athlete-memory (ReID) design
│   ├── strength-conditioning-v1.md     # S&C rep-analysis spec (planned)
│   └── session-segmentation.md         # Whole-recording auto-segmentation spec (planned)
└── backend/
    ├── main.py
    ├── dependencies.py
    ├── modal_inference.py              # Modal functions: run_inference (pose+track+classify), reap_stale_jobs cron, extract_coach_thumbnail
    ├── migrations/                     # Manually-applied SQL migrations
    ├── scripts/
    │   ├── golden_eval.py              # Replay classifier vs hand labels (no GPU)
    │   └── reprocess_clip.py           # Respawn inference per clip / by pipeline_version
    ├── core/
    │   ├── config.py
    │   └── s3.py                       # Presigned URLs + multipart upload helpers
    ├── db/
    │   └── session.py                  # Async SQLAlchemy engine + get_db
    ├── models/
    │   ├── clip.py                     # + pipeline_version, pose_quality_score, subject_confidence, clip_type
    │   ├── clip_comment.py
    │   ├── clip_review.py
    │   ├── coach_profile.py
    │   ├── credit_transaction.py
    │   ├── identity_sample.py          # Consent-gated "this subject = this athlete" labels (ReID groundwork)
    │   ├── job.py                      # + heartbeat_at, error_code, diagnostics, attempt
    │   ├── notification.py
    │   ├── session.py
    │   ├── strike.py                   # + subject_id; confidence now written by classifier v2
    │   ├── strike_label.py             # Ground-truth strike feedback (ML training flywheel)
    │   └── user.py                     # + biometric_consent_at
    ├── routers/
    │   ├── admin.py                    # Coach moderation + GET /admin/jobs debug view (is_admin gated)
    │   ├── clips.py                    # CRUD + select-subject + retry + strike-labels
    │   ├── coaches.py
    │   ├── jobs.py
    │   ├── notifications.py
    │   ├── payments.py                 # Credits, subscriptions, Connect payouts
    │   ├── reviews.py
    │   ├── sessions.py                 # + trend feedback (identity-confidence gated)
    │   ├── strikes.py
    │   ├── uploads.py                  # Single + multipart upload; spawns Modal inference
    │   ├── users.py                    # + POST /users/me/consent
    │   └── webhooks.py                 # Clerk webhook handler
    ├── services/
    │   ├── clip_metrics.py             # Subject scoring, skeletal stats, pose quality, head/stance (pure Python)
    │   ├── strike_classifier.py        # Rules classifier v2 — replayable post-pass over keypoints JSON
    │   ├── feedback.py                 # LLM pipeline (DeepSeek) — data_quality gating, async + sync variants
    │   └── notifications.py            # Async + sync notification helpers
    └── worker/
        ├── __init__.py
        └── db.py                       # Sync SQLAlchemy session (used by Modal inference)
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Python 3.13+
- Redis (via Homebrew: `brew install redis`) — local SSE pub/sub
- A [Modal](https://modal.com) account (`pip install modal && modal token new`)
- A [Clerk](https://clerk.com) account
- An AWS S3 bucket
- A [Supabase](https://supabase.com) Postgres project
- A [Stripe](https://stripe.com) account (with Connect enabled)
- A [DeepSeek](https://platform.deepseek.com) API key

### Local dev

```bash
# Terminal 1 — Redis (SSE pub/sub)
brew services start redis

# Terminal 2 — FastAPI
cd backend && source venv/bin/activate && uvicorn main:app --reload

# Terminal 3 — Modal inference
cd backend && modal serve modal_inference.py     # dev (hot reload)
# or, for the deployed function:
cd backend && modal deploy modal_inference.py    # production

# Terminal 4 — React
cd frontend && npm run dev

# Terminal 5 — Stripe webhooks (local)
stripe listen --forward-to localhost:8000/payments/webhook
```

FastAPI docs: `http://localhost:8000/docs`  
App: `http://localhost:5173`

> The FastAPI process resolves the deployed Modal function by name (`southpaw-inference` / `run_inference`), so `modal deploy` (or a running `modal serve`) must be live for uploads to process.

### Demo / test account

A seeded demo account exists on the **dev Clerk instance** for manual testing, agent-driven verification, and demos:

- **Email:** `demo+clerk_test@southpaw.dev` — a Clerk *test identity* (`+clerk_test`): no real email is ever sent, and any verification code is always `424242`
- **Credentials:** `DEMO_EMAIL` / `DEMO_PASSWORD` / `DEMO_CLERK_USER_ID` in `backend/.env` (gitignored; dev instance only — never reuse for prod)
- The account is flagged `is_admin`, `pro` tier, and has biometric consent on, so it exercises the admin jobs view, session feedback, and identity-sample paths
- Seed it with the golden-set clips (multi-person sparring, dark, 60fps, a failed upload) so every UI state has a stable fixture

Convention: credentials are never `VITE_`-prefixed (anything `VITE_*` is compiled into the client bundle) and auto-login is never built into app code — automation drives the real sign-in form.

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
| `REDIS_URL` | Redis connection URL for SSE pub/sub (default: `redis://localhost:6379/0`) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `STRIPE_PRO_PRICE_ID` | Stripe Price ID for Pro tier (`price_...`) |
| `STRIPE_ELITE_PRICE_ID` | Stripe Price ID for Elite tier (`price_...`) |

> Modal authenticates via its own CLI token (`modal token new`), not a `.env` variable. The Modal function reads AWS / DB / DeepSeek secrets from its own Modal Secret configuration.

---

## Upload & Processing Flow

1. **Multipart init** — `POST /uploads/multipart/init` creates a clip row and S3 multipart upload, returns presigned URLs for each 10MB chunk
2. **Chunk upload** — frontend uploads chunks in parallel (max 3 concurrent) directly to S3, collects ETags, with per-chunk retry
3. **Complete** — `POST /uploads/multipart/complete` finalizes the S3 multipart assembly, then **spawns the Modal inference function** fire-and-forget and returns a `job_id`
4. **Processing (Modal)** — `run_inference` (idempotent; wipes its own strike rows at start so retries are safe): downloads clip → EXIF rotation → 720p downscale + 60fps frame-halving → YOLO11 pose + ByteTrack per frame → classification post-pass (`strike_classifier.py`: time-based, torso-normalized, stance-aware, per-strike confidence) → composite primary-subject scoring → pose-quality score → thumbnail → AI feedback → marks job complete with per-stage diagnostics and a `pipeline_version` stamp
5. **SSE** — Modal publishes progress (and a heartbeat) to Redis pub/sub; `GET /jobs/:id/stream` forwards events to the browser in real time (falls back to polling if the stream drops). A 5-minute reaper cron fails jobs with stale heartbeats so users never see a frozen progress bar
6. **Results** — keypoint JSON (all subjects + strike debug traces) written to S3, the primary subject's confident strikes saved to Postgres, feedback stored on the clip. Low-confidence strikes stay in the JSON, out of metrics and LLM payloads

A simpler single-PUT path (`POST /uploads/init` → `POST /uploads/complete`) also exists for small clips; the frontend `UploadButton` uses the multipart path.

---

## Canvas Overlay Player

The player uses a `<canvas>` absolutely positioned over a `<video>` element. A `requestAnimationFrame` loop reads `video.currentTime`, binary searches the keypoint index, and redraws the lime pose skeleton each frame.

- **React owns UI state** (strikes, filters, controls, comments)
- **rAF loop owns the canvas** via refs — no re-renders during playback
- Strike timeline below the video — colored ticks (lime→orange strike ramp), click a tick to seek; **gold dots** mark coach comments; **lime playhead**
- Timestamped comments pinned to specific moments via the scrubber

---

## Subscription Tiers

| | Free | Pro ($12/mo) | Elite ($29/mo) |
|---|---|---|---|
| Clips/month | 3 | Unlimited | Unlimited |
| Credits/month | 5 | 25 | 75 |
| Pose model | YOLO11 small* | YOLO11 small | YOLO11 medium |
| LLM | DeepSeek V3 | DeepSeek V3 | DeepSeek R1 |
| Session feedback | ✗ | ✓ | ✓ |
| Trend feedback | ✗ | ✗ | ✓ |
| Marketplace | Browse | Request | Request |

\* small is the floor for all tiers during the beta — keypoint stability feeds the velocity-based classifier. Free returns to nano at public launch.

---

## Design Docs

Living specs for in-flight and planned systems, in [`docs/`](docs/):

- [Subject identity & ReID](docs/subject-identity-and-reid.md) — subject selection (shipped) and the athlete-memory roadmap
- [Session segmentation](docs/session-segmentation.md) — whole-recording upload → auto-detected rounds (beta week 2–3)
- [Strength & Conditioning v1](docs/strength-conditioning-v1.md) — rep analysis for lifts (beta week 3–4)
