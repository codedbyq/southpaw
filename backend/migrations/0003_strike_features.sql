-- Trajectory feature records (schema v1, services/strike_features.py):
-- body-frame strike trajectories stored per detection so labels collected
-- later become training rows without reprocessing.
-- Run against Supabase before deploying the features-1 pipeline.

ALTER TABLE strikes ADD COLUMN IF NOT EXISTS features jsonb;
