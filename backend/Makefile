# Classifier evaluation against the golden corpus (see eval/manifest.json).
# `make eval` is the pre-merge gate for any change under services/ — it exits
# non-zero if a ratchet baseline or fixture assertion fails.

PY := ./venv/bin/python

eval:
	$(PY) scripts/run_eval.py

eval-report:
	$(PY) scripts/run_eval.py --report

.PHONY: eval eval-report
