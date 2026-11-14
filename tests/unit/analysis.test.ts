import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapMean, signTest, classStats, regressionSliceStats, regressionVerdict,
} from '../../src/stats.js';
import { parseCsv, resolveColumns, joinCombined, detectTask } from '../../src/parse.js';
import { analyze } from '../../src/analyze.js';

test('bootstrapMean: constant input gives a degenerate interval', () => {
  const r = bootstrapMean([0.5, 0.5, 0.5, 0.5], 1000, 1);
  assert.equal(r.mean, 0.5);
  assert.equal(r.lo, 0.5);
  assert.equal(r.hi, 0.5);
});

test('bootstrapMean: deterministic, mean exact, interval brackets the mean', () => {
  const vals = [1, -2, 3, 0.5, -0.25, 2, 1, -1];
  const a = bootstrapMean(vals, 4000, 99);
  const b = bootstrapMean(vals, 4000, 99);
  assert.equal(a.mean, vals.reduce((s, v) => s + v, 0) / vals.length);
  assert.deepEqual(a.samples, b.samples);
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  assert.ok(a.lo < a.hi);
});

test('signTest: exact binomial on known counts, ties excluded by the caller', () => {
  // 2 better vs 8 worse: 2 * P(X <= 2; n=10, p=0.5) = 0.109375
  const r = signTest(8, 2);
  assert.equal(r.n, 10);
  assert.ok(Math.abs(r.pExact - 0.109375) < 1e-9);
  // symmetric input, certain outcome
  assert.equal(signTest(0, 0).pExact, 1);
  assert.equal(signTest(20, 0).pExact < 0.0001, true);
});

test('classStats: per-class accuracy and flip counts on a toy set', () => {
  const rows: Array<{ label: number; c1: 0 | 1; c2: 0 | 1 }> = [
    { label: 0, c1: 1, c2: 1 },
    { label: 0, c1: 1, c2: 0 }, // regression
    { label: 1, c1: 0, c2: 1 }, // improvement
    { label: 1, c1: 1, c2: 1 },
    { label: 1, c1: 0, c2: 0 },
  ];
  const out = classStats(rows, ['cat', 'dog']);
  assert.equal(out.length, 2);
  const cat = out.find((c) => c.label === 'cat')!;
  const dog = out.find((c) => c.label === 'dog')!;
  assert.equal(cat.n, 2);
  assert.equal(cat.accV1, 1);
  assert.equal(cat.accV2, 0.5);
  assert.equal(cat.regressions, 1);
  assert.equal(dog.n, 3);
  assert.ok(Math.abs(dog.accV1 - 1 / 3) < 1e-9);
  assert.ok(Math.abs(dog.accV2 - 2 / 3) < 1e-9);
  assert.equal(dog.improvements, 1);
  // sorted by delta ascending: the damaged class comes first
  assert.equal(out[0]!.label, 'cat');
});

test('regressionSliceStats: per-slice error deltas sorted worst-first', () => {
  const rows = [
    { slice: 'cheap', err1: 1, err2: 1.5 },
    { slice: 'cheap', err1: 1, err2: 1.5 },
    { slice: 'pricey', err1: 2, err2: 1 },
    { slice: 'pricey', err1: 2, err2: 2 },
  ];
  const out = regressionSliceStats(rows, 500, 7);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.slice, 'cheap'); // +0.5 delta sorts before -0.5/0
  assert.ok(Math.abs(out[0]!.delta - 0.5) < 1e-9);
  assert.equal(out[0]!.worse, 2);
  assert.equal(out[0]!.better, 0);
  assert.equal(out[1]!.worse, 0);
  assert.equal(out[1]!.better, 1);
});

test('regressionVerdict: ship, hold-on-significance, hold-on-tolerance', () => {
  const base = { errDelta: 0.01, ciLo: 0.005, ciHi: 0.015, pSign: 0.4, worse: 10, better: 8, unit: 'usd' };
  // not significant and CI upper bound inside tolerance -> ship
  assert.equal(regressionVerdict(base, { maxIncrease: 0.02, alpha: 0.05 }).ship, true);
  // significant increase -> hold
  assert.equal(regressionVerdict({ ...base, pSign: 0.01 }, { maxIncrease: 0.02, alpha: 0.05 }).ship, false);
  // inconclusive but CI breaches tolerance -> hold
  assert.equal(regressionVerdict({ ...base, ciHi: 0.03 }, { maxIncrease: 0.02, alpha: 0.05 }).ship, false);
  assert.equal(
    regressionVerdict(base, { maxIncrease: 0.02, alpha: 0.05 }).reasons.length,
    2,
  );
});

test('parseCsv: quotes, escaped quotes, CRLF, ragged final line', () => {
  const rows = parseCsv('id,gold,v1,v2\r\n"a","b,1","say ""hi""",x\nlast,1,2,3');
  assert.deepEqual(rows[0], ['id', 'gold', 'v1', 'v2']);
  assert.deepEqual(rows[1], ['a', 'b,1', 'say "hi"', 'x']);
  assert.deepEqual(rows[2], ['last', '1', '2', '3']);
});

