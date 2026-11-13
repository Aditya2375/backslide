/**
 * Browser smoke test: serves docs/, drives headless Chrome over CDP, and
 * checks the demo actually works - boot, verdict + gate interactivity,
 * discordant-example filters, both canvases, McNemar grid, slice table,
 * exemplars, method tab, no page exceptions. Runs locally and in CI
 * (ubuntu-latest ships google-chrome). No npm deps.
 *
 * The live two-build probe downloads ~200 MB of pinned model weights, so it
 * runs only with SMOKE_LIVE=1 (CI sets it and mirrors the weights locally first); local quick runs skip it.
 */
import { spawn } from 'node:child_process';
import { symlinkSync, rmSync } from 'node:fs';

const HTTP_PORT = 8937;
const CDP_PORT = 9339;
const LIVE = process.env.SMOKE_LIVE === '1';
const root = new URL('..', import.meta.url).pathname;

const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1', '--directory', `${root}docs`], { stdio: 'ignore' });
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

const cleanup = (code) => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
  process.exit(code);
};
setTimeout(() => { console.error('smoke: timeout'); cleanup(1); }, LIVE ? 600000 : 120000);
process.on('SIGINT', () => cleanup(2));

async function waitFor(fn, label, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'NOT OK'} - ${name}${detail ? ' - ' + detail : ''}`);
};

await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 'chrome devtools');
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let mid = 0;
const rpcPending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && rpcPending.has(msg.id)) {
    rpcPending.get(msg.id)(msg);
    rpcPending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'page exception');
  }
};
const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = ++mid;
  rpcPending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
};

await cdp('Runtime.enable');
await cdp('Page.enable');
if (LIVE) {
  // Mirror of the pinned weights, downloaded by scripts/download-models.mjs.
  const link = `${root}docs/hf-mirror`;
  try { rmSync(link, { force: true }); } catch {}
  symlinkSync('../.model-cache', link);
}
await cdp('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/${LIVE ? '?modelBase=/hf-mirror' : ''}` });

// Boot: artifacts load and the meta line carries the pinned evidence.
await waitFor(() => evaluate(`(document.getElementById('boot-stats').textContent || '').includes('McNemar p=0.0072')`), 'boot');
check('boot loads golden set and snapshot', true);

// Verdict tab.
const banner = await evaluate(`({
  cls: document.getElementById('verdict-banner').className,
  head: document.querySelector('#verdict-banner .gb-head').textContent,
  reasons: document.querySelectorAll('#gate-reasons li').length,
  cards: document.querySelectorAll('#verdict-stats .stat').length,
})`);
check('verdict banner holds the build', banner.cls.includes('hold') && banner.head.startsWith('Hold the build.'), banner.head);
check('gate shows both reasons', banner.reasons === 2, String(banner.reasons));
check('verdict stat grid renders 6 cards', banner.cards === 6, String(banner.cards));
const acc = await evaluate(`[...document.querySelectorAll('#verdict-stats .stat-v')].slice(0,2).map(e => e.textContent)`);
check('stat cards carry the measured accuracies', acc[0] === '91.06%' && acc[1] === '89.56%', acc.join(' / '));

// Gate interactivity: widening tolerance past the CI flips the CI reason.
await evaluate(`(() => {
  const s = document.getElementById('gate-drop');
  s.value = '3';
  s.dispatchEvent(new Event('input'));
})()`);
const reason2 = await evaluate(`document.querySelectorAll('#gate-reasons .t-detail')[1].textContent`);
check('widening tolerance flips the CI reason', reason2.includes('stays within the tolerated 3.0-pt drop'), reason2);
const stillHold = await evaluate(`document.querySelector('#verdict-banner .gb-head').textContent`);
check('significance still holds the build at loose tolerance', stillHold.startsWith('Hold the build.'), stillHold);

// Examples tab: 21 discordant sentences, filters work.
await evaluate(`document.querySelector('.tab[data-tab="examples"]').click()`);
const counts = await evaluate(`({
  all: document.querySelectorAll('#example-list .g-row').length,
  chips: document.querySelectorAll('#example-filters .chip').length,
  discord: document.getElementById('discord-count').textContent,
})`);
check('all 21 discordant sentences render', counts.all === 21 && counts.discord === '21', JSON.stringify(counts));
await evaluate(`[...document.querySelectorAll('#example-filters .chip')].find(c => c.textContent.startsWith('regressions')).click()`);
const regs = await evaluate(`document.querySelectorAll('#example-list .g-row').length`);
check('regression filter leaves the 17 regressions', regs === 17, String(regs));

