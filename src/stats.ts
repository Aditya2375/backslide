// Paired statistics for model regression detection.
// Everything here is deterministic: callers pass a seed, and the same inputs
// always produce the same outputs (unit-tested).

export interface PairedOutcome {
  v1: 0 | 1; // v1 correct on this example?
  v2: 0 | 1; // v2 correct on this example?
}

/** mulberry32: tiny seeded PRNG, deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired bootstrap confidence interval for the accuracy delta (v2 - v1).
 * Resamples examples with replacement, recomputes the delta each time,
 * returns the percentile interval. Deterministic for a fixed seed.
 */
export function bootstrapDelta(
  pairs: PairedOutcome[],
  resamples = 10000,
  seed = 1337,
  level = 0.95,
): { delta: number; lo: number; hi: number; level: number; resamples: number; deltas: number[] } {
  const n = pairs.length;
  const delta = meanDelta(pairs);
  const rand = mulberry32(seed);
  const deltas: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const p = pairs[(rand() * n) | 0]!;
      s1 += p.v1; s2 += p.v2;
    }
    deltas[r] = (s2 - s1) / n;
  }
  deltas.sort((a, b) => a - b);
  const alpha = 1 - level;
  const lo = quantileSorted(deltas, alpha / 2);
  const hi = quantileSorted(deltas, 1 - alpha / 2);
  return { delta, lo, hi, level, resamples, deltas };
}

export function meanDelta(pairs: PairedOutcome[]): number {
  let s = 0;
  for (const p of pairs) s += p.v2 - p.v1;
  return s / pairs.length;
}

function quantileSorted(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base]!;
  const b = sorted[Math.min(base + 1, sorted.length - 1)]!;
  return a + rest * (b - a);
}

/** Histogram of a bootstrap distribution, for rendering. */
export function histogram(values: number[], bins: number): { x0: number; dx: number; counts: number[] } {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (min === max) { min -= 1e-9; max += 1e-9; }
  const dx = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let b = ((v - min) / dx) | 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  return { x0: min, dx, counts };
}

/**
 * McNemar's test on discordant pairs.
 * b01 = examples only v2 got right (improvements),
 * b10 = examples only v1 got right (regressions).
 * Returns the chi-square statistic with continuity correction, its p-value
 * (df=1), and the exact two-sided binomial p-value (preferred when the
 * discordant count is small).
 */
export function mcnemar(b01: number, b10: number): {
  b01: number; b10: number; chi2: number; pChi2: number; pExact: number;
} {
  const n = b01 + b10;
  if (n === 0) return { b01, b10, chi2: 0, pChi2: 1, pExact: 1 };
  const chi2 = (Math.abs(b10 - b01) - 1) ** 2 / n;
  const pChi2 = chi2df1SF(chi2);
  const pExact = exactTwoSidedBinomial(Math.min(b01, b10), n, 0.5);
  return { b01, b10, chi2, pChi2, pExact };
}

