// Compute the full analysis snapshot for every pair in data/pairs/:
// overall paired stats, per-slice stats, slice enrichment (Fisher exact)
// with regression exemplars, per-class breakdowns, and the default-gate
// verdict. Writes data/pairs/<slug>.snapshot.json and data/pairs/index.json.
// Deterministic: fixed seeds everywhere. The analysis lives in src/analyze.ts
// so the committed artifacts, the browser recompute and the CLI all share it.
// Usage: npm run build && node scripts/compute-snapshot.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { analyze } from '../dist/src/analyze.js';

const slugs = readdirSync('data/pairs')
  .filter((f) => f.endsWith('.golden.json'))
  .map((f) => f.replace(/\.golden\.json$/, ''))
  .sort();

const index = [];
for (const slug of slugs) {
  const golden = JSON.parse(readFileSync(`data/pairs/${slug}.golden.json`, 'utf8'));
  const snap = analyze(golden);
  writeFileSync(`data/pairs/${slug}.snapshot.json`, JSON.stringify(snap));

  const entry = {
    slug,
    title: snap.title,
    task: snap.task,
    unit: snap.unit ?? null,
    n: snap.n,
    generated: snap.generated,
    ship: snap.verdict.ship,
    headline: snap.verdict.headline,
  };
  if (snap.task === 'classification') {
    Object.assign(entry, {
      v1Label: golden.variants?.v1 ?? golden.pipeline?.v1 ?? 'v1',
      v2Label: golden.variants?.v2 ?? golden.pipeline?.v2 ?? 'v2',
      accV1: snap.accV1,
      accV2: snap.accV2,
      delta: snap.delta,
      ciLo: snap.ci.lo,
      ciHi: snap.ci.hi,
      p: snap.mcnemar.pExact,
    });
  } else {
    Object.assign(entry, {
      v1Label: golden.pipeline?.v1 ?? 'v1',
      v2Label: golden.pipeline?.v2 ?? 'v2',
      maeV1: snap.maeV1,
      maeV2: snap.maeV2,
      errDelta: snap.errDelta,
      ciLo: snap.ci.lo,
      ciHi: snap.ci.hi,
      p: snap.sign.pExact,
    });
  }
  index.push(entry);

  const line = snap.task === 'classification'
    ? `acc ${(snap.accV1 * 100).toFixed(2)} -> ${(snap.accV2 * 100).toFixed(2)} | ` +
      `delta ${(snap.delta * 100).toFixed(2)} pts [${(snap.ci.lo * 100).toFixed(2)}, ${(snap.ci.hi * 100).toFixed(2)}] | ` +
      `McNemar ${snap.mcnemar.b10}/${snap.mcnemar.b01} p=${snap.mcnemar.pExact.toFixed(4)}`
    : `MAE ${snap.maeV1.toFixed(4)} -> ${snap.maeV2.toFixed(4)} ${snap.unit} | ` +
      `err delta ${snap.errDelta >= 0 ? '+' : ''}${snap.errDelta.toFixed(4)} [${snap.ci.lo.toFixed(4)}, ${snap.ci.hi.toFixed(4)}] | ` +
      `sign ${snap.sign.worse}/${snap.sign.better} p=${snap.sign.pExact.toFixed(5)}`;
  console.log(`${slug}: ${snap.n} rows | ${line} | ${snap.verdict.ship ? 'SHIP' : 'HOLD'}`);
}

writeFileSync('data/pairs/index.json', JSON.stringify({ pairs: index }));
console.log(`wrote ${slugs.length} snapshots + index`);
