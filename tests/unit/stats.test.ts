import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapDelta, mcnemar, chi2df1SF, erfc, exactTwoSidedBinomial,
  cohensH, mulberry32, verdict, histogram, sliceStats, meanDelta,
} from '../../src/stats.js';

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const x = a(), y = b();
    assert.equal(x, y);
    assert.ok(x >= 0 && x < 1);
  }
});

test('erfc matches known values', () => {
  assert.ok(Math.abs(erfc(0) - 1) < 1e-7);
  assert.ok(Math.abs(erfc(1) - 0.15729920705028513) < 1e-6);
  assert.ok(Math.abs(erfc(2) - 0.004677734981047266) < 1e-6);
  assert.ok(Math.abs(erfc(-1) - 1.8427007929497148) < 1e-6);
});

test('chi2df1SF matches textbook table values', () => {
  // chi2 df=1: 3.841 -> 0.05, 6.635 -> 0.01, 5.024 -> 0.025
  assert.ok(Math.abs(chi2df1SF(3.841) - 0.05) < 5e-4);
  assert.ok(Math.abs(chi2df1SF(6.635) - 0.01) < 5e-4);
  assert.ok(Math.abs(chi2df1SF(5.024) - 0.025) < 5e-4);
  assert.equal(chi2df1SF(0), 1);
});

test('mcnemar on the real golden set: 4 improvements, 17 regressions', () => {
  const r = mcnemar(4, 17);
  // chi2 with continuity correction = (|17-4|-1)^2 / 21 = 144/21 = 6.857
  assert.ok(Math.abs(r.chi2 - 6.857142857) < 1e-6);
  assert.ok(r.pChi2 < 0.01); // ~0.0088
  // exact two-sided binomial: 2 * P(X <= 4; n=21, p=0.5) = 0.00718
  assert.ok(Math.abs(r.pExact - 0.0071973801) < 1e-6, `pExact=${r.pExact}`);
});

test('mcnemar with no discordance is p=1', () => {
  const r = mcnemar(0, 0);
  assert.equal(r.pChi2, 1);
  assert.equal(r.pExact, 1);
});

test('exactTwoSidedBinomial known value: 2*P(X<=2; n=10, p=0.5)=0.109375', () => {
  assert.ok(Math.abs(exactTwoSidedBinomial(2, 10, 0.5) - 0.109375) < 1e-12);
});

test('cohensH known value', () => {
  // h = 2*(asin(sqrt(0.9)) - asin(sqrt(0.6))) ~ 0.7328
  assert.ok(Math.abs(cohensH(0.6, 0.9) - 0.7259372972) < 1e-5);
});

test('bootstrapDelta is deterministic for a fixed seed', () => {
  const pairs = [
    { v1: 1 as const, v2: 0 as const }, { v1: 1 as const, v2: 0 as const },
    { v1: 1 as const, v2: 1 as const }, { v1: 0 as const, v2: 1 as const },
    { v1: 1 as const, v2: 1 as const }, { v1: 0 as const, v2: 0 as const },
  ];
  const a = bootstrapDelta(pairs, 2000, 99);
  const b = bootstrapDelta(pairs, 2000, 99);
  assert.equal(a.lo, b.lo);
  assert.equal(a.hi, b.hi);
  assert.equal(a.deltas.length, 2000);
  // sum(v2-v1) = -1-1+0+1+0+0 = -1 => delta = -1/6
  assert.ok(Math.abs(meanDelta(pairs) + 1 / 6) < 1e-12);
});

test('bootstrap CI contains the point estimate and brackets zero for noise', () => {
  // balanced noise: equal regressions and improvements -> CI should straddle 0
  const pairs = [];
  for (let i = 0; i < 50; i++) pairs.push({ v1: 1 as const, v2: 0 as const });
  for (let i = 0; i < 50; i++) pairs.push({ v1: 0 as const, v2: 1 as const });
  for (let i = 0; i < 100; i++) pairs.push({ v1: 1 as const, v2: 1 as const });
  const r = bootstrapDelta(pairs, 4000, 7);
  assert.ok(r.lo < 0 && r.hi > 0);
  assert.ok(Math.abs(r.delta) < 1e-12);
});

