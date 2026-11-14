/**
 * Markdown report rendering, shared by the browser download and the CLI.
 * Input is a snapshot from src/analyze.ts plus display names for the builds.
 */
import { fmtP } from './stats.js';

const pct = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}%`;
const pts = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}`;
const signedPts = (x: number, digits = 2): string => `${x >= 0 ? '+' : ''}${pts(x, digits)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function reportMarkdown(snap: any, names: [string, string], where: string): string {
  const s = snap;
  const L: string[] = [];
  L.push('# backslide report');
  L.push('');
  L.push(`- v1 (incumbent): ${names[0]}`);
  L.push(`- v2 (candidate): ${names[1]}`);
  L.push(`- task: ${s.task}`);
  L.push(`- golden rows: ${s.n}`);
  L.push('');
  L.push(`## Verdict: ${s.verdict.ship ? 'SHIP' : 'HOLD'}`);
  L.push('');
  L.push(s.verdict.headline);
  L.push('');
  for (const r of s.verdict.reasons) L.push(`- ${r}`);
  L.push('');
  if (s.task === 'regression') {
    L.push('| metric | v1 | v2 |');
    L.push('| --- | --- | --- |');
    L.push(`| MAE (${s.unit}) | ${s.maeV1.toFixed(4)} | ${s.maeV2.toFixed(4)} |`);
    L.push(`| RMSE (${s.unit}) | ${s.rmseV1.toFixed(4)} | ${s.rmseV2.toFixed(4)} |`);
    L.push('');
    L.push(`paired error delta ${s.errDelta >= 0 ? '+' : ''}${s.errDelta.toFixed(4)} ${s.unit}, ` +
      `95% CI [${s.ci.lo.toFixed(4)}, ${s.ci.hi.toFixed(4)}]; ` +
      `sign test ${s.sign.worse} worse / ${s.sign.better} better / ${s.sign.ties} ties, p = ${fmtP(s.sign.pExact)}.`);
  } else {
    L.push('| metric | v1 | v2 |');
    L.push('| --- | --- | --- |');
    L.push(`| accuracy | ${pct(s.accV1)} | ${pct(s.accV2)} |`);
    L.push('');
    L.push(`paired delta ${signedPts(s.delta)} pts, 95% CI [${pts(s.ci.lo)}, ${pts(s.ci.hi)}]; ` +
      `McNemar ${s.mcnemar.b10} regressions / ${s.mcnemar.b01} improvements, ` +
      `p = ${fmtP(s.mcnemar.pExact)} (chi-square ${fmtP(s.mcnemar.pChi2)}); Cohen's h ${s.cohensH.toFixed(3)}.`);
  }
  if (s.slices.length > 1) {
    L.push('');
    L.push('| slice | n | v1 | v2 | delta [95% CI] |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const row of s.slices) {
      const cells = s.task === 'regression'
        ? [row.slice, String(row.n), row.errV1.toFixed(4), row.errV2.toFixed(4),
           `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(4)} [${row.lo.toFixed(4)}, ${row.hi.toFixed(4)}]`]
        : [row.slice, String(row.n), pct(row.accV1), pct(row.accV2),
           `${signedPts(row.delta)} [${pts(row.lo)}, ${pts(row.hi)}]`];
      L.push(`| ${cells.join(' | ')} |`);
    }
  }
  L.push('');
  L.push(`computed ${where} ` +
    `(bootstrap ${s.pins.bootstrap.resamples} resamples, seed ${s.pins.bootstrap.seed}; ` +
    `gate ${s.task === 'regression'
      ? `maxIncrease ${s.pins.gate.maxIncrease} ${s.unit ?? 'units'}`
      : `maxDrop ${(s.pins.gate.maxDrop * 100).toFixed(1)} pts`}, alpha ${s.pins.gate.alpha})`);
  return L.join('\n');
}