// Statistics tab: canvases painted, McNemar grid shows the discordance.
await evaluate(`document.querySelector('.tab[data-tab="stats"]').click()`);
const histPx = await evaluate(`(() => {
  const c = document.getElementById('boot-hist');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
})()`);
check('bootstrap histogram is drawn', histPx > 2000, `${histPx} px`);
const mc = await evaluate(`[...document.querySelectorAll('#mcnemar-grid .mv')].map(e => e.textContent)`);
check('McNemar grid shows 17 regressions vs 4 improvements', mc.join(',') === '777,17,4,74', mc.join(','));
const mcCap = await evaluate(`document.getElementById('mcnemar-caption').textContent`);
check('McNemar caption reports both p-values', mcCap.includes('p = 0.0072') && mcCap.includes('0.0088'), mcCap.slice(0, 80));

// Slices tab: forest plot, table, exemplars.
await evaluate(`document.querySelector('.tab[data-tab="slices"]').click()`);
const forestPx = await evaluate(`(() => {
  const c = document.getElementById('forest');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
})()`);
check('forest plot is drawn', forestPx > 1000, `${forestPx} px`);
const sliceRows = await evaluate(`document.querySelectorAll('#slice-table tbody tr').length`);
check('slice table lists all 6 slices', sliceRows === 6, String(sliceRows));
const exemplars = await evaluate(`({
  boxes: document.querySelectorAll('#slice-exemplars .g-row').length,
  first: document.querySelector('#slice-exemplars .g-kind')?.textContent ?? '',
})`);
check('negation exemplars render with enrichment stats', exemplars.boxes >= 1 && exemplars.first.startsWith('negation'), exemplars.first);

// Method tab states pins and honest limits.
await evaluate(`document.querySelector('.tab[data-tab="method"]').click()`);
const method = await evaluate(`document.querySelector('#tab-method').textContent`);
check('method states the pin, dataset and limits', method.includes('0b6928ef') && method.includes('SST-2') && method.includes('Honest limits'));

if (LIVE) {
  // Live probe: downloads both pinned builds (~200 MB) and scores a sentence.
  await evaluate(`(() => {
    document.querySelector('.tab[data-tab="examples"]').click();
    const i = document.getElementById('probe-input');
    i.value = 'a film that is not without its charms';
    document.getElementById('probe-form').dispatchEvent(new Event('submit', { cancelable: true }));
  })()`);
  await waitFor(() => evaluate(`!document.getElementById('probe-result').hidden`), 'live probe', 1500000);
  const probe = await evaluate(`({
    cols: document.querySelectorAll('#probe-result .probe-col .pred').length,
    texts: [...document.querySelectorAll('#probe-result .probe-col')].map(c => c.textContent),
    flip: document.querySelector('#probe-result .probe-flip').textContent,
  })`);
  check('live probe scores with both pinned builds', probe.cols === 2 && probe.texts.every((t) => /p=0\.\d{4}/.test(t)), JSON.stringify(probe.texts).slice(0, 120));

  // XSS through the probe path: input must never become markup.
  await evaluate(`(() => {
    const i = document.getElementById('probe-input');
    i.value = '<img src=x onerror="window.__xss=1"> wonderful';
    document.getElementById('probe-form').dispatchEvent(new Event('submit', { cancelable: true }));
  })()`);
  await waitFor(() => evaluate(`!document.getElementById('probe-result').hidden && document.querySelectorAll('#probe-result .probe-col .pred').length === 2`), 'xss probe', 120000);
  const xss = await evaluate(`window.__xss === 1 || document.querySelector('#probe-result img') !== null`);
  check('probe input cannot inject markup', !xss);
} else {
  console.log('skip - live probe (set SMOKE_LIVE=1 to include the ~200 MB model download)');
}

check('no page exceptions during the whole run', consoleErrors.length === 0, consoleErrors[0] ?? '');

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? `smoke ok: ${checks.length} checks` : `smoke FAILED: ${failed.length}/${checks.length}`);
cleanup(failed.length === 0 ? 0 : 1);
