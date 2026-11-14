// Derive the try-it / CI sample CSVs from the committed golden sets.
// Deterministic: every Nth row, no randomness. Samples let a visitor try the
// your-models tab instantly and give the example CI workflow real inputs.
// Usage: node scripts/gen-samples.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mulberry32 } from '../dist/src/stats.js';

mkdirSync('examples/ci-gate', { recursive: true });

function esc(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pickSample(n, k, seed) {
  // deterministic seeded shuffle, take first k
  const idx = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).sort((a, b) => a - b);
}

// classification sample: AG News pair, 400 rows
{
  const g = JSON.parse(readFileSync('data/pairs/agnews-pruned.golden.json', 'utf8'));
  const rows = ['id,gold,v1,v2,slice'];
  for (const i of pickSample(g.examples.length, 400, 21)) {
    const e = g.examples[i];
    const L = (k) => g.labels[k];
    rows.push([e.id, L(e.label), L(e.v1.p), L(e.v2.p), e.slice].map(esc).join(','));
  }
  writeFileSync('examples/ci-gate/sample-classification.csv', rows.join('\n') + '\n');
  console.log('sample-classification.csv: 400 rows from agnews-pruned');
}

// regression sample: housing pair, 400 rows
{
  const g = JSON.parse(readFileSync('data/pairs/housing-shrunk.golden.json', 'utf8'));
  const rows = ['id,gold,v1,v2,slice'];
  for (const i of pickSample(g.examples.length, 400, 22)) {
    const e = g.examples[i];
    rows.push([e.id, e.label, e.v1.pred, e.v2.pred, e.slice].map(esc).join(','));
  }
  writeFileSync('examples/ci-gate/sample-regression.csv', rows.join('\n') + '\n');
  console.log('sample-regression.csv: 400 rows from housing-shrunk');
}
