/**
 * CI helper: download the two pinned model builds for the live probe mirror.
 * The probe in CI fetches from this local copy (served at /hf-mirror) instead
 * of huggingface.co, whose CDN throttles datacenter IPs hard enough to blow
 * any reasonable test budget. Same pinned revision, same bytes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MODEL = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
const REV = '0b6928efcb76139cae2c6881d49cda67fe119f42';
const ROOT = new URL('..', import.meta.url).pathname;
const FILES = [
  ['config.json', true],
  ['tokenizer.json', true],
  ['tokenizer_config.json', false],
  ['vocab.txt', true],
  ['special_tokens_map.json', false],
  ['onnx/model_fp16.onnx', true],
  ['onnx/model_int8.onnx', true],
];
for (const [file, required] of FILES) {
  const dest = join(ROOT, '.model-cache', MODEL, 'resolve', REV, file);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && statSync(dest).size > 0) { console.log(`${file}: already cached`); continue; }
  const url = `https://huggingface.co/${MODEL}/resolve/${REV}/${file}`;
  const t0 = Date.now();
  try {
    execFileSync('curl', ['-fsSL', '-C', '-', '--retry', '3', '--retry-delay', '2', '--max-time', '600', '-o', dest, url], { stdio: 'inherit' });
  } catch {
    if (required) { console.error(`required file failed: ${file}`); process.exit(1); }
    console.log(`optional file absent: ${file}`);
    continue;
  }
  const mb = statSync(dest).size / 1e6;
  const s = (Date.now() - t0) / 1000;
  console.log(`${file}: ${mb.toFixed(1)} MB in ${s.toFixed(0)}s (${(mb / Math.max(s, 0.1)).toFixed(1)} MB/s)`);
}
// transformers.js requests resolve/main when a custom remoteHost is set, so
// alias the pinned revision to 'main' in the mirror.
import { symlinkSync, rmSync } from 'node:fs';
const alias = join(ROOT, '.model-cache', MODEL, 'resolve', 'main');
try { rmSync(alias, { force: true }); } catch {}
symlinkSync(REV, alias);
console.log('aliased resolve/main -> pinned revision');
