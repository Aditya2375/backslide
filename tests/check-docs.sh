#!/bin/sh
# check-docs.sh - the README's claims must match the code and data. When a
# pinned number changes on purpose, change it here and in README.md together.
set -eu
cd "$(dirname "$0")/.."
fail() { echo "check-docs: $1" >&2; exit 1; }

UNIT=$(npm test 2>&1 | grep -o '^# pass [0-9]*' | grep -o '[0-9]*')
[ "$UNIT" = "31" ] || fail "unit tests: README says 31, runner says $UNIT"
grep -q "31 unit tests" README.md || fail "README no longer says 31 unit tests"
grep -q "21 browser smoke checks" README.md || fail "README lost the smoke check count"
grep -q "aditya2375.github.io/backslide" README.md || fail "README lost the live demo link"

# measured pins: README claims must match the committed snapshots
node - <<'EOF' || fail "snapshots drifted from the README's pinned numbers"
const load = (s) => JSON.parse(require('fs').readFileSync(`data/pairs/${s}.snapshot.json`, 'utf8'));
const gold = (s) => JSON.parse(require('fs').readFileSync(`data/pairs/${s}.golden.json`, 'utf8'));
const near = (a, b, eps = 5e-4) => Math.abs(a - b) < eps;

// SST-2
{
  const s = load('sst2-int8');
  const g = gold('sst2-int8');
  const ok =
    s.n === 872 && g.examples.length === 872 &&
    near(s.accV1, 0.9106, 1e-3) && near(s.accV2, 0.8956, 1e-3) &&
    near(s.delta, -0.0149, 1e-3) &&
    near(s.ci.lo, -0.0252, 1e-3) && near(s.ci.hi, -0.0046, 1e-3) &&
    s.mcnemar.b10 === 17 && s.mcnemar.b01 === 4 &&
    near(s.mcnemar.pExact, 0.0072, 1e-4) && near(s.mcnemar.pChi2, 0.0088, 1e-4) &&
    near(s.cohensH, -0.0504, 1e-3) &&
    s.slices.length === 6 &&
    s.enrichment.find((e) => e.slice === 'negation' && e.regressions === 6 && e.n === 180) &&
    s.verdict.ship === false;
  if (!ok) { console.error('sst2 snapshot mismatch'); process.exit(1); }
  const disc = g.examples.filter((e) => e.v1.c !== e.v2.c).length;
  if (disc !== 21) { console.error(`discordant ${disc}`); process.exit(1); }
}
// AG News
{
  const s = load('agnews-pruned');
  const ok =
    s.n === 2000 &&
    near(s.accV1, 0.9225, 1e-3) && near(s.accV2, 0.9250, 1e-3) &&
    near(s.delta, 0.0025, 5e-4) &&
    near(s.ci.lo, -0.0015, 5e-4) && near(s.ci.hi, 0.0065, 5e-4) &&
    s.mcnemar.b10 === 6 && s.mcnemar.b01 === 11 &&
    near(s.mcnemar.pExact, 0.3323, 1e-3) &&
    s.classes.length === 4 &&
    s.classes.find((c) => c.label === 'Sports' && c.n === 487) &&
    s.verdict.ship === true;
  if (!ok) { console.error('agnews snapshot mismatch'); process.exit(1); }
}
// housing
{
  const s = load('housing-shrunk');
  const ok =
    s.n === 1200 &&
    near(s.maeV1, 0.2868, 1e-3) && near(s.maeV2, 0.3438, 1e-3) &&
    near(s.errDelta, 0.0570, 1e-3) &&
    near(s.ci.lo, 0.0446, 1e-3) && near(s.ci.hi, 0.0693, 1e-3) &&
    s.sign.worse === 760 && s.sign.better === 440 &&
    s.sign.pExact < 1e-10 &&
    s.slices.length === 4 &&
    s.slices.every((r) => r.lo > 0) &&
    s.verdict.ship === false;
  if (!ok) { console.error('housing snapshot mismatch'); process.exit(1); }
}
const idx = JSON.parse(require('fs').readFileSync('data/pairs/index.json', 'utf8'));
if (idx.pairs.length !== 3) { console.error('index must list 3 pairs'); process.exit(1); }
EOF
for pin in "91.06%" "89.56%" "-1.49" "\[-2.52, -0.46\]" "0.0072" "0.0088" "-0.050" \
           "17 regressions vs 4 improvements" "2.1x" "872" \
           "92.25% -> 92.50%" "0.3323" "6 regressions vs 11 improvements" \
           "0.2868 -> 0.3438" "+0.0570" "\[+0.0446, +0.0693\]" "760 rows worse vs 440 better"; do
  grep -q -- "$pin" README.md || fail "README lost pin: $pin"
done

# model pin agrees between the measurement script, the browser adapter and README
PIN="0b6928efcb76139cae2c6881d49cda67fe119f42"
grep -q "$PIN" scripts/measure-pair.mjs || fail "measure-pair.mjs lost the revision pin"
grep -q "$PIN" src/web/models.ts || fail "models.ts lost the revision pin"
grep -q "0b6928ef" README.md || fail "README lost the model revision"
grep -q "$PIN" data/pairs/sst2-int8.golden.json || fail "sst2 golden lost the revision pin"

# the page renders textContent-only: no HTML injection sinks in authored UI code
! grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML\|document.write" src/web/ \
  || fail "HTML injection sink found in src/web"

# built site is present and self-contained
for f in docs/index.html docs/app.js docs/style.css \
         docs/ort/ort-wasm-simd-threaded.mjs docs/ort/ort-wasm-simd-threaded.wasm \
         docs/data/pairs/index.json \
         docs/data/pairs/sst2-int8.golden.json docs/data/pairs/sst2-int8.snapshot.json \
         docs/data/pairs/agnews-pruned.golden.json docs/data/pairs/agnews-pruned.snapshot.json \
         docs/data/pairs/housing-shrunk.golden.json docs/data/pairs/housing-shrunk.snapshot.json \
         docs/samples/sample-classification.csv docs/samples/sample-regression.csv; do
  [ -s "$f" ] || fail "$f missing - run node scripts/build-web.mjs"
done
grep -q "Content-Security-Policy" docs/index.html || fail "docs/index.html lost its CSP"
grep -q "wasm-unsafe-eval" docs/index.html || fail "CSP lost the wasm permission ONNX needs"

# sample CSVs must stay derivable from the committed golden sets
node scripts/gen-samples.mjs >/dev/null
git diff --exit-code --stat examples/ci-gate/ >/dev/null || fail "sample CSVs drifted from the golden sets"

# no stray tooling mentions anywhere public-facing. Authored text only:
# minified bundles and wasm can contain look-alike bytes.
# word-match (-w) so corpus words like "misanthropic" cannot false-positive
! grep -rwli --exclude=check-docs.sh "claude\|anthropic\|chatgpt\|copilot\|impeccable\|cursor.com\|vibe.cod\|windsurf" \
  README.md SECURITY_REVIEW.md src/ scripts/ tests/ data/ action.yml cli/ examples/ \
  .github/ package.json docs/index.html docs/style.css 2>/dev/null \
  || fail "tooling mention found"
echo "check-docs ok"
