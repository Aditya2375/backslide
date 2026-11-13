// Compute the full analysis snapshot from data/golden.json:
// overall paired stats, per-slice stats, slice enrichment (Fisher exact)
// with regression exemplars, and the default-gate verdict.
// Writes data/snapshot.json. Deterministic: fixed seeds everywhere.
// Usage: npm run build && node scripts/compute-snapshot.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import {
  bootstrapDelta, mcnemar, cohensH, sliceStats, sliceEnrichment, verdict, histogram,
} from '../dist/src/stats.js';

const BOOT_RESAMPLES = 10000;
const BOOT_SEED = 1337;
const SLICE_RESAMPLES = 4000;
const SLICE_SEED = 4242;
const GATE = { maxDrop: 0.005, alpha: 0.05 };

const golden = JSON.parse(readFileSync('data/golden.json', 'utf8'));
const examples = golden.examples;

const pairs = examples.map((e) => ({ v1: e.v1.c, v2: e.v2.c }));
const boot = bootstrapDelta(pairs, BOOT_RESAMPLES, BOOT_SEED);
const b01 = examples.filter((e) => e.v1.c === 0 && e.v2.c === 1).length;
const b10 = examples.filter((e) => e.v1.c === 1 && e.v2.c === 0).length;
const mc = mcnemar(b01, b10);
const acc1 = pairs.reduce((s, p) => s + p.v1, 0) / pairs.length;
const acc2 = pairs.reduce((s, p) => s + p.v2, 0) / pairs.length;
const h = cohensH(acc1, acc2);
const tagged = examples.map((e) => ({ slice: e.slice, v1: e.v1.c, v2: e.v2.c }));
const slices = sliceStats(tagged, SLICE_RESAMPLES, SLICE_SEED);

// slice enrichment + up to 3 regression exemplars per slice
const enrich = sliceEnrichment(
  examples.map((e) => ({ slice: e.slice, regressed: e.v1.c === 1 && e.v2.c === 0 })),
);
for (const s of enrich) {
  s.exemplars = examples
    .filter((e) => e.slice === s.slice && e.v1.c === 1 && e.v2.c === 0)
    .slice(0, 3)
    .map((e) => ({ id: e.id, text: e.text, v2score: e.v2.s }));
}

const v = verdict(
  { delta: boot.delta, ciLo: boot.lo, ciHi: boot.hi, pMcnemar: mc.pExact, regressions: b10, improvements: b01 },
  GATE,
);

const snapshot = {
  generated: golden.measured,
  pins: {
    classifier: { model: golden.model, revision: golden.revision, variants: golden.variants },
    dataset: { name: 'GLUE SST-2 validation split', n: examples.length },
    bootstrap: { resamples: BOOT_RESAMPLES, seed: BOOT_SEED },
    slices: { resamples: SLICE_RESAMPLES, seed: SLICE_SEED },
    gate: GATE,
  },
  n: examples.length,
  accV1: acc1,
  accV2: acc2,
  delta: boot.delta,
  ci: { lo: boot.lo, hi: boot.hi, level: 0.95 },
  bootHistogram: histogram(boot.deltas, 60),
  mcnemar: mc,
  cohensH: h,
  slices,
  enrichment: enrich,
  verdict: v,
};
writeFileSync('data/snapshot.json', JSON.stringify(snapshot));
console.log(JSON.stringify({
  n: snapshot.n,
  accV1: +(acc1 * 100).toFixed(2),
  accV2: +(acc2 * 100).toFixed(2),
  deltaPts: +(boot.delta * 100).toFixed(2),
  ci: [+(boot.lo * 100).toFixed(2), +(boot.hi * 100).toFixed(2)],
  mcnemar: { b01: mc.b01, b10: mc.b10, pExact: +mc.pExact.toFixed(5), pChi2: +mc.pChi2.toFixed(5) },
  cohensH: +h.toFixed(4),
  enrichment: enrich.map((s) => `${s.slice}: ${s.regressions}/${s.n} rate=${(s.rate * 100).toFixed(1)}% ratio=${s.ratio.toFixed(1)}x p=${s.fisherP.toFixed(4)}`),
  verdict: v.headline,
}, null, 2));
