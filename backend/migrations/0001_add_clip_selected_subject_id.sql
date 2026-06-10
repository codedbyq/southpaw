-- Subject selection: which tracked person's metrics a clip shows.
-- Run against Supabase before deploying the subject-selector changes.
-- (This project has no migration tool — columns are applied manually,
--  same as `stance` / `head_movement_score` were.)

ALTER TABLE clips ADD COLUMN IF NOT EXISTS selected_subject_id INTEGER;

-- DEV/TEST ONLY: upgrade one account to Pro so uploads aren't rate-limited
-- (Free tier caps at 3 clips/month). Replace the placeholder with your Clerk user id.
UPDATE users SET subscription_tier = 'pro' WHERE clerk_user_id = 'user_REPLACE_ME';