/** Survival function of chi-square with df=1: P(X >= x) = erfc(sqrt(x/2)). */
export function chi2df1SF(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

/** Two-sided exact binomial test p-value: P(X <= k), n trials, doubled, capped at 1. */
export function exactTwoSidedBinomial(k: number, n: number, p: number): number {
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomPMF(i, n, p);
  return Math.min(1, 2 * tail);
}

function binomPMF(k: number, n: number, p: number): number {
  // log-domain for stability
  let logC = 0;
  for (let i = 0; i < k; i++) logC += Math.log(n - i) - Math.log(i + 1);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * Complementary error function. Abramowitz & Stegun 7.1.26,
 * max abs error 1.5e-7 - plenty for a p-value readout.
 */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return poly * Math.exp(-x * x);
}

/** Cohen's h effect size for two proportions. */
export function cohensH(p1: number, p2: number): number {
  return 2 * (Math.asin(Math.sqrt(p2)) - Math.asin(Math.sqrt(p1)));
}

export interface SliceStat {
  slice: string;
  n: number;
  accV1: number;
  accV2: number;
  delta: number;
  lo: number;
  hi: number;
  regressions: number;
  improvements: number;
}

/** Per-slice paired stats over examples tagged with a slice. */
export function sliceStats(
  examples: Array<{ slice: string; v1: 0 | 1; v2: 0 | 1 }>,
  resamples = 4000,
  seed = 4242,
): SliceStat[] {
  const bySlice = new Map<string, PairedOutcome[]>();
  for (const ex of examples) {
    const arr = bySlice.get(ex.slice) ?? [];
    arr.push({ v1: ex.v1, v2: ex.v2 });
    bySlice.set(ex.slice, arr);
  }
  const out: SliceStat[] = [];
  let i = 0;
  for (const [slice, pairs] of bySlice) {
    const b = bootstrapDelta(pairs, resamples, seed + i * 101);
    let reg = 0, imp = 0;
    for (const p of pairs) {
      if (p.v1 === 1 && p.v2 === 0) reg++;
      if (p.v1 === 0 && p.v2 === 1) imp++;
    }
    out.push({
      slice,
      n: pairs.length,
      accV1: pairs.reduce((s, p) => s + p.v1, 0) / pairs.length,
      accV2: pairs.reduce((s, p) => s + p.v2, 0) / pairs.length,
      delta: b.delta, lo: b.lo, hi: b.hi,
      regressions: reg, improvements: imp,
    });
    i++;
  }
  return out.sort((a, b) => a.delta - b.delta);
}

export interface GateConfig {
  /** Largest tolerable accuracy drop, as a fraction (0.01 = one point). */
  maxDrop: number;
  /** Significance level for the McNemar p-value. */
  alpha: number;
}

export interface VerdictInput {
  delta: number;
  ciLo: number;
  ciHi: number;
  pMcnemar: number;
  regressions: number;
  improvements: number;
}

export interface Verdict {
  ship: boolean;
  headline: string;
  reasons: string[];
}

/**
 * Promotion gate. Ship only if the CI's lower bound stays within the
 * tolerated drop AND the discordance is not statistically significant.
 * Honest both ways: a significant regression holds the build, and an
 * inconclusive one says so instead of guessing.
 */
export function verdict(input: VerdictInput, gate: GateConfig): Verdict {
  const significant = input.pMcnemar < gate.alpha;
  const withinTolerance = input.ciLo >= -gate.maxDrop;
  const reasons: string[] = [];
  if (significant) {
    reasons.push(
      `McNemar p=${fmtP(input.pMcnemar)} < ${gate.alpha}: the ${input.regressions} regressions vs ` +
      `${input.improvements} improvements are not noise.`,
    );
  } else {
    reasons.push(
      `McNemar p=${fmtP(input.pMcnemar)} >= ${gate.alpha}: discordance is consistent with chance.`,
    );
  }
  if (withinTolerance) {
    reasons.push(
      `95% CI lower bound ${(input.ciLo * 100).toFixed(1)} pts stays within the tolerated ` +
      `${(gate.maxDrop * 100).toFixed(1)}-pt drop.`,
    );
  } else {
    reasons.push(
      `95% CI lower bound ${(input.ciLo * 100).toFixed(1)} pts breaches the tolerated ` +
      `${(gate.maxDrop * 100).toFixed(1)}-pt drop.`,
    );
  }
  const ship = !significant && withinTolerance;
  const pts = (input.delta * 100).toFixed(1);
  const headline = ship
    ? `Ship it. No significant regression (delta ${pts} pts).`
    : significant && !withinTolerance
      ? `Hold the build. Significant regression (delta ${pts} pts).`
      : significant
        ? `Hold the build. Discordance is significant (delta ${pts} pts).`
        : `Hold the build. Inconclusive, but the CI breaches the tolerated drop (delta ${pts} pts).`;
  return { ship, headline, reasons };
}

export function fmtP(p: number): string {
  if (p < 0.0001) return '<0.0001';
  return p.toFixed(4);
}

/**
 * One-sided Fisher exact test: probability of seeing at least `a` regressions
 * in the slice, given the margins of the 2x2 table
 *   [a, b; c, d] = [regressions in slice, non-reg in slice, reg outside, non-reg outside]
 * Hypergeometric tail. Exact, no approximation - right for small counts.
 */
export function fisherEnrichment(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const r1 = a + b; // slice size
  const c1 = a + c; // total regressions
  // P(X >= a), X ~ Hypergeom(n, c1, r1)
  const maxX = Math.min(r1, c1);
  let p = 0;
  for (let x = a; x <= maxX; x++) p += hypergeomPMF(x, n, c1, r1);
  return Math.min(1, p);
}

function hypergeomPMF(x: number, n: number, K: number, draws: number): number {
  // P(X=x) = C(K,x) C(n-K, draws-x) / C(n, draws)
  const lb = Math.max(0, draws - (n - K));
  if (x < lb || x > Math.min(K, draws)) return 0;
  return Math.exp(logChoose(K, x) + logChoose(n - K, draws - x) - logChoose(n, draws));
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

export interface SliceEnrichment {
  slice: string;
  n: number;
  regressions: number;
  rate: number;
  baselineRate: number;
  ratio: number;
  fisherP: number;
}

/**
 * Regression-rate enrichment per slice: how concentrated regressions are in
 * each capability slice vs the rest of the set, with Fisher exact p-values.
 * Sorted by regression count descending.
 */
export function sliceEnrichment(
  examples: Array<{ slice: string; regressed: boolean }>,
): SliceEnrichment[] {
  const totalReg = examples.filter((e) => e.regressed).length;
  const n = examples.length;
  const bySlice = new Map<string, { n: number; reg: number }>();
  for (const e of examples) {
    const s = bySlice.get(e.slice) ?? { n: 0, reg: 0 };
    s.n++;
    if (e.regressed) s.reg++;
    bySlice.set(e.slice, s);
  }
  const out: SliceEnrichment[] = [];
  for (const [slice, s] of bySlice) {
    const p = fisherEnrichment(s.reg, s.n - s.reg, totalReg - s.reg, n - s.n - (totalReg - s.reg));
    out.push({
      slice,
      n: s.n,
      regressions: s.reg,
      rate: s.reg / s.n,
      baselineRate: (totalReg - s.reg) / (n - s.n),
      ratio: s.reg > 0 ? (s.reg / s.n) / Math.max(1e-12, (totalReg - s.reg) / (n - s.n)) : 0,
      fisherP: p,
    });
  }
  return out.sort((a, b) => b.regressions - a.regressions || a.fisherP - b.fisherP);
}
