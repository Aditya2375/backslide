# backslide

**Prove whether a new model build regresses - with paired statistics, not vibes.**

Live demo: **https://aditya2375.github.io/backslide/**

Teams ship quantized, pruned and shrunk model builds on faith: the headline metric moved a point, nobody knows where, and the regression surfaces in production. backslide is a regression gate: it runs the incumbent and candidate builds over the same golden set, pairs the predictions example by example, and turns the comparison into a ship/hold verdict backed by a bootstrap confidence interval and an exact discordance test. The worked examples run client-side in the browser against pinned artifacts; your own two builds can be gated the same way - in the browser, from the CLI, or as a GitHub Action. No servers, no API keys.

## Three worked pairs, three task shapes

| pair | task | evidence | verdict (defaults) |
| --- | --- | --- | --- |
| **SST-2 sentiment: fp16 vs int8** | binary classification | 872 GLUE validation sentences | **hold** |
| **AG News topics: full vs 50%-pruned** | 4-class classification | seeded 2,000-row test sample | **ship** |
| **California housing: full vs shrunk** | regression | seeded 1,200-row hold-out sample | **hold** |

**SST-2** compares the int8-quantized build of `Xenova/distilbert-base-uncased-finetuned-sst-2-english` (revision `0b6928ef`) against its fp16 build - the canonical "ship the half-size artifact?" question (67 MB vs 134 MB):

| evidence | value |
| --- | --- |
| v1 accuracy (fp16) | 91.06% |
| v2 accuracy (int8) | 89.56% |
| paired delta | -1.49 pts, 95% CI [-2.52, -0.46] |
| McNemar discordance | 17 regressions vs 4 improvements |
| McNemar p (exact / chi-square) | 0.0072 / 0.0088 |
| Cohen's h | -0.050 |
| **verdict (maxDrop 0.5 pts, alpha 0.05)** | **hold the build** |

The aggregate effect is small (h = -0.05), which is exactly why averages mislead: the regressions concentrate in the **negation slice** (6 of 180 sentences, 2.1x the base regression rate; Fisher exact p = 0.117 with only 17 flips total - suggestive, not proof, and the demo says so).

**AG News** prunes a tf-idf + logistic-regression classifier (100k features) by zeroing the weakest 50% of features, nothing refit. Accuracy *improves* slightly (92.25% -> 92.50%, delta +0.25 pts, 95% CI [-0.15, +0.65]; McNemar 6 regressions vs 11 improvements, p = 0.3323): the half-size artifact **ships**, and the per-class breakdown shows no class paid for it (Sports -0.2 pts, the other three classes flat or better).

**California housing** shrinks a histogram gradient-boosting pricer from 600 trees / 63 leaves to 120 / 15. Mean absolute error climbs 0.2868 -> 0.3438 ($100k units), +0.0570 with 95% CI [+0.0446, +0.0693]; the sign test (760 rows worse vs 440 better) gives p < 0.0001. **Hold** - and every price band's bootstrap interval sits above zero, worst in the top band (+0.090).

## What the demo shows

- **Pair switcher** - all three worked pairs with their gate badges; every tab re-renders on the selected pair's evidence.
- **Verdict** - the promotion gate: ship only if the discordance is not significant *and* the confidence interval stays within tolerance. Tune the tolerance and significance level; the verdict recomputes from the same evidence.
- **Examples** - every example where the builds disagree (classification flips, or worst-first error changes for regression), filterable by kind and slice, plus a live probe that runs both pinned ONNX builds on your own sentence for the SST-2 pair (~200 MB of weights, cached afterwards).
- **Statistics** - the bootstrap histogram with the CI shaded, the McNemar 2x2 (or the sign-test panel for regression), per-class breakdown for multi-class pairs, effect size and agreement.
- **Failure slices** - per-slice deltas with bootstrap intervals (forest plot), regression-rate enrichment with one-sided Fisher exact p-values, and real exemplar rows.
- **Your models** - upload one CSV (`id,gold,v1,v2[,slice]`) and get the same analysis plus a markdown report, computed entirely in the page; the file is never uploaded anywhere.
- **Method** - pins, seeds, formulas, CLI and Action usage, reproduction commands and honest limits.

## Why paired statistics

Comparing two accuracy numbers from separate runs throws away the pairing and needs thousands of examples to resolve a one-point gap. Pairing on the same sentences makes only the 21 discordant examples carry the signal - 17 against 4 is decisive (p = 0.0072) on a golden set of 872.

```
classification: ship  iff  McNemar p >= alpha  AND  CI lower bound >= -maxDrop
regression:     ship  iff  sign test p >= alpha  AND  CI upper bound <= maxIncrease
```

