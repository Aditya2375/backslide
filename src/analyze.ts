/**
 * The analysis pipeline: golden set in, full statistics snapshot out.
 * Shared three ways so every surface reports identical numbers:
 *   - scripts/compute-snapshot.mjs writes the committed artifacts
 *   - the browser recomputes for uploaded prediction files
 *   - the CLI reports and gates CI runs
 * Deterministic: fixed seeds everywhere, no clock, no randomness of its own.
 */
import {
  bootstrapDelta, bootstrapMean, mcnemar, cohensH, sliceStats, sliceEnrichment,
  regressionSliceStats, classStats, signTest, verdict, regressionVerdict, histogram,
} from './stats.js';

export const BOOT_RESAMPLES = 10000;
export const BOOT_SEED = 1337;
export const SLICE_RESAMPLES = 4000;
export const SLICE_SEED = 4242;
export const GATE_CLASSIFICATION = { maxDrop: 0.005, alpha: 0.05 };
export const GATE_REGRESSION = { maxIncrease: 0.02, alpha: 0.05 };
const TIE_EPS = 1e-9;

export interface AnalyzeOptions {
  bootResamples?: number;
  bootSeed?: number;
  sliceResamples?: number;
  sliceSeed?: number;
  gateDrop?: number;
  gateAlpha?: number;
  gateIncrease?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyGolden = any;

export function analyze(golden: AnyGolden, opts: AnalyzeOptions = {}): AnyGolden {
  return golden.task === 'regression' ? analyzeRegression(golden, opts) : analyzeClassification(golden, opts);
}

export function analyzeClassification(golden: AnyGolden, opts: AnalyzeOptions = {}): AnyGolden {
  const R = opts.bootResamples ?? BOOT_RESAMPLES;
  const S = opts.bootSeed ?? BOOT_SEED;
  const SR = opts.sliceResamples ?? SLICE_RESAMPLES;
  const SS = opts.sliceSeed ?? SLICE_SEED;
  const gate = { maxDrop: opts.gateDrop ?? GATE_CLASSIFICATION.maxDrop, alpha: opts.gateAlpha ?? GATE_CLASSIFICATION.alpha };
  const examples = golden.examples;

  const pairs = examples.map((e: AnyGolden) => ({ v1: e.v1.c, v2: e.v2.c }));
  const boot = bootstrapDelta(pairs, R, S);
  const b01 = examples.filter((e: AnyGolden) => e.v1.c === 0 && e.v2.c === 1).length;
  const b10 = examples.filter((e: AnyGolden) => e.v1.c === 1 && e.v2.c === 0).length;
  const mc = mcnemar(b01, b10);
  const acc1 = pairs.reduce((s: number, p: AnyGolden) => s + p.v1, 0) / pairs.length;
  const acc2 = pairs.reduce((s: number, p: AnyGolden) => s + p.v2, 0) / pairs.length;
  const h = cohensH(acc1, acc2);
  const tagged = examples.map((e: AnyGolden) => ({ slice: e.slice, v1: e.v1.c, v2: e.v2.c }));
  const slices = sliceStats(tagged, SR, SS);

  const enrich = sliceEnrichment(
    examples.map((e: AnyGolden) => ({ slice: e.slice, regressed: e.v1.c === 1 && e.v2.c === 0 })),
  );
  for (const s of enrich as AnyGolden[]) {
    s.exemplars = examples
      .filter((e: AnyGolden) => e.slice === s.slice && e.v1.c === 1 && e.v2.c === 0)
      .slice(0, 3)
      .map((e: AnyGolden) => ({ id: e.id, text: e.text, v2score: e.v2.s }));
  }

  const labels: string[] | undefined = golden.labels;
  const classes = labels
    ? classStats(examples.map((e: AnyGolden) => ({ label: e.label, c1: e.v1.c, c2: e.v2.c })), labels)
    : undefined;

  const v = verdict(
    { delta: boot.delta, ciLo: boot.lo, ciHi: boot.hi, pMcnemar: mc.pExact, regressions: b10, improvements: b01 },
    gate,
  );

  return {
    slug: golden.slug,
    title: golden.title,
    task: 'classification',
    generated: golden.measured,
    pins: {
      pipeline: golden.pipeline ?? { model: golden.model, revision: golden.revision, variants: golden.variants },
      dataset: { name: golden.description ?? golden.dataset ?? '', n: examples.length },
      labels: labels ?? null,
      bootstrap: { resamples: R, seed: S },
      slices: { resamples: SR, seed: SS },
      gate,
    },
    n: examples.length,
    accV1: acc1,
    accV2: acc2,
    delta: boot.delta,
    ci: { lo: boot.lo, hi: boot.hi, level: 0.95 },
    bootHistogram: histogram(boot.deltas, 60),
    mcnemar: mc,
    cohensH: h,
    classes: classes ?? null,
    slices,
    enrichment: enrich,
    verdict: v,
  };
}

export function analyzeRegression(golden: AnyGolden, opts: AnalyzeOptions = {}): AnyGolden {
  const R = opts.bootResamples ?? BOOT_RESAMPLES;
  const S = opts.bootSeed ?? BOOT_SEED;
  const SR = opts.sliceResamples ?? SLICE_RESAMPLES;
  const SS = opts.sliceSeed ?? SLICE_SEED;
  const gate = {
    maxIncrease: opts.gateIncrease ?? GATE_REGRESSION.maxIncrease,
    alpha: opts.gateAlpha ?? GATE_REGRESSION.alpha,
  };
  const unit: string = golden.unit ?? 'units';
  const examples = golden.examples;

  const deltas = examples.map((e: AnyGolden) => e.v2.err - e.v1.err);
  const boot = bootstrapMean(deltas, R, S);
  let worse = 0, better = 0, ties = 0;
  for (const e of examples as AnyGolden[]) {
    if (e.v2.err > e.v1.err + TIE_EPS) worse++;
    else if (e.v1.err > e.v2.err + TIE_EPS) better++;
    else ties++;
  }
  const st = signTest(worse, better);
  const mean = (f: (e: AnyGolden) => number): number =>
    examples.reduce((s: number, e: AnyGolden) => s + f(e), 0) / examples.length;
  const mae1 = mean((e) => e.v1.err);
  const mae2 = mean((e) => e.v2.err);
  const rmse1 = Math.sqrt(mean((e) => e.v1.err * e.v1.err));
  const rmse2 = Math.sqrt(mean((e) => e.v2.err * e.v2.err));

  const slices = regressionSliceStats(
    examples.map((e: AnyGolden) => ({ slice: e.slice, err1: e.v1.err, err2: e.v2.err })),
    SR, SS,
  );

  const enrich = sliceEnrichment(
    examples.map((e: AnyGolden) => ({ slice: e.slice, regressed: e.v2.err > e.v1.err + TIE_EPS })),
  );
  for (const s of enrich as AnyGolden[]) {
    s.exemplars = examples
      .filter((e: AnyGolden) => e.slice === s.slice && e.v2.err > e.v1.err + TIE_EPS)
      .sort((a: AnyGolden, b: AnyGolden) => (b.v2.err - b.v1.err) - (a.v2.err - a.v1.err))
      .slice(0, 3)
      .map((e: AnyGolden) => ({ id: e.id, text: e.text, v2score: e.v2.err }));
  }

  const v = regressionVerdict(
    { errDelta: boot.mean, ciLo: boot.lo, ciHi: boot.hi, pSign: st.pExact, worse, better, unit },
    gate,
  );

  return {
    slug: golden.slug,
    title: golden.title,
    task: 'regression',
    unit,
    generated: golden.measured,
    pins: {
      pipeline: golden.pipeline ?? {},
      dataset: { name: golden.description ?? '', n: examples.length },
      labels: null,
      bootstrap: { resamples: R, seed: S },
      slices: { resamples: SR, seed: SS },
      gate,
    },
    n: examples.length,
    maeV1: mae1,
    maeV2: mae2,
    rmseV1: rmse1,
    rmseV2: rmse2,
    errDelta: boot.mean,
    ci: { lo: boot.lo, hi: boot.hi, level: 0.95 },
    bootHistogram: histogram(boot.samples, 60),
    sign: { worse, better, ties, pExact: st.pExact },
    slices,
    enrichment: enrich,
    verdict: v,
  };
}
