// Capture one screenshot per tab of the built site (docs/) via headless Chrome CDP.
// Usage: node tests/shots.mjs [outdir]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const HTTP_PORT = 8941;
const CDP_PORT = 9343;
const outdir = process.argv[2] ?? '/downloads/backslide-shots';
mkdirSync(outdir, { recursive: true });
const root = new URL('..', import.meta.url).pathname;

const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1', '--directory', `${root}docs`], { stdio: 'ignore' });
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=1280,1400', `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = (code) => { try { chrome.kill('SIGKILL'); } catch {}; try { server.kill('SIGKILL'); } catch {}; process.exit(code); };
setTimeout(() => { console.error('shots: timeout'); cleanup(1); }, 90000);

async function waitFor(fn, label, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 'chrome');
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let mid = 0;
const rpcPending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && rpcPending.has(msg.id)) { rpcPending.get(msg.id)(msg); rpcPending.delete(msg.id); }
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
await cdp('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await waitFor(() => evaluate(`(document.getElementById('boot-stats').textContent || '').includes('McNemar')`), 'boot');

for (const tab of ['verdict', 'examples', 'stats', 'slices', 'method']) {
  await evaluate(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await evaluate(`window.scrollTo(0, ${tab === 'verdict' ? 0 : 0})`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outdir}/${tab}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`captured ${tab}`);
}
cleanup(0);
