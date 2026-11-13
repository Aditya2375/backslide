# backslide

**Prove whether a new model build regresses - with paired statistics, not vibes.**

Live demo: **https://aditya2375.github.io/backslide/**

Teams ship quantized, pruned and fine-tuned model builds on faith: aggregate accuracy moved a point, nobody knows where, and the regression surfaces in production. backslide is a regression gate: it runs the incumbent and candidate builds over the same golden set, pairs predictions example by example, and turns the comparison into a ship/hold verdict backed by a bootstrap confidence interval and an exact McNemar test. The whole analysis runs client-side in the browser against pinned model revisions - no servers, no API keys.

## The worked example

The candidate is the **int8-quantized build** of `Xenova/distilbert-base-uncased-finetuned-sst-2-english` (revision `0b6928ef`), the incumbent its **full-precision (fp16)** build - the canonical "should we ship the half-size artifact?" question (67 MB int8 vs 134 MB fp16). Golden set: the GLUE SST-2 validation split, 872 real labeled movie-review sentences.

| evidence | value |
| --- | --- |
| v1 accuracy (fp16) | 91.06% |
| v2 accuracy (int8) | 89.56% |
| paired delta | -1.49 pts, 95% CI [-2.52, -0.46] |
| McNemar discordance | 17 regressions vs 4 improvements |
| McNemar p (exact / chi-square) | 0.0072 / 0.0088 |
| Cohen's h | -0.050 |
| **verdict (maxDrop 0.5 pts, alpha 0.05)** | **hold the build** |

The aggregate effect is small (h = -0.05), which is exactly why averages mislead: the regressions concentrate in the **negation slice** (6 of 180 sentences, 2.1x the base regression rate; Fisher exact p = 0.117 with only 17 flips total - suggestive, not proof, and the demo says so). The int8 build quietly gets worse at "not without its charms" sentences while looking fine overall.

## What the demo shows

- **Verdict** - the promotion gate: ship only if the discordance is not significant *and* the CI lower bound stays within the tolerated drop. Tune the tolerance and significance level; the verdict recomputes from the same evidence.
- **Examples** - all 21 sentences where the builds disagree, filterable by kind and slice, plus a live probe that runs both pinned builds on your own sentence (downloads ~200 MB of weights, cached afterwards).
- **Statistics** - the bootstrap histogram with the CI shaded, the McNemar 2x2 with the off-diagonal cells that carry all the signal, effect size and agreement.
- **Failure slices** - per-slice deltas with bootstrap intervals (forest plot), regression-rate enrichment with one-sided Fisher exact p-values, and real exemplar sentences.
- **Method** - pins, seeds, formulas, reproduction commands and honest limits.

## Why paired statistics

Comparing two accuracy numbers from separate runs throws away the pairing and needs thousands of examples to resolve a one-point gap. Pairing on the same sentences makes only the 21 discordant examples carry the signal - 17 against 4 is decisive (p = 0.0072) on a golden set of 872.

```
ship  iff  McNemar p >= alpha  AND  CI lower bound >= -maxDrop
```

The gate is honest both ways: a significant regression holds the build, and an inconclusive comparison says so instead of guessing.

## Quickstart

```sh
npm ci
npm run build          # type-check + compile
npm test               # 18 unit tests (statistics against known values)
node scripts/build-web.mjs
node tests/browser-smoke.mjs   # 17 end-to-end checks in headless Chrome
SMOKE_LIVE=1 node tests/browser-smoke.mjs   # +2 checks: live probe with both pinned builds
```

Reproduce every number from the raw benchmark:

```sh
# download https://dl.fbaipublicfiles.com/glue/data/SST-2.zip and unzip to /tmp/sst2
node scripts/measure-pair.mjs /tmp/sst2/SST-2/dev.tsv /tmp/pair-out.json   # runs both pinned builds
node scripts/gen-data.mjs /tmp/pair-out.json                                # golden set + slice tags
node scripts/compute-snapshot.mjs                                           # every statistic on the page
```

CI recomputes the snapshot from the committed golden set and fails on any drift, rebuilds the site strictly from source, runs the browser smoke suite including the live probe, and scans history for secrets.

## Repository layout

```
src/stats.ts        paired bootstrap, McNemar (exact + chi-square), Cohen's h,
                    slice stats, Fisher exact enrichment, the promotion gate
src/web/            demo shell (no framework, textContent-only, canvas charts)
data/golden.json    872 labeled sentences with slice tags and paired outcomes
data/snapshot.json  every precomputed statistic (regenerate: compute-snapshot.mjs)
scripts/            measure-pair, gen-data, compute-snapshot, build-web
tests/              unit tests, browser smoke, check-docs consistency gate
docs/               built site, served by GitHub Pages
```

## Honest limits

- One model, one task. The method - paired gating on a golden set - is the point, not this particular checkpoint.
- Slice tags are transparent heuristics (negation/comparative/numeric/length rules), not human annotation; per-slice p-values are triage, not verdicts.
- The live probe runs in wasm and can drift a last-decimal score from the Node pipeline; every reported number comes from the committed Node-measured artifact.

## Guarantees

- 18 unit tests pin the statistics to known values (textbook Fisher/McNemar/erfc constants, the measured golden-set numbers).
- 17 browser smoke checks (19 with `SMOKE_LIVE=1`) cover boot, gate interactivity, filters, canvases, the live two-build probe and markup-injection safety.
- No backend, no tracking, no keys; the page's CSP allows only itself and the pinned model hosts.
