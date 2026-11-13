#!/bin/sh
# check-docs.sh - the README's claims must match the code and data. When a
# pinned number changes on purpose, change it here and in README.md together.
set -eu
cd "$(dirname "$0")/.."
fail() { echo "check-docs: $1" >&2; exit 1; }

UNIT=$(npm test 2>&1 | grep -o '^# pass [0-9]*' | grep -o '[0-9]*')
[ "$UNIT" = "25" ] || fail "unit tests: README says 25, runner says $UNIT"
grep -q "25 unit tests" README.md || fail "README no longer says 25 unit tests"
grep -q "17 browser smoke checks" README.md || fail "README lost the smoke check count"
grep -q "aditya2375.github.io/backslide" README.md || fail "README lost the live demo link"

# measured pins: README claims must match the committed snapshot
node - <<'EOF' || fail "snapshot drifted from the README's pinned numbers"
const s = require('./data/snapshot.json');
const g = require('./data/golden.json');
const near = (a, b, eps = 5e-4) => Math.abs(a - b) < eps;
const ok =
  s.n === 872 && g.examples.length === 872 &&
  near(s.accV1, 0.9106, 1e-3) && near(s.accV2, 0.8956, 1e-3) &&
  near(s.delta, -0.0149, 1e-3) &&
  near(s.ci.lo, -0.0252, 1e-3) && near(s.ci.hi, -0.0046, 1e-3) &&
  s.mcnemar.b10 === 17 && s.mcnemar.b01 === 4 &&
  near(s.mcnemar.pExact, 0.0072, 1e-4) && near(s.mcnemar.pChi2, 0.0088, 1e-4) &&
  near(s.cohensH, -0.0504, 1e-3) &&
  s.slices.length === 6 &&
  s.enrichment.find((e) => e.slice === 'negation' && e.regressions === 6 && e.n === 180);
if (!ok) { console.error('snapshot mismatch'); process.exit(1); }
const disc = g.examples.filter((e) => e.v1.c !== e.v2.c).length;
if (disc !== 21) { console.error(`discordant ${disc}`); process.exit(1); }
EOF
for pin in "91.06%" "89.56%" "-1.49" "\[-2.52, -0.46\]" "0.0072" "0.0088" "-0.050" \
           "17 regressions vs 4 improvements" "2.1x" "872"; do
  grep -q -- "$pin" README.md || fail "README lost pin: $pin"
done

# model pin agrees between the measurement script, the browser adapter and README
PIN="0b6928efcb76139cae2c6881d49cda67fe119f42"
grep -q "$PIN" scripts/measure-pair.mjs || fail "measure-pair.mjs lost the revision pin"
grep -q "$PIN" src/web/models.ts || fail "models.ts lost the revision pin"
grep -q "0b6928ef" README.md || fail "README lost the model revision"
grep -q "$PIN" data/golden.json || fail "golden.json lost the revision pin"

# the page renders textContent-only: no HTML injection sinks in authored UI code
! grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML\|document.write" src/web/ \
  || fail "HTML injection sink found in src/web"

# built site is present and self-contained
for f in docs/index.html docs/app.js docs/style.css \
         docs/ort/ort-wasm-simd-threaded.mjs docs/ort/ort-wasm-simd-threaded.wasm \
         docs/data/golden.json docs/data/snapshot.json; do
  [ -s "$f" ] || fail "$f missing - run node scripts/build-web.mjs"
done
grep -q "Content-Security-Policy" docs/index.html || fail "docs/index.html lost its CSP"
grep -q "wasm-unsafe-eval" docs/index.html || fail "CSP lost the wasm permission ONNX needs"

# no stray tooling mentions anywhere public-facing. Authored text only:
# minified bundles and wasm can contain look-alike bytes.
# word-match (-w) so corpus words like "misanthropic" cannot false-positive
! grep -rwli --exclude=check-docs.sh "claude\|anthropic\|chatgpt\|copilot\|impeccable\|cursor.com\|vibe.cod\|windsurf" \
  README.md SECURITY_REVIEW.md src/ scripts/ tests/ data/ \
  .github/ package.json docs/index.html docs/style.css 2>/dev/null \
  || fail "tooling mention found"
echo "check-docs ok"
