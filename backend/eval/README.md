# Classifier evaluation framework

`make eval` (from `backend/`) replays the strike classifier over the golden corpus,
slices metrics by class and clip type, and enforces the assertions in
[manifest.json](manifest.json). Non-zero exit = a ratchet baseline or fixture
assertion failed. Run it before merging any change under `services/`.

## Tiers (`backend/golden/`, gitignored — contains footage-derived data)

| tier | purpose |
|---|---|
| `core/` | verified strike-truth clips; thresholds/models **may** be tuned against these |
| `holdout/` | clips labeled after the current tuning round; **never** fit against — reported separately as the generalization check. New exports default here (the labeling page's export hint points here). |
| `regression/tracking/` | clips quarantined for tracking/identity failures (keypoints + `.fixture.json` note, no strike labels); they re-enter labeling when re-ID lands |

Promotion: when a new tuning round begins, holdout clips may be promoted to core —
in a PR that says so — and the next labeled batch becomes the new holdout.

## The ratchet

- Baselines (`manifest.json → baselines`) are floors on core metrics. A PR may not
  drop below a floor, or fail a fixture assertion, without editing the manifest in
  the same PR with a justification.
- New failure mode discovered → add a fixture entry (and clip, if quarantined)
  **before** fixing it.
- `make eval-report` writes a metrics-only JSON to `eval/reports/` (committed —
  no footage-derived data, just numbers) — one per release alongside the
  `RULES_VERSION` bump.

## Related

- `scripts/golden_eval.py` — low-level single-directory harness (replay + match)
- `scripts/run_eval.py` — tiered runner used by `make eval`
- `scripts/export_golden.py` — labels → golden pair (use `golden/holdout/` for new clips)
- `scripts/detection_diagnostics.py` — per-detection kinematics for FP analysis
- `docs/pipeline-evolution.md` — the strategy this implements (Part 5)