test('bootstrap CI excludes zero for a real regression', () => {
  const pairs = [];
  for (let i = 0; i < 17; i++) pairs.push({ v1: 1 as const, v2: 0 as const });
  for (let i = 0; i < 4; i++) pairs.push({ v1: 0 as const, v2: 1 as const });
  for (let i = 0; i < 851; i++) pairs.push({ v1: 1 as const, v2: 1 as const });
  const r = bootstrapDelta(pairs, 10000, 1337);
  assert.ok(r.hi < 0, `hi=${r.hi} should be < 0`);
  assert.ok(r.lo < r.delta && r.delta < r.hi);
});

test('histogram bins sum to the input length', () => {
  const values = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 3);
  const h = histogram(values, 20);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 1000);
  assert.equal(h.counts.length, 20);
});

test('sliceStats groups, sorts by delta ascending, counts discordance', () => {
  const examples = [
    { slice: 'a', v1: 1 as const, v2: 0 as const },
    { slice: 'a', v1: 1 as const, v2: 1 as const },
    { slice: 'b', v1: 0 as const, v2: 1 as const },
    { slice: 'b', v1: 1 as const, v2: 1 as const },
  ];
  const s = sliceStats(examples, 500, 11);
  assert.ok(s[0] && s[1]);
  assert.equal(s.length, 2);
  assert.equal(s[0]!.slice, 'a'); // a has delta -0.5, b has +0.5
  assert.equal(s[0]!.regressions, 1);
  assert.equal(s[1]!.improvements, 1);
  assert.ok(Math.abs(s[0]!.accV1 - 1) < 1e-12);
  assert.ok(Math.abs(s[0]!.accV2 - 0.5) < 1e-12);
});

test('verdict holds a significant regression', () => {
  const v = verdict(
    { delta: -0.0149, ciLo: -0.026, ciHi: -0.0046, pMcnemar: 0.0072, regressions: 17, improvements: 4 },
    { maxDrop: 0.005, alpha: 0.05 },
  );
  assert.equal(v.ship, false);
  assert.match(v.headline, /Hold/);
  assert.equal(v.reasons.length, 2);
});

test('verdict ships when discordance is noise and CI is within tolerance', () => {
  const v = verdict(
    { delta: -0.001, ciLo: -0.004, ciHi: 0.002, pMcnemar: 0.6, regressions: 5, improvements: 4 },
    { maxDrop: 0.005, alpha: 0.05 },
  );
  assert.equal(v.ship, true);
  assert.match(v.headline, /Ship/);
});

test('verdict holds when the CI breaches tolerance even without significance', () => {
  const v = verdict(
    { delta: -0.03, ciLo: -0.06, ciHi: 0.001, pMcnemar: 0.2, regressions: 8, improvements: 3 },
    { maxDrop: 0.005, alpha: 0.05 },
  );
  assert.equal(v.ship, false);
});

test('fisherEnrichment matches the textbook 2x2 example', async () => {
  const { fisherEnrichment } = await import('../../src/stats.js');
  // classic enrichment table [9,1;3,11]: one-sided 'greater' p = 0.00137973
  // (scipy fisher_exact alternative='greater'); two-sided would be 0.00275946.
  assert.ok(Math.abs(fisherEnrichment(9, 1, 3, 11) - 0.0013797281) < 1e-6);
  // depletion orientation of the same margins is non-significant for enrichment
  assert.ok(fisherEnrichment(1, 9, 11, 3) > 0.99);
});

test('fisherEnrichment: even split gives a non-significant p', async () => {
  const { fisherEnrichment } = await import('../../src/stats.js');
  // [5,95;5,95] - slice rate equals background exactly
  const p = fisherEnrichment(5, 95, 5, 95);
  assert.ok(p > 0.4, `p=${p}`);
});

test('sliceEnrichment ranks the concentrated slice first', async () => {
  const { sliceEnrichment } = await import('../../src/stats.js');
  const examples = [
    ...Array.from({ length: 20 }, () => ({ slice: 'negation', regressed: false })),
    ...Array.from({ length: 6 }, () => ({ slice: 'negation', regressed: true })),
    ...Array.from({ length: 200 }, () => ({ slice: 'plain', regressed: false })),
    ...Array.from({ length: 4 }, () => ({ slice: 'plain', regressed: true })),
  ];
  const s = sliceEnrichment(examples);
  assert.equal(s[0]!.slice, 'negation');
  assert.ok(s[0]!.fisherP < 0.001, `p=${s[0]!.fisherP}`);
  assert.ok(s[0]!.ratio > 10);
});
