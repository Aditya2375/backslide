#!/usr/bin/env python3
"""Measure the AG News pair for backslide: a full tf-idf + logistic regression
build (v1 incumbent) against its 50%-pruned artifact (v2 candidate).

The candidate is the same fitted pipeline with the weakest half of the
features zeroed out - the classic "can we ship the half-size artifact?"
question for a classical text model. Predictions run over a fixed,
seeded 2000-row sample of the public AG News test split.

Usage: python3 scripts/measure-agnews.py /tmp/agnews-pair.json
Expects train.csv / test.csv (AG News: class,title,description) in /tmp/agnews/.
"""
import csv
import json
import re
import sys

import numpy as np
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

TRAIN = "/tmp/agnews/train.csv"
TEST = "/tmp/agnews/test.csv"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/agnews-pair.json"
GOLDEN_N = 2000
GOLDEN_SEED = 7

LABELS = ["World", "Sports", "Business", "Sci/Tech"]


def load(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for cls, title, desc in csv.reader(f):
            rows.append((int(cls) - 1, f"{title.strip()} {desc.strip()}"))
    return rows


def slice_of(text):
    tokens = len(text.split())
    if re.search(r"\d", text):
        return "numeric"
    if tokens > 60:
        return "long"
    if tokens <= 25:
        return "short"
    return "plain"


def main():
    train = load(TRAIN)
    test = load(TEST)
    print(f"train={len(train)} test={len(test)}")

    rng = np.random.default_rng(GOLDEN_SEED)
    idx = np.sort(rng.choice(len(test), GOLDEN_N, replace=False))
    golden = [test[i] for i in idx]

    vec = TfidfVectorizer(max_features=100_000, ngram_range=(1, 2), min_df=2)
    Xtr = vec.fit_transform([t for _, t in train])
    ytr = np.array([c for c, _ in train])
    clf = LogisticRegression(max_iter=1000, C=10.0)
    clf.fit(Xtr, ytr)
    print(f"vocabulary {len(vec.vocabulary_)} features")

    Xg = vec.transform([t for _, t in golden])
    y_gold = np.array([c for c, _ in golden])

    # v1: the full build
    p1 = clf.predict(Xg)
    s1 = clf.predict_proba(Xg).max(axis=1)

    # v2: the pruned build - weakest 50% of features zeroed, nothing refit
    importance = np.abs(clf.coef_).max(axis=0)
    order = np.argsort(importance, kind="stable")
    keep = np.zeros_like(importance, dtype=bool)
    keep[order[len(order) // 2:]] = True
    clf2 = LogisticRegression(max_iter=1000, C=10.0)
    clf2.classes_ = clf.classes_
    clf2.coef_ = clf.coef_ * keep
    clf2.intercept_ = clf.intercept_.copy()
    p2 = clf2.predict(Xg)
    s2 = clf2.predict_proba(Xg).max(axis=1)

    examples = []
    for i, ((label, text), a, b, sa, sb) in enumerate(zip(golden, p1, p2, s1, s2)):
        examples.append({
            "id": f"agnews-{int(idx[i])}",
            "text": text[:400],
            "label": int(label),
            "slice": slice_of(text),
            "v1": {"p": int(a), "s": round(float(sa), 4), "c": int(a == label)},
            "v2": {"p": int(b), "s": round(float(sb), 4), "c": int(b == label)},
        })

    acc1 = float(np.mean(p1 == y_gold))
    acc2 = float(np.mean(p2 == y_gold))
    out = {
        "slug": "agnews-pruned",
        "title": "AG News topic classifier: full build vs 50%-pruned build",
        "task": "classification",
        "measured": "2026-11-14",
        "pipeline": {
            "library": f"scikit-learn {sklearn.__version__}",
            "features": "tf-idf, 1-2 grams, 100k vocabulary (min_df=2)",
            "model": "logistic regression, C=10",
            "v1": "full build (100k features)",
            "v2": "pruned build: weakest 50% of features zeroed, nothing refit",
            "train": "AG News train split (120k rows)",
            "golden": f"seeded sample (seed {GOLDEN_SEED}) of {GOLDEN_N} rows from the public AG News test split",
        },
        "description": f"seeded sample (seed {GOLDEN_SEED}) of {GOLDEN_N} rows from the public AG News test split",
        "labels": LABELS,
        "slices": ["numeric", "long", "short", "plain"],
        "examples": examples,
    }
    with open(OUT, "w") as f:
        json.dump(out, f)
    b01 = sum(1 for e in examples if e["v1"]["c"] == 0 and e["v2"]["c"] == 1)
    b10 = sum(1 for e in examples if e["v1"]["c"] == 1 and e["v2"]["c"] == 0)
    print(json.dumps({
        "n": len(examples), "accV1": round(acc1, 4), "accV2": round(acc2, 4),
        "deltaPts": round((acc2 - acc1) * 100, 2), "b01": b01, "b10": b10,
    }))


if __name__ == "__main__":
    main()
