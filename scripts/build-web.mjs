/**
 * Build the self-hosted demo into docs/ (GitHub Pages serves /docs from main,
 * so the built bundle is committed):
 * 1. esbuild src/web/app.ts -> docs/app.js (IIFE, minified; stats, analysis
 *    and the lazy probe adapter are bundled from source).
 * 2. Copy index.html, style.css, the single-threaded ONNX wasm runtime, the
 *    measured data artifacts and the try-it samples.
 * 3. Fail if any runtime path index.html references is missing.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

rmSync(DOCS, { recursive: true, force: true });
mkdirSync(DOCS, { recursive: true });

await build({
  entryPoints: [join(ROOT, 'src/web/app.ts')],
  outfile: join(DOCS, 'app.js'),
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2022',
  logLevel: 'warning',
});

copyFileSync(join(ROOT, 'src/web/index.html'), join(DOCS, 'index.html'));
copyFileSync(join(ROOT, 'src/web/style.css'), join(DOCS, 'style.css'));

// ONNX runtime wasm files (single-threaded; Pages cannot send COOP/COEP).
mkdirSync(join(DOCS, 'ort'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'ort'))) {
  copyFileSync(join(ROOT, 'ort', f), join(DOCS, 'ort', f));
}

// Measured artifacts: every pair's golden set + statistics snapshot + index.
mkdirSync(join(DOCS, 'data', 'pairs'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'data', 'pairs'))) {
  copyFileSync(join(ROOT, 'data', 'pairs', f), join(DOCS, 'data', 'pairs', f));
}

// Try-it samples for the your-models tab.
mkdirSync(join(DOCS, 'samples'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'examples', 'ci-gate'))) {
  if (f.endsWith('.csv')) {
    copyFileSync(join(ROOT, 'examples', 'ci-gate', f), join(DOCS, 'samples', f));
  }
}

// Sanity: every runtime path the page needs must exist.
for (const f of [
  'app.js',
  'index.html',
  'style.css',
  'ort/ort-wasm-simd-threaded.wasm',
  'ort/ort-wasm-simd-threaded.mjs',
  'data/pairs/index.json',
  'data/pairs/sst2-int8.golden.json',
  'data/pairs/sst2-int8.snapshot.json',
  'samples/sample-classification.csv',
  'samples/sample-regression.csv',
]) {
  if (!existsSync(join(DOCS, f))) throw new Error(`docs build missing ${f}`);
}
console.log('docs build complete');