test('parseCsv: size and row caps', () => {
  assert.throws(() => parseCsv('x'.repeat(1024), 512), /too large/);
  const big = 'id,gold,v1,v2\n' + Array.from({ length: 20001 }, (_, i) => `r${i},1,1,1`).join('\n');
  assert.throws(() => parseCsv(big, Infinity), /too many rows/);
});

test('resolveColumns: canonical names and aliases', () => {
  const c = resolveColumns(['id', 'gold', 'v1', 'v2', 'slice']);
  assert.deepEqual(c, { id: 0, gold: 1, v1: 2, v2: 3, slice: 4 });
  const a = resolveColumns(['example', 'label', 'baseline', 'candidate']);
  assert.equal(a.gold, 1);
  assert.equal(a.v1, 2);
  assert.equal(a.v2, 3);
  assert.equal(a.slice, -1);
  assert.throws(() => resolveColumns(['id', 'gold', 'v1']), /gold\/v1\/v2/);
});

test('joinCombined: joins rows, rejects duplicates', () => {
  const rows = parseCsv('id,gold,v1,v2\na,1,1,0\nb,0,0,0');
  const joined = joinCombined(rows);
  assert.equal(joined.length, 2);
  assert.equal(joined[0]!.id, 'a');
  assert.equal(joined[1]!.gold, '0');
  assert.throws(() => joinCombined(parseCsv('id,gold,v1,v2\na,1,1,1\na,0,0,0')), /duplicate id/);
});

test('detectTask: strings classify, many numerics regress, few integers classify', () => {
  const mk = (gold: string, v1: string, v2: string) => [{ id: 'x', gold, v1, v2, slice: null }];
  assert.equal(detectTask(mk('cat', 'cat', 'dog')), 'classification');
  assert.equal(detectTask(mk('1', '1', '2')), 'classification');
  const regRows = Array.from({ length: 30 }, (_, i) => ({
    id: `r${i}`, gold: String(i * 1.5), v1: String(i * 1.5), v2: String(i * 1.5 + 0.1), slice: null,
  }));
  assert.equal(detectTask(regRows), 'regression');
});

test('analyze classification: tiny golden reproduces hand-computed stats', () => {
  const golden = {
    slug: 'toy', title: 'toy', task: 'classification', measured: 'toy',
    labels: ['n', 'p'],
    examples: [
      { id: '1', text: 'a', label: 1, slice: 's', v1: { p: 1, s: 0.9, c: 1 }, v2: { p: 1, s: 0.8, c: 1 } },
      { id: '2', text: 'b', label: 1, slice: 's', v1: { p: 1, s: 0.9, c: 1 }, v2: { p: 0, s: 0.6, c: 0 } },
      { id: '3', text: 'c', label: 0, slice: 't', v1: { p: 1, s: 0.7, c: 0 }, v2: { p: 0, s: 0.6, c: 1 } },
    ],
  };
  const s = analyze(golden, { bootResamples: 500 });
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.accV1 - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.accV2 - 2 / 3) < 1e-9);
  assert.equal(s.delta, 0);
  assert.equal(s.mcnemar.b01, 1);
  assert.equal(s.mcnemar.b10, 1);
  assert.equal(s.mcnemar.pExact, 1);
  assert.equal(s.classes.length, 2);
  // with 3 examples the CI is far wider than the 0.5-pt tolerance, so the
  // gate honestly refuses to ship even at delta 0
  assert.equal(s.verdict.ship, false);
  assert.ok(s.verdict.headline.includes('Inconclusive'));
});

test('analyze regression: tiny golden reproduces hand-computed stats', () => {
  const golden = {
    slug: 'toy', title: 'toy', task: 'regression', unit: 'u', measured: 'toy',
    examples: [
      { id: '1', text: 'a', label: 10, slice: 's', v1: { pred: 10, err: 0 }, v2: { pred: 11, err: 1 } },
      { id: '2', text: 'b', label: 20, slice: 's', v1: { pred: 18, err: 2 }, v2: { pred: 21, err: 1 } },
      { id: '3', text: 'c', label: 30, slice: 't', v1: { pred: 33, err: 3 }, v2: { pred: 31, err: 1 } },
    ],
  };
  const s = analyze(golden, { bootResamples: 500 });
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.maeV1 - 5 / 3) < 1e-9);
  assert.ok(Math.abs(s.maeV2 - 1) < 1e-9);
  assert.ok(Math.abs(s.errDelta - (1 - 5 / 3)) < 1e-9);
  assert.equal(s.sign.worse, 1);
  assert.equal(s.sign.better, 2);
  assert.equal(s.sign.ties, 0);
  assert.equal(s.task, 'regression');
});
