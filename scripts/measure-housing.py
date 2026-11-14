#!/usr/bin/env python3
"""Measure the California housing pair for backslide: a full gradient-boosting
build (v1 incumbent) against a shrunk build (v2 candidate) - fewer, smaller
trees, the shape of a model someone shrinks for serving latency.

Regression task: the golden rows carry each build's absolute error, and the
paired statistics run on the per-row error delta.

Usage: python3 scripts/measure-housing.py /tmp/housing-pair.json
"""
import json
import sys

import numpy as np
import sklearn
from sklearn.datasets import fetch_california_housing
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import train_test_split

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/housing-pair.json"
GOLDEN_N = 1200
GOLDEN_SEED = 11

V1 = dict(max_iter=600, learning_rate=0.06, max_leaf_nodes=63,
          early_stopping=False, random_state=0)
V2 = dict(max_iter=120, learning_rate=0.06, max_leaf_nodes=15,
          early_stopping=False, random_state=0)


def main():
    data = fetch_california_housing()
    X, y = data.data, data.target  # y in units of $100k
    names = data.feature_names
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42)

    rng = np.random.default_rng(GOLDEN_SEED)
    idx = np.sort(rng.choice(len(Xte), GOLDEN_N, replace=False))
    Xg, yg = Xte[idx], yte[idx]

    m1 = HistGradientBoostingRegressor(**V1).fit(Xtr, ytr)
    m2 = HistGradientBoostingRegressor(**V2).fit(Xtr, ytr)
    p1, p2 = m1.predict(Xg), m2.predict(Xg)
    e1, e2 = np.abs(p1 - yg), np.abs(p2 - yg)

    # price bands from full-dataset quartiles (deterministic, fixed forever)
    q1, q2, q3 = np.quantile(y, [0.25, 0.5, 0.75])

    def band(v):
        if v <= q1:
            return "price-low"
        if v <= q2:
            return "price-mid"
        if v <= q3:
            return "price-high"
        return "price-top"

    def describe(row):
        d = dict(zip(names, row))
        return (f"MedInc {d['MedInc']:.2f} - {d['HouseAge']:.0f} yr - "
                f"{d['AveRooms']:.1f} rooms - {d['AveBedrms']:.2f} bedrms - "
                f"pop {d['Population']:.0f} - occ {d['AveOccup']:.1f} - "
                f"{d['Latitude']:.2f}N {d['Longitude']:.2f}W")

    examples = []
    for i in range(len(Xg)):
        examples.append({
            "id": f"housing-{int(idx[i])}",
            "text": describe(Xg[i]),
            "label": round(float(yg[i]), 4),
            "slice": band(float(yg[i])),
            "v1": {"pred": round(float(p1[i]), 4), "err": round(float(e1[i]), 6)},
            "v2": {"pred": round(float(p2[i]), 4), "err": round(float(e2[i]), 6)},
        })

    out = {
        "slug": "housing-shrunk",
        "title": "California housing pricer: full build vs shrunk build",
        "task": "regression",
        "unit": "$100k",
        "measured": "2026-11-14",
        "pipeline": {
            "library": f"scikit-learn {sklearn.__version__}",
            "model": "histogram gradient boosting",
            "v1": f"full build ({V1['max_iter']} trees, {V1['max_leaf_nodes']} leaves)",
            "v2": f"shrunk build ({V2['max_iter']} trees, {V2['max_leaf_nodes']} leaves)",
            "train": "California housing, 80% split (seed 42)",
            "golden": f"seeded sample (seed {GOLDEN_SEED}) of {GOLDEN_N} rows from the 20% hold-out",
        },
        "description": f"seeded sample (seed {GOLDEN_SEED}) of {GOLDEN_N} rows from the California housing 20% hold-out",
        "slices": ["price-low", "price-mid", "price-high", "price-top"],
        "examples": examples,
    }
    with open(OUT, "w") as f:
        json.dump(out, f)
    print(json.dumps({
        "n": len(examples),
        "maeV1": round(float(e1.mean()), 4), "maeV2": round(float(e2.mean()), 4),
        "rmseV1": round(float(np.sqrt((e1 ** 2).mean())), 4),
        "rmseV2": round(float(np.sqrt((e2 ** 2).mean())), 4),
        "worse": int((e2 > e1 + 1e-9).sum()), "better": int((e1 > e2 + 1e-9).sum()),
    }))


if __name__ == "__main__":
    main()
