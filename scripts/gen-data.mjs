// Build the golden-set artifacts for backslide from the measured pair output.
// Input: /tmp/pair-out.json (from measure-pair.mjs) + assigns slice tags.
// Output: data/golden.json (examples+slices+paired outcomes, compact)
// Usage: node scripts/gen-data.mjs /tmp/pair-out.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [pairPath] = process.argv.slice(2);
const { model, revision, examples } = JSON.parse(readFileSync(pairPath, 'utf8'));

const RULES = [
  ['negation', /\b(not|no|never|n't|neither|nor|without|hardly|barely|scarcely|cannot)\b/i],
  ['comparative', /\b(more|less|better|worse|most|least|than|rather|instead)\b/i],
  ['numeric', /\d/],
];
function sliceOf(text) {
  const tokens = text.split(/\s+/).length;
  for (const [name, re] of RULES) if (re.test(text)) return name;
  if (tokens > 25) return 'long';
  if (tokens <= 6) return 'short';
  return 'plain';
}

const golden = examples.map((ex) => ({
  id: ex.id,
  text: ex.text,
  label: ex.label,
  slice: sliceOf(ex.text),
  v1: { p: ex.v1.pred, s: Math.round(ex.v1.score * 1e4) / 1e4, c: ex.v1.correct },
  v2: { p: ex.v2.pred, s: Math.round(ex.v2.score * 1e4) / 1e4, c: ex.v2.correct },
}));

mkdirSync('docs/data', { recursive: true });
writeFileSync('data/golden.json', JSON.stringify({
  model, revision,
  variants: { v1: 'fp16', v2: 'int8' },
  task: 'sentiment (SST-2 validation split, GLUE benchmark)',
  slices: RULES.map(([n]) => n).concat(['long', 'short', 'plain']),
  examples: golden,
}));

const n = golden.length;
const bySlice = {};
for (const ex of golden) {
  const s = (bySlice[ex.slice] ??= { n: 0, v1: 0, v2: 0, reg: 0, imp: 0 });
  s.n++; s.v1 += ex.v1.c; s.v2 += ex.v2.c;
  if (ex.v1.c === 1 && ex.v2.c === 0) s.reg++;
  if (ex.v1.c === 0 && ex.v2.c === 1) s.imp++;
}
console.log('n =', n);
for (const [name, s] of Object.entries(bySlice)) {
  console.log(`${name.padEnd(12)} n=${String(s.n).padStart(3)} v1=${(100 * s.v1 / s.n).toFixed(1)}% v2=${(100 * s.v2 / s.n).toFixed(1)}% regressions=${s.reg} improvements=${s.imp}`);
}
const regTexts = golden.filter((e) => e.v1.c === 1 && e.v2.c === 0);
console.log('\nregression examples:');
for (const e of regTexts) console.log(` [${e.slice}] ${e.text.slice(0, 100)}`);
