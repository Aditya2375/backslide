// Measure-first: run the fp16 and int8 builds of the pinned SST-2 checkpoint
// over the SST-2 validation split, dump paired per-example predictions.
// Usage: node scripts/measure-pair.mjs /tmp/sst2/SST-2/dev.tsv /tmp/pair-out.json
import { readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
const REV = '0b6928efcb76139cae2c6881d49cda67fe119f42';

const [tsvPath, outPath] = process.argv.slice(2);
const lines = readFileSync(tsvPath, 'utf8').trim().split('\n').slice(1);
const examples = lines.map((line, i) => {
  const tab = line.lastIndexOf('\t');
  return { id: `sst2-${i}`, text: line.slice(0, tab).trim(), label: Number(line.slice(tab + 1)) };
});
console.log(`${examples.length} examples`);

const opts = { revision: REV };
console.log('loading fp16...');
const v1 = await pipeline('text-classification', MODEL, { ...opts, dtype: 'fp16' });
console.log('loading int8...');
const v2 = await pipeline('text-classification', MODEL, { ...opts, dtype: 'int8' });

const out = [];
let agree = 0, v1Correct = 0, v2Correct = 0, b01 = 0, b10 = 0;
for (let i = 0; i < examples.length; i++) {
  const ex = examples[i];
  const r1 = await v1(ex.text);
  const r2 = await v2(ex.text);
  const p1 = r1[0].label === 'POSITIVE' ? 1 : 0;
  const p2 = r2[0].label === 'POSITIVE' ? 1 : 0;
  const c1 = p1 === ex.label ? 1 : 0;
  const c2 = p2 === ex.label ? 1 : 0;
  if (p1 === p2) agree++;
  v1Correct += c1; v2Correct += c2;
  if (c1 === 0 && c2 === 1) b01++;
  if (c1 === 1 && c2 === 0) b10++;
  out.push({
    id: ex.id, text: ex.text, label: ex.label,
    v1: { pred: p1, score: r1[0].score, correct: c1 },
    v2: { pred: p2, score: r2[0].score, correct: c2 },
  });
  if ((i + 1) % 100 === 0) console.log(`${i + 1}/${examples.length}`);
}
const n = examples.length;
console.log(JSON.stringify({
  n, v1Acc: v1Correct / n, v2Acc: v2Correct / n,
  delta: (v2Correct - v1Correct) / n, agreeRate: agree / n,
  mcnemar_b01_v2only: b01, mcnemar_b10_v1only: b10,
}, null, 2));
writeFileSync(outPath, JSON.stringify({ model: MODEL, revision: REV, examples: out }));
console.log('wrote', outPath);
