"""Pure unit tests for services/gallery.py matching logic (no GPU/DB).
Run: cd backend && ./venv/bin/python scripts/test_gallery.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services import gallery as G


def test_build_excludes_revoked():
    g = G.build_gallery([
        {"embedding": [1, 0, 0], "skeletal_stats": None, "confidence": 1.0, "revoked_at": None},
        {"embedding": [0.9, 0.1, 0], "skeletal_stats": None, "confidence": 1.0, "revoked_at": None},
        {"embedding": [5, 5, 5], "skeletal_stats": None, "confidence": 1.0, "revoked_at": "2026-01-01"},
    ])
    assert g["n"] == 2


def test_rank_picks_athlete():
    g = G.build_gallery([{"embedding": [1, 0, 0], "skeletal_stats": None, "confidence": 1.0, "revoked_at": None}])
    ranked, conf = G.rank_subjects(g, {7: {"embedding": [0.95, 0.05, 0]}, 9: {"embedding": [0, 1, 0]}})
    assert ranked[0][0] == 7 and conf > 0.5


def test_single_subject_unambiguous():
    g = G.build_gallery([{"embedding": [1, 0, 0], "skeletal_stats": None, "confidence": 1.0, "revoked_at": None}])
    _, c = G.rank_subjects(g, {7: {"embedding": [0.95, 0.05, 0]}})
    assert c == 1.0


def test_empty_gallery_safe():
    assert G.rank_subjects(None, {7: {"embedding": [1, 0, 0]}}) == ([], 0.0)


def test_skeletal_tiebreaker():
    g = {"embedding": [1, 0, 0], "skeletal": [0.5, 0.4, 0.6, 0.5, 0.4], "looks": [[1, 0, 0]], "n": 1}
    ranked, _ = G.rank_subjects(g, {
        1: {"embedding": [0.8, 0.6, 0], "skeletal": [0.9, 0.9, 0.9, 0.9, 0.9]},
        2: {"embedding": [0.8, 0.6, 0], "skeletal": [0.5, 0.4, 0.6, 0.5, 0.4]},
    })
    assert ranked[0][0] == 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok {fn.__name__}")
    print(f"\n{len(fns)} gallery unit tests pass")