The gate is honest both ways: a significant regression holds the build, and an inconclusive comparison says so instead of guessing.

## Quickstart

```sh
npm ci
npm run build          # type-check + compile
npm test               # 31 unit tests (statistics against known values)
node scripts/build-web.mjs
node tests/browser-smoke.mjs   # 21 end-to-end checks in headless Chrome
SMOKE_LIVE=1 node tests/browser-smoke.mjs   # +2 checks: live probe with both pinned builds
```

## The CLI

Zero runtime dependencies; exits 0 on ship, 1 on hold, 2 on a data error - so a pipeline can gate on it directly:

```sh
node cli/backslide.mjs compare --combined preds.csv --max-drop 0.5 --md report.md
node cli/backslide.mjs compare --gold gold.csv --v1 old.csv --v2 new.csv --task regression --unit '$100k'
```

```
backslide: classification · n=400
  accuracy: 92.50% -> 93.25%  (delta 0.75 pts, 95% CI [0.00, 1.75])
  McNemar: 0 regressions vs 3 improvements, exact p=0.2500 (chi-square 0.2482)
  verdict: SHIP
```

Input format: one CSV with a header row - `id,gold,v1,v2[,slice]` (aliases accepted: `label/target`, `old/baseline`, `new/candidate`). Task auto-detection treats many-valued or fractional numeric columns as regression; override with `--task`. See `node cli/backslide.mjs` for every flag.

## The GitHub Action

```yaml
- uses: Aditya2375/backslide@v1
  with:
    combined: preds.csv
    max-drop: '0.5'
```

The composite action builds the engine, runs the gate, appends a markdown report to the job summary, and fails the job on a hold. A working example against the committed sample CSVs runs in `.github/workflows/gate-example.yml`.

## Reproduce every number

```sh
# SST-2: download https://dl.fbaipublicfiles.com/glue/data/SST-2.zip, unzip to /tmp/sst2
node scripts/measure-pair.mjs /tmp/sst2/SST-2/dev.tsv /tmp/pair-out.json   # runs both pinned builds
node scripts/gen-data.mjs /tmp/pair-out.json                                # golden set + slice tags

# AG News + housing (needs scikit-learn):
python3 scripts/measure-agnews.py /tmp/agnews-pair.json    # train/test CSVs from the AG News mirror
python3 scripts/measure-housing.py /tmp/housing-pair.json

# all statistics on the page and in this README:
node scripts/compute-snapshot.mjs
node scripts/gen-samples.mjs    # try-it sample CSVs
```

CI recomputes every snapshot from the committed golden sets and fails on any drift, rebuilds the site strictly from source, runs the browser smoke suite including the live probe against a CI-local mirror of the pinned weights, and scans history for secrets.

## Repository layout

```
src/stats.ts        paired bootstrap, McNemar (exact + chi-square), sign test, Cohen's h,
                    slice stats, Fisher exact enrichment, the promotion gates
src/analyze.ts      golden set -> full snapshot (shared by CI, the browser and the CLI)
src/parse.ts        CSV parsing, column resolution, task detection
src/report.ts       markdown report rendering
src/web/            demo shell (no framework, textContent-only, canvas charts)
cli/backslide.mjs   zero-dependency CLI (exit 0 ship / 1 hold / 2 error)
action.yml          composite GitHub Action wrapping the CLI
data/pairs/         per-pair golden sets, computed snapshots and the index
examples/ci-gate/   sample prediction CSVs (try-it downloads, example workflow)
scripts/            measurement, data generation, snapshot, samples, build-web
tests/              unit tests, browser smoke, check-docs consistency gate
docs/               built site, served by GitHub Pages
```

## Honest limits

- Three pairs, three task shapes - still illustrative, not exhaustive. The method - paired gating on a golden set - is the point, not these particular models.
- Slice tags are transparent heuristics (negation/comparative/numeric/length rules, price bands), not human annotation; per-slice p-values are triage, not verdicts.
- The AG News and housing pairs are measured offline with scikit-learn and committed as data; only the SST-2 pair also runs live in the browser. Browser wasm arithmetic can drift a last-decimal score from the Node pipeline; every reported number comes from the committed artifacts.
- The task auto-detection is a hint, not a truth machine: set `--task` explicitly when it matters.

## Guarantees

- 31 unit tests pin the statistics to known values (textbook Fisher/McNemar/sign-test/erfc constants, the measured golden-set numbers, parser edge cases).
- 21 browser smoke checks (23 with `SMOKE_LIVE=1`) cover boot, pair switching, gate interactivity, filters, canvases, the your-models upload flow, the live two-build probe and markup-injection safety.
- No backend, no tracking, no keys; the page's CSP allows only itself and the pinned model hosts. Uploaded CSVs are parsed as text and never leave the page.
