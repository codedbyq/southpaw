-- Beta production-readiness pass: pipeline versioning, footage quality,
-- job reliability (heartbeat/reaper/diagnostics), per-strike confidence,
-- biometric consent, identity samples, strike labels.
-- Run against Supabase before deploying the reworked Modal pipeline.
-- (This project has no migration tool — columns are applied manually.)

-- clips: versioning + quality + type
ALTER TABLE clips ADD COLUMN IF NOT EXISTS pipeline_version text;     -- 'v3:<model>:<rules-version>'; NULL = pre-versioning (suspect data)
ALTER TABLE clips ADD COLUMN IF NOT EXISTS pose_quality_score double precision;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS subject_confidence double precision;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS clip_type text;            -- bag | sparring | shadow | pads | strength

-- jobs: liveness + diagnostics + reprocessing history
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_code text;            -- timeout | decode_error | no_person | s3_error | internal
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS diagnostics jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- strikes: which tracked subject; confidence column already exists and is
-- now actually written by the v2 classifier
ALTER TABLE strikes ADD COLUMN IF NOT EXISTS subject_id integer;

-- users: BIPA-style consent gate for identity data
ALTER TABLE users ADD COLUMN IF NOT EXISTS biometric_consent_at timestamptz;

-- identity samples: "this tracked subject is this athlete" labels
CREATE TABLE IF NOT EXISTS identity_samples (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  clip_id          uuid NOT NULL REFERENCES clips(id) ON DELETE CASCADE UNIQUE,
  subject_id       integer NOT NULL,
  pipeline_version text,
  source           text NOT NULL,              -- 'solo' | 'manual' | 'auto'
  skeletal_stats   jsonb,                      -- torso-normalized limb ratios
  confidence       double precision,
  revoked_at       timestamptz,                -- bad-label recovery
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_identity_samples_user ON identity_samples(user_id);

-- strike labels: training-data flywheel for the future ML classifier
CREATE TABLE IF NOT EXISTS strike_labels (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id           uuid NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  strike_id         uuid REFERENCES strikes(id) ON DELETE SET NULL,  -- NULL = missed-strike label
  user_id           uuid REFERENCES users(id),
  label             text NOT NULL,              -- 'correct' | 'wrong_type' | 'not_a_strike' | 'missed'
  corrected_type    text,
  timestamp_seconds double precision,
  source            text NOT NULL DEFAULT 'athlete',  -- 'athlete' | 'coach_comment' | 'admin'
  window_s3_key     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_strike_labels_clip ON strike_labels(clip_id);

-- backfill clip_type from the parent session's session_type
UPDATE clips c SET clip_type = s.session_type
FROM sessions s
WHERE c.session_id = s.id AND c.clip_type IS NULL AND s.session_type IS NOT NULL;
