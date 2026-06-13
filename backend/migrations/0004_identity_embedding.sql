-- Athlete gallery: persist the consented athlete's appearance embedding +
-- model tag alongside the existing skeletal_stats, so cross-clip athlete
-- recognition (ReID block, gallery phase) can rank subjects in a new clip
-- against the athlete's gallery. Embeddings are stored ONLY for the athlete
-- (spec D2) and only with biometric consent (spec D3) — the existing write
-- gates already enforce both.
-- Run against Supabase before deploying the gallery-matching pipeline.

ALTER TABLE identity_samples ADD COLUMN IF NOT EXISTS embedding jsonb;        -- normalized OSNet centroid (list[float])
ALTER TABLE identity_samples ADD COLUMN IF NOT EXISTS embedding_model text;   -- e.g. 'osnet_ain_x1_0_msmt17'
