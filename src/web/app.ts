/**
 * backslide demo shell. All page numbers come from the committed artifacts
 * (data/pairs/*.golden.json, *.snapshot.json) or from an in-page recompute for
 * uploaded files; the only live model work is the optional two-build probe on
 * the SST-2 pair. Rendering is textContent-only.
 */
import { verdict, regressionVerdict, fmtP } from '../stats.js';
import { analyze } from '../analyze.js';
import { reportMarkdown } from '../report.js';
import { parseCsv, joinCombined, detectTask, MAX_ROWS } from '../parse.js';

/* ---------------- types ---------------- */
interface ClsOut { p: number; s: number; c: 0 | 1 }
interface RegOut { pred: number; err: number }
interface Example {
  id: string;
  text: string;
  label: number;
  slice: string;
  v1: ClsOut & Partial<RegOut>;
  v2: ClsOut & Partial<RegOut>;
}
interface Golden {
  slug: string;
  title: string;
  task: 'classification' | 'regression';
  unit?: string;
  description?: string;
  labels?: string[];
  variants?: Record<string, string>;
  pipeline?: Record<string, string>;
  examples: Example[];
}
interface SliceRow {
  slice: string; n: number; delta: number; lo: number; hi: number;
  accV1?: number; accV2?: number; errV1?: number; errV2?: number;
  regressions?: number; improvements?: number; worse?: number; better?: number;
}
interface Snapshot {
  slug: string;
  title: string;
  task: 'classification' | 'regression';
  unit?: string;
  generated: string;
  pins: {
    pipeline: Record<string, unknown>;
    dataset: { name: string; n: number };
    labels: string[] | null;
    bootstrap: { resamples: number; seed: number };
    slices: { resamples: number; seed: number };
    gate: Record<string, number>;
  };
  n: number;
  // classification
  accV1?: number; accV2?: number; delta?: number;
  mcnemar?: { b01: number; b10: number; pChi2: number; pExact: number };
  cohensH?: number;
  classes?: Array<{ label: string; n: number; accV1: number; accV2: number; delta: number; regressions: number; improvements: number }> | null;
  // regression
  maeV1?: number; maeV2?: number; rmseV1?: number; rmseV2?: number; errDelta?: number;
  sign?: { worse: number; better: number; ties: number; pExact: number };
  // shared
  ci: { lo: number; hi: number; level: number };
  bootHistogram: { x0: number; dx: number; counts: number[] };
  slices: SliceRow[];
  enrichment: Array<{
    slice: string; n: number; regressions: number; rate: number;
    baselineRate: number; ratio: number; fisherP: number;
    exemplars?: Array<{ id: string; text: string; v2score: number }>;
  }>;
  verdict: { ship: boolean; headline: string; reasons: string[] };
}
interface IndexEntry {
  slug: string; title: string; task: 'classification' | 'regression'; unit: string | null;
  n: number; generated: string; ship: boolean; headline: string;
  v1Label: string; v2Label: string;
  accV1?: number; accV2?: number; delta?: number;
  maeV1?: number; maeV2?: number; errDelta?: number;
  ciLo: number; ciHi: number; p: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const pct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;
const pts = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}`;
const signedPts = (x: number, digits = 2): string => `${x >= 0 ? '+' : ''}${pts(x, digits)}`;

/* ---------------- state ---------------- */
let pairsIndex: IndexEntry[] = [];
let golden: Golden;
let snap: Snapshot;
// The page loads one bundle (fixed URL, see scripts/build-web.mjs); pair
// switching then reads from memory, never from a user-built request URL.
const artifacts = new Map<string, { golden: Golden; snap: Snapshot }>();

function loadPair(slug: string): Promise<{ golden: Golden; snap: Snapshot }> {
  const hit = artifacts.get(slug);
  if (!hit) return Promise.reject(new Error(`unknown pair: ${slug}`));
  return Promise.resolve(hit);
}

function v1Name(): string {
  return golden.variants?.['v1'] ?? golden.pipeline?.['v1'] ?? 'v1';
}
function v2Name(): string {
  return golden.variants?.['v2'] ?? golden.pipeline?.['v2'] ?? 'v2';
}
function observedDelta(): number {
  return snap.task === 'regression' ? snap.errDelta! : snap.delta!;
}
function discordanceP(): number {
  return snap.task === 'regression' ? snap.sign!.pExact : snap.mcnemar!.pExact;
}
function regressionCount(): number {
  return snap.task === 'regression' ? snap.sign!.worse : snap.mcnemar!.b10;
}
function improvementCount(): number {
  return snap.task === 'regression' ? snap.sign!.better : snap.mcnemar!.b01;
}

/* ---------------- tabs ---------------- */
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
  btn.addEventListener('click', () => {
    for (const b of Array.from(document.querySelectorAll('.tab'))) {
      b.classList.remove('is-active');
      b.setAttribute('aria-selected', 'false');
    }
    btn.classList.add('is-active');
    btn.setAttribute('aria-selected', 'true');
    for (const p of Array.from(document.querySelectorAll<HTMLElement>('.panel'))) {
      const on = p.id === `tab-${btn.dataset['tab']}`;
      p.hidden = !on;
      p.classList.toggle('is-active', on);
    }
    if (btn.dataset['tab'] === 'stats') {
      drawHistogram();
      drawDiscordance();
    }
    if (btn.dataset['tab'] === 'slices') drawForest();
    if (btn.dataset['tab'] === 'byo' && byoSnap) drawByoCharts();
  });
}

/* ---------------- pair switcher ---------------- */
function pairSummaryLine(e: IndexEntry): string {
  if (e.task === 'classification') {
    return `delta ${signedPts(e.delta!)} pts [${pts(e.ciLo)}, ${pts(e.ciHi)}]`;
  }
  return `err ${e.errDelta! >= 0 ? '+' : ''}${e.errDelta!.toFixed(4)} ${e.unit} [${e.ciLo.toFixed(4)}, ${e.ciHi.toFixed(4)}]`;
}

function renderPairSwitch(): void {
  const box = $('pair-switch');
  box.replaceChildren();
  for (const e of pairsIndex) {
    const card = el('button', `pair-card${snap && snap.slug === e.slug ? ' is-active' : ''}`) as HTMLButtonElement;
    card.type = 'button';
    const head = el('div', 'pc-head');
    head.append(
      el('span', 'pc-title', e.title),
      el('span', `pc-badge ${e.ship ? 'ship' : 'hold'}`, e.ship ? 'ship' : 'hold'),
    );
    card.append(
      head,
      el('div', 'pc-meta', `${e.task}${e.task === 'classification' && e.slug !== 'sst2-int8' ? ' · multi-class' : ''} · n=${e.n.toLocaleString('en-US')}`),
      el('div', 'pc-delta mono', pairSummaryLine(e)),
    );
    card.addEventListener('click', () => { void selectPair(e.slug, true); });
    box.append(card);
  }
}

async function selectPair(slug: string, pushUrl: boolean): Promise<void> {
  const { golden: g, snap: s } = await loadPair(slug);
  golden = g;
  snap = s;
  if (pushUrl) {
    const url = new URL(location.href);
    url.searchParams.set('pair', slug);
    history.replaceState(null, '', url);
  }
  renderPairSwitch();
  filter = { kind: 'all' };
  renderAll();
}

/* ---------------- verdict ---------------- */
function renderVerdict(tolerance: number, alpha: number): void {
  let v;
  if (snap.task === 'regression') {
    v = regressionVerdict(
      {
        errDelta: snap.errDelta!, ciLo: snap.ci.lo, ciHi: snap.ci.hi,
        pSign: snap.sign!.pExact, worse: snap.sign!.worse, better: snap.sign!.better,
        unit: snap.unit ?? 'units',
      },
      { maxIncrease: tolerance, alpha },
    );
  } else {
    v = verdict(
      {
        delta: snap.delta!, ciLo: snap.ci.lo, ciHi: snap.ci.hi,
        pMcnemar: snap.mcnemar!.pExact,
        regressions: snap.mcnemar!.b10, improvements: snap.mcnemar!.b01,
      },
      { maxDrop: tolerance, alpha },
    );
  }
  const banner = $('verdict-banner');
  banner.className = `gate-banner ${v.ship ? 'ship' : 'hold'}`;
  banner.replaceChildren(
    el('p', 'gb-head', v.headline),
    el('p', 'gb-sub',
      `v1 incumbent: ${v1Name()} · v2 candidate: ${v2Name()} · n=${snap.n.toLocaleString('en-US')}`),
  );

  const reasons = $('gate-reasons');
  reasons.replaceChildren();
  const sig = discordanceP() < alpha;
  const within = snap.task === 'regression'
    ? snap.ci.hi <= tolerance
    : snap.ci.lo >= -tolerance;
  [sig, !within].forEach((bad, i) => {
    const li = el('li');
    li.append(
      el('span', 't-stage', i === 0 ? (snap.task === 'regression' ? 'sign test' : 'McNemar') : 'CI bound'),
      el('span', `t-detail ${bad ? 'bad' : 'ok'}`, v.reasons[i] ?? ''),
    );
    reasons.append(li);
  });
}

function renderVerdictNote(): void {
  $('verdict-note').textContent = snap.task === 'regression'
    ? `The candidate is the ${v2Name()}; the incumbent is the ${v1Name()}. The gate ships only ` +
      'when the error increase is not statistically significant and the confidence interval ' +
      'rules out an increase beyond tolerance.'
    : `The candidate is the ${v2Name()} build; the incumbent is the ${v1Name()} build. The gate ` +
      'ships only when the discordance is not statistically significant and the confidence ' +
      'interval rules out a drop beyond tolerance.';
}

function renderVerdictStats(): void {
  const grid = $('verdict-stats');
  grid.replaceChildren();
  let cards: Array<[string, string, string, string]>;
  if (snap.task === 'regression') {
    cards = [
      [`${snap.maeV1!.toFixed(4)}`, `v1 MAE (${snap.unit})`, '', `${snap.n.toLocaleString('en-US')} golden rows`],
      [`${snap.maeV2!.toFixed(4)}`, `v2 MAE (${snap.unit})`, '', v2Name()],
      [`${snap.errDelta! >= 0 ? '+' : ''}${snap.errDelta!.toFixed(4)}`, 'paired error delta', snap.errDelta! > 0 ? 'bad' : 'ok',
        `95% CI [${snap.ci.lo.toFixed(4)}, ${snap.ci.hi.toFixed(4)}]`],
      [fmtP(snap.sign!.pExact), 'sign test exact p', snap.sign!.pExact < 0.05 ? 'bad' : '',
        `${snap.sign!.worse} worse vs ${snap.sign!.better} better`],
      [`${snap.rmseV1!.toFixed(4)}`, 'v1 RMSE', '', 'root mean square error'],
      [`${snap.rmseV2!.toFixed(4)}`, 'v2 RMSE', snap.rmseV2! > snap.rmseV1! ? 'bad' : 'ok', `${snap.unit}`],
    ];
  } else {
    cards = [
      [`${pct(snap.accV1!, 2)}`, `v1 accuracy (${v1Name()})`, '', `${snap.n.toLocaleString('en-US')} golden examples`],
      [`${pct(snap.accV2!, 2)}`, `v2 accuracy (${v2Name()})`, snap.accV2! < snap.accV1! ? 'bad' : 'ok', v2Name()],
      [`${signedPts(snap.delta!)} pts`, 'paired delta', snap.delta! < 0 ? 'bad' : 'ok', `95% CI [${pts(snap.ci.lo)}, ${pts(snap.ci.hi)}]`],
      [fmtP(snap.mcnemar!.pExact), 'McNemar exact p', snap.mcnemar!.pExact < 0.05 ? 'bad' : '',
        `${snap.mcnemar!.b10} regressions vs ${snap.mcnemar!.b01} improvements`],
      [snap.cohensH!.toFixed(3), "Cohen's h", 'accent', 'aggregate effect size'],
      [`${snap.mcnemar!.b10 + snap.mcnemar!.b01}`, 'discordant examples', '', `of ${snap.n.toLocaleString('en-US')} paired predictions`],
    ];
  }
  for (const [v, k, tone, sub] of cards) {
    const card = el('div', 'stat');
    card.append(
      el('div', `stat-v ${tone}`, v),
      el('div', 'stat-k', k),
      el('div', 'stat-ci', sub),
    );
    grid.append(card);
  }
}

function renderAllPairsTable(): void {
  const box = $('all-pairs');
  box.replaceChildren();
  const title = el('h3', 'gate-controls-title', 'Every worked pair at the defaults');
  title.style.marginTop = '0';
  const wrap = el('div', 'sweep-table');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const h of ['Pair', 'Task', 'n', 'Delta [95% CI]', 'p', 'Verdict']) {
    const th = document.createElement('th');
    th.textContent = h;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  for (const e of pairsIndex) {
    const tr = document.createElement('tr');
    if (snap && e.slug === snap.slug) tr.className = 'hl';
    const cells = [
      e.title,
      e.task,
      e.n.toLocaleString('en-US'),
      pairSummaryLine(e),
      fmtP(e.p),
      e.ship ? 'ship' : 'HOLD',
    ];
    cells.forEach((t, i) => {
      const td = document.createElement('td');
      td.className = 'mono';
      if (i === 5) td.style.color = e.ship ? 'var(--ok)' : 'var(--bad)';
      td.textContent = t;
      tr.append(td);
    });
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => { void selectPair(e.slug, true); });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  box.append(title, wrap);
}

function wireGate(): void {
  const slider = $('gate-drop') as HTMLInputElement;
  const alphaSel = $('gate-alpha') as HTMLSelectElement;
  const label = $('gate-drop-label');
  if (snap.task === 'regression') {
    label.textContent = `Tolerated error increase (${snap.unit})`;
    slider.min = '0';
    slider.max = '0.1';
    slider.step = '0.005';
    slider.value = String(snap.pins.gate['maxIncrease'] ?? 0.02);
  } else {
    label.textContent = 'Tolerated accuracy drop';
    slider.min = '0';
    slider.max = '3';
    slider.step = '0.1';
    slider.value = String(Number(snap.pins.gate['maxDrop'] ?? 0.005) * 100);
  }
  const update = (): void => {
    const tol = Number(slider.value);
    $('gate-drop-val').textContent = snap.task === 'regression'
      ? `${tol.toFixed(3)} ${snap.unit}`
      : `${tol.toFixed(1)} pts`;
    renderVerdict(snap.task === 'regression' ? tol : tol / 100, Number(alphaSel.value));
  };
  slider.oninput = update;
  alphaSel.onchange = update;
  update();
}

/* ---------------- examples ---------------- */
type Filter = { kind: 'all' | 'reg' | 'imp' | 'slice'; value?: string };
let filter: Filter = { kind: 'all' };
const TIE_EPS = 1e-9;

function isRegressionTask(): boolean {
  return snap.task === 'regression';
}

function changed(): Example[] {
  if (isRegressionTask()) {
    return golden.examples
      .filter((e) => Math.abs(e.v2.err! - e.v1.err!) > TIE_EPS)
      .sort((a, b) => (b.v2.err! - b.v1.err!) - (a.v2.err! - a.v1.err!));
  }
  return golden.examples.filter((e) => e.v1.c !== e.v2.c);
}

function renderExamplesHead(): void {
  $('examples-title').textContent = isRegressionTask()
    ? 'Where the error moved'
    : 'Where the builds disagree';
  const note = $('examples-note');
  if (isRegressionTask()) {
    note.replaceChildren(
      document.createTextNode('Row-level error changes, sorted worst-first. The largest increases are where the shrunk build hurts most; the tail of the list is where it wins. '),
    );
  } else {
    note.replaceChildren(document.createTextNode('Aggregate accuracy hides the mechanism. These are the '));
  }
  if (!isRegressionTask()) {
    note.append(
      Object.assign(el('span', 'mono', String(snap.mcnemar!.b01 + snap.mcnemar!.b10)), { id: 'discord-count' }),
      document.createTextNode(' examples where the two builds give different answers - each one an example the new build flips for better or worse.'),
    );
  } else {
    note.append(
      Object.assign(el('span', 'mono', String(changed().length)), { id: 'discord-count' }),
      document.createTextNode(` of ${snap.n.toLocaleString('en-US')} rows change error at all.`),
    );
  }
  $('probe-block').hidden = snap.slug !== 'sst2-int8';
}

function renderFilters(): void {
  const box = $('example-filters');
  box.replaceChildren();
  const disc = changed();
  const mk = (labelText: string, f: Filter, active: boolean): HTMLButtonElement => {
    const b = el('button', 'chip', labelText) as HTMLButtonElement;
    b.type = 'button';
    if (active) b.style.borderColor = 'var(--accent)';
    b.addEventListener('click', () => { filter = f; renderFilters(); renderExamples(); });
    return b;
  };
  if (isRegressionTask()) {
    const worse = disc.filter((e) => e.v2.err! > e.v1.err!).length;
    box.append(
      mk(`all changes (${disc.length})`, { kind: 'all' }, filter.kind === 'all'),
      mk(`worse (${worse})`, { kind: 'reg' }, filter.kind === 'reg'),
      mk(`better (${disc.length - worse})`, { kind: 'imp' }, filter.kind === 'imp'),
    );
  } else {
    const regs = disc.filter((e) => e.v1.c === 1).length;
    box.append(
      mk(`all changes (${disc.length})`, { kind: 'all' }, filter.kind === 'all'),
      mk(`regressions (${regs})`, { kind: 'reg' }, filter.kind === 'reg'),
      mk(`improvements (${disc.length - regs})`, { kind: 'imp' }, filter.kind === 'imp'),
    );
  }
  const slices = [...new Set(disc.map((e) => e.slice))].sort();
  for (const s of slices) {
    const n = disc.filter((e) => e.slice === s).length;
    box.append(mk(`${s} (${n})`, { kind: 'slice', value: s }, filter.kind === 'slice' && filter.value === s));
  }
}

const EXAMPLE_CAP = 200;

function renderExamples(): void {
  const list = $('example-list');
  list.replaceChildren();
  let disc = changed();
  if (isRegressionTask()) {
    if (filter.kind === 'reg') disc = disc.filter((e) => e.v2.err! > e.v1.err!);
    if (filter.kind === 'imp') disc = disc.filter((e) => e.v2.err! < e.v1.err!).reverse();
  } else {
    if (filter.kind === 'reg') disc = disc.filter((e) => e.v1.c === 1);
    if (filter.kind === 'imp') disc = disc.filter((e) => e.v1.c === 0);
  }
  if (filter.kind === 'slice') disc = disc.filter((e) => e.slice === filter.value);
  const capped = disc.slice(0, EXAMPLE_CAP);
  if (disc.length > EXAMPLE_CAP) {
    list.append(el('p', 'g-note', `showing the ${EXAMPLE_CAP} largest changes of ${disc.length.toLocaleString('en-US')}`));
  }
  for (const e of capped) {
    if (isRegressionTask()) {
      const worse = e.v2.err! > e.v1.err!;
      const row = el('div', 'g-row');
      const head = el('div');
      head.append(
        el('span', `g-kind ${worse ? 'regression' : 'improvement'}`, worse ? 'worse' : 'better'),
        el('span', 'g-slice', `${e.slice} · gold: ${e.label} ${snap.unit}`),
      );
      const q = el('div', 'g-q', e.text);
      const scores = el('div', 'g-scores');
      const col = (who: string, pred: number, err: number): HTMLElement => {
        const c = el('div', 'g-score');
        c.append(el('span', 'who', who));
        const line = el('span');
        line.append(el('span', '', `pred ${pred.toFixed(3)} · |err| ${err.toFixed(4)}`));
        c.append(line);
        return c;
      };
      scores.append(
        col(`v1 · ${v1Name()}`, e.v1.pred!, e.v1.err!),
        col(`v2 · ${v2Name()}`, e.v2.pred!, e.v2.err!),
      );
      const d = el('div', 'g-note',
        `error delta ${e.v2.err! - e.v1.err! >= 0 ? '+' : ''}${(e.v2.err! - e.v1.err!).toFixed(4)} ${snap.unit}`);
      row.append(head, q, scores, d);
      list.append(row);
    } else {
      const regressed = e.v1.c === 1;
      const row = el('div', 'g-row');
      const head = el('div');
      head.append(
        el('span', `g-kind ${regressed ? 'regression' : 'improvement'}`, regressed ? 'regression' : 'improvement'),
        el('span', 'g-slice', `${e.slice} · gold: ${labelName(e.label)}`),
      );
      const q = el('div', 'g-q', e.text);
      const scores = el('div', 'g-scores');
      const col = (who: string, pred: number, score: number, correct: boolean): HTMLElement => {
        const c = el('div', 'g-score');
        c.append(el('span', 'who', who));
        const line = el('span');
        line.append(
          el('span', correct ? 'right' : 'wrong', labelName(pred)),
          document.createTextNode(` · p=${score.toFixed(4)} · ${correct ? 'correct' : 'wrong'}`),
        );
        c.append(line);
        return c;
      };
      scores.append(
        col(`v1 · ${v1Name()}`, e.v1.p, e.v1.s, e.v1.c === 1),
        col(`v2 · ${v2Name()}`, e.v2.p, e.v2.s, e.v2.c === 1),
      );
      row.append(head, q, scores);
      list.append(row);
    }
  }
}

function labelName(k: number): string {
  return snap.pins.labels?.[k] ?? String(k);
}

/* ---------------- live probe (SST-2 only) ---------------- */
function wireProbe(): void {
  const form = $('probe-form') as HTMLFormElement;
  const input = $('probe-input') as HTMLTextAreaElement;
  const btn = $('probe-submit') as HTMLButtonElement;
  const status = $('model-status');
  const statusText = $('model-status-text');
  const bar = $('model-progress');
  const result = $('probe-result');
  let classifier: import('./models.js').PairClassifier | null = null;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) return;
    btn.disabled = true;
    result.hidden = true;
    try {
      if (classifier === null) {
        const { PairClassifier } = await import('./models.js');
        classifier = new PairClassifier();
      }
      if (!classifier.loaded) {
        status.hidden = false;
        await classifier.load((frac, stage) => {
          statusText.textContent = `downloading ${stage} - ${(frac * 100).toFixed(0)}%`;
          bar.style.width = `${(frac * 100).toFixed(1)}%`;
        });
        statusText.textContent = 'both builds loaded';
        bar.style.width = '100%';
      }
      const r = await classifier.classify(text);
      result.replaceChildren();
      const cols = el('div', 'probe-cols');
      const mkCol = (who: string, res: { label: string; score: number }): HTMLElement => {
        const c = el('div', 'probe-col');
        c.append(el('span', 'who', who));
        const line = el('span');
        line.append(
          el('span', `pred ${res.label === 'POSITIVE' ? 'pos' : 'neg'}`, res.label),
          el('span', 'score', `p=${res.score.toFixed(4)}`),
        );
        c.append(line);
        return c;
      };
      cols.append(
        mkCol(`v1 · ${v1Name()} incumbent`, r.v1),
        mkCol(`v2 · ${v2Name()} candidate`, r.v2),
      );
      const agreePct = pct(
        golden.examples.filter((e) => e.v1.p === e.v2.p).length / snap.n, 1,
      );
      const flip = el('p', `probe-flip ${r.v1.label === r.v2.label ? 'same' : ''}`,
        r.v1.label === r.v2.label
          ? `builds agree on this sentence - as they do on ${agreePct} of the golden set`
          : 'the builds disagree on this sentence - this is what a flip looks like');
      result.append(cols, flip);
      result.hidden = false;
    } catch (err) {
      status.hidden = false;
      statusText.textContent = `probe failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- statistics ---------------- */
function withCanvas(id: string, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
  const canvas = $(id) as unknown as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const h = Number(canvas.getAttribute('height')) || 320;
  const w = canvas.clientWidth || Number(canvas.getAttribute('width')) || 640;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  draw(ctx, w, h);
}

function drawHistogramGeneric(
  canvasId: string,
  hist: { x0: number; dx: number; counts: number[] },
  ci: { lo: number; hi: number },
  observed: number,
  xLabel: string,
  fmtTick: (x: number) => string,
): void {
  withCanvas(canvasId, (ctx, w, h) => {
    const { x0, dx, counts } = hist;
    const maxC = Math.max(...counts);
    const padL = 46, padR = 12, padT = 26, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const span = dx * counts.length;
    const xFor = (v: number): number => padL + ((v - x0) / span) * plotW;

    counts.forEach((c, i) => {
      const lo = x0 + i * dx, hi = lo + dx;
      const inCi = hi >= ci.lo && lo <= ci.hi;
      ctx.fillStyle = inCi ? 'rgba(240, 102, 58, 0.75)' : 'rgba(229, 83, 75, 0.35)';
      const bh = (c / maxC) * plotH;
      ctx.fillRect(xFor(lo), padT + plotH - bh, Math.max(1, (dx / span) * plotW - 1), bh);
    });

    ctx.strokeStyle = '#8a94a1';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xFor(0), padT);
    ctx.lineTo(xFor(0), padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#e5534b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xFor(observed), padT);
    ctx.lineTo(xFor(observed), padT + plotH);
    ctx.stroke();
    ctx.lineWidth = 1;

    ctx.fillStyle = '#8a94a1';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = [ci.lo, observed, 0, ci.hi];
    const seen = new Set<string>();
    for (const t of ticks) {
      if (t < x0 - 1e-12 || t > x0 + span + 1e-12) continue;
      const label = fmtTick(t);
      if (seen.has(label)) continue;
      seen.add(label);
      ctx.fillText(label, xFor(t), h - padB + 16);
    }
    ctx.fillText(xLabel, padL + plotW / 2, h - 4);
    ctx.textAlign = 'left';
    if (0 >= x0 && 0 <= x0 + span) ctx.fillText('0', xFor(0) + 4, 16);
    ctx.fillStyle = '#e5534b';
    ctx.textAlign = 'right';
    ctx.fillText(`observed ${fmtTick(observed)}`, xFor(observed) - 5, 16);
    ctx.textAlign = 'left';
  });
}

function drawHistogram(): void {
  if (snap.task === 'regression') {
    $('hist-title').textContent = `Paired bootstrap: mean error delta (v2 - v1), ${snap.pins.bootstrap.resamples.toLocaleString('en-US')} resamples`;
    drawHistogramGeneric('boot-hist', snap.bootHistogram, snap.ci, snap.errDelta!,
      `mean absolute-error delta, ${snap.unit}`, (x) => x.toFixed(3));
    $('boot-caption').textContent =
      `95% of resampled error deltas fall in [${snap.ci.lo.toFixed(4)}, ${snap.ci.hi.toFixed(4)}] ${snap.unit}. ` +
      (snap.ci.lo > 0
        ? 'The entire interval sits above zero: the error increase is not sampling noise.'
        : 'The interval crosses zero: no proven error increase.');
  } else {
    $('hist-title').textContent = `Paired bootstrap: accuracy delta (v2 - v1), ${snap.pins.bootstrap.resamples.toLocaleString('en-US')} resamples`;
    drawHistogramGeneric('boot-hist', snap.bootHistogram, snap.ci, snap.delta!,
      'accuracy delta, points', (x) => pts(x));
    $('boot-caption').textContent =
      `95% of resampled deltas fall in [${pts(snap.ci.lo)}, ${pts(snap.ci.hi)}] pts. ` +
      (snap.ci.hi < 0
        ? 'The entire interval sits below zero: the drop is not sampling noise.'
        : snap.ci.lo > 0
          ? 'The entire interval sits above zero: the candidate is genuinely better on this evidence.'
          : 'The interval crosses zero: no proven accuracy change.');
  }
}

function drawDiscordance(): void {
  const grid = $('mcnemar-grid');
  grid.replaceChildren();
  if (snap.task === 'regression') {
    $('discord-title').textContent = 'Sign test on per-row error';
    const st = snap.sign!;
    const cells: Array<[string, string, string]> = [
      ['', 'v2 better', 'v2 worse'],
      ['rows', String(st.better), String(st.worse)],
      ['ties', String(st.ties), ''],
    ];
    cells.forEach(([a, b, c], ri) => {
      [a, b, c].forEach((txt, ci) => {
        const isHead = ri === 0 || ci === 0;
        const hot = ri === 1 && ci === 2;
        const warm = ri === 1 && ci === 1;
        const d = el('div', isHead ? 'mh' : hot ? 'hot' : warm ? 'warm' : '');
        d.append(el('span', isHead ? '' : 'mv', txt));
        grid.append(d);
      });
    });
    $('mcnemar-caption').textContent =
      `${st.worse} rows carry a larger error under the new build, ${st.better} a smaller one ` +
      `(${st.ties} ties excluded). Exact two-sided sign test p = ${fmtP(st.pExact)}.`;
  } else {
    $('discord-title').textContent = 'McNemar discordance';
    const bothRight = golden.examples.filter((e) => e.v1.c === 1 && e.v2.c === 1).length;
    const bothWrong = golden.examples.filter((e) => e.v1.c === 0 && e.v2.c === 0).length;
    const cells: Array<[string, string, string]> = [
      ['', 'v2 correct', 'v2 wrong'],
      ['v1 correct', String(bothRight), String(snap.mcnemar!.b10)],
      ['v1 wrong', String(snap.mcnemar!.b01), String(bothWrong)],
    ];
    cells.forEach(([a, b, c], ri) => {
      [a, b, c].forEach((txt, ci) => {
        const isHead = ri === 0 || ci === 0;
        const hot = ri === 1 && ci === 2;
        const warm = ri === 2 && ci === 1;
        const d = el('div', isHead ? 'mh' : hot ? 'hot' : warm ? 'warm' : '');
        d.append(el('span', isHead ? '' : 'mv', txt));
        grid.append(d);
      });
    });
    $('mcnemar-caption').textContent =
      `Only the off-diagonal cells carry signal: ${snap.mcnemar!.b10} examples flipped for the worse, ` +
      `${snap.mcnemar!.b01} for the better. Exact binomial p = ${fmtP(snap.mcnemar!.pExact)} ` +
      `(chi-square approximation ${fmtP(snap.mcnemar!.pChi2)}).`;
  }
}

function renderClassBreakdown(): void {
  const wrap = $('class-breakdown');
  if (!snap.classes || snap.classes.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const tbody = document.querySelector('#class-table tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  for (const c of snap.classes) {
    const tr = document.createElement('tr');
    if (c.delta < 0) tr.className = 'hl';
    const tds = [
      c.label,
      String(c.n),
      pct(c.accV1),
      pct(c.accV2),
      signedPts(c.delta),
      String(c.regressions),
      String(c.improvements),
    ];
    for (const t of tds) {
      const td = document.createElement('td');
      td.className = 'mono';
      td.textContent = t;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function renderStatCards(): void {
  const grid = $('stats-cards');
  grid.replaceChildren();
  let cards: Array<[string, string, string, string]>;
  if (snap.task === 'regression') {
    const medErr = (which: 'v1' | 'v2'): number => {
      const errs = golden.examples.map((e) => e[which].err!).sort((a, b) => a - b);
      return errs[Math.floor(errs.length / 2)]!;
    };
    cards = [
      [`${snap.pins.bootstrap.resamples.toLocaleString('en-US')}`, 'bootstrap resamples', '', `seed ${snap.pins.bootstrap.seed}`],
      [`${medErr('v1').toFixed(4)}`, 'v1 median |err|', '', `${snap.unit}`],
      [`${medErr('v2').toFixed(4)}`, 'v2 median |err|', medErr('v2') > medErr('v1') ? 'bad' : 'ok', `${snap.unit}`],
      [`${snap.sign!.ties}`, 'tied rows', '', 'excluded from the sign test'],
    ];
  } else {
    const agree = golden.examples.filter((e) => e.v1.p === e.v2.p).length / snap.n;
    cards = [
      [`${snap.pins.bootstrap.resamples.toLocaleString('en-US')}`, 'bootstrap resamples', '', `seed ${snap.pins.bootstrap.seed}`],
      [snap.cohensH!.toFixed(3), "Cohen's h", 'accent', 'small aggregate effect - slices carry the story'],
      [pct(agree, 1), 'raw agreement', '', 'labels match, correctness aside'],
      [`${snap.pins.slices.resamples.toLocaleString('en-US')}`, 'slice resamples', '', `seed ${snap.pins.slices.seed}`],
    ];
  }
  for (const [v, k, tone, sub] of cards) {
    const card = el('div', 'stat');
    card.append(el('div', `stat-v ${tone}`, v), el('div', 'stat-k', k), el('div', 'stat-ci', sub));
    grid.append(card);
  }
}

/* ---------------- slices ---------------- */
function sliceDelta(s: SliceRow): number {
  return s.delta;
}

function drawForest(): void {
  $('forest-title').textContent = snap.task === 'regression'
    ? 'Per-slice error delta with 95% bootstrap interval'
    : 'Per-slice accuracy delta with 95% bootstrap interval';
  withCanvas('forest', (ctx, w, h) => {
    const rows = [...snap.slices].sort((a, b) => sliceDelta(a) - sliceDelta(b));
    const padL = 142, padR = 16, padT = 16, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const lo = Math.min(...rows.map((r) => r.lo), snap.ci.lo, 0);
    const hi = Math.max(...rows.map((r) => r.hi), snap.ci.hi, 0);
    const span = hi - lo || 1;
    const xFor = (v: number): number => padL + ((v - lo) / span) * plotW;
    const rowH = plotH / rows.length;
    const reg = snap.task === 'regression';
    const bad = (r: SliceRow): boolean => reg ? r.lo > 0 : r.hi < 0;
    const fmtTick = (v: number): string => reg ? v.toFixed(3) : pts(v);

    ctx.fillStyle = 'rgba(240, 102, 58, 0.08)';
    ctx.fillRect(xFor(snap.ci.lo), padT, xFor(snap.ci.hi) - xFor(snap.ci.lo), plotH);

    ctx.strokeStyle = '#8a94a1';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xFor(0), padT);
    ctx.lineTo(xFor(0), padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    rows.forEach((r, i) => {
      const y = padT + rowH * (i + 0.5);
      ctx.strokeStyle = '#c9d1d9';
      ctx.beginPath();
      ctx.moveTo(xFor(r.lo), y);
      ctx.lineTo(xFor(r.hi), y);
      ctx.stroke();
      for (const x of [r.lo, r.hi]) {
        ctx.beginPath();
        ctx.moveTo(xFor(x), y - 4);
        ctx.lineTo(xFor(x), y + 4);
        ctx.stroke();
      }
      ctx.fillStyle = bad(r) ? '#e5534b' : '#f0663a';
      ctx.beginPath();
      ctx.arc(xFor(r.delta), y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9aa4b0';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${r.slice} (${r.n})`, padL - 10, y + 4);
      ctx.textAlign = 'left';
    });

    ctx.fillStyle = '#8a94a1';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = [lo, snap.ci.lo, 0, snap.ci.hi, hi];
    const kept: number[] = [];
    for (const t of ticks) {
      if (kept.some((k) => Math.abs(k - t) / span < 0.08)) continue;
      kept.push(t);
      ctx.fillText(fmtTick(t), xFor(t), h - padB + 16);
    }
    ctx.fillText(
      reg ? 'error delta, target units (shaded band: overall 95% CI)' : 'accuracy delta, points (shaded band: overall 95% CI)',
      padL + plotW / 2, h - 4,
    );
  });
}

function renderSliceTable(): void {
  const reg = snap.task === 'regression';
  const headRow = $('slice-head');
  headRow.replaceChildren();
  const heads = reg
    ? ['Slice', 'n', 'v1 MAE', 'v2 MAE', 'err delta [95% CI]', 'Worse', 'Enrichment', 'Fisher p']
    : ['Slice', 'n', 'v1 acc', 'v2 acc', 'delta [95% CI]', 'Regressions', 'Enrichment', 'Fisher p'];
  for (const h of heads) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.append(th);
  }
  const tbody = document.querySelector('#slice-table tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  const enrichBy = new Map(snap.enrichment.map((e) => [e.slice, e]));
  for (const s of snap.slices) {
    const en = enrichBy.get(s.slice);
    const tr = document.createElement('tr');
    const badRow = reg ? s.lo > 0 : s.hi < 0;
    if (badRow) tr.className = 'hl';
    const regsCount = reg ? (s.worse ?? 0) : (s.regressions ?? 0);
    const tds = reg
      ? [
          s.slice,
          String(s.n),
          s.errV1!.toFixed(4),
          s.errV2!.toFixed(4),
          `${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(4)} [${s.lo.toFixed(4)}, ${s.hi.toFixed(4)}]`,
          String(regsCount),
          en && en.regressions > 0 ? `${en.ratio.toFixed(1)}x base` : '-',
          en && en.regressions > 0 ? fmtP(en.fisherP) : '-',
        ]
      : [
          s.slice,
          String(s.n),
          pct(s.accV1!),
          pct(s.accV2!),
          `${signedPts(s.delta)} [${pts(s.lo)}, ${pts(s.hi)}]`,
          String(regsCount),
          en && en.regressions > 0 ? `${en.ratio.toFixed(1)}x base` : '-',
          en && en.regressions > 0 ? fmtP(en.fisherP) : '-',
        ];
    for (const t of tds) {
      const td = document.createElement('td');
      td.className = 'mono';
      td.textContent = t;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function renderExemplars(): void {
  const box = $('slice-exemplars');
  box.replaceChildren();
  for (const en of snap.enrichment) {
    if (en.regressions === 0 || !en.exemplars || en.exemplars.length === 0) continue;
    const row = el('div', 'g-row');
    row.append(el('div', 'g-kind regression',
      `${en.slice} - ${en.ratio.toFixed(1)}x base rate, Fisher p=${fmtP(en.fisherP)}`));
    row.append(el('div', 'g-note',
      en.fisherP < 0.05
        ? 'Regressions concentrate here beyond chance.'
        : 'The largest share of regressions lands here; with few total flips the enrichment is suggestive, not proof.'));
    for (const ex of en.exemplars) {
      row.append(el('div', 'g-q', ex.text));
    }
    box.append(row);
  }
}

/* ---------------- your models (BYO) ---------------- */
let byoGolden: Golden | null = null;
let byoSnap: Snapshot | null = null;
let byoNames: [string, string] = ['v1', 'v2'];

function byoStatus(msg: string, isError = false): void {
  const s = $('byo-status');
  s.textContent = msg;
  s.style.color = isError ? 'var(--bad)' : 'var(--text-faint)';
}

function buildByoGolden(rows: ReturnType<typeof joinCombined>, task: 'classification' | 'regression'): Golden {
  const hasSlices = rows.some((r) => r.slice !== null);
  if (task === 'classification') {
    const labelSet = [...new Set(rows.flatMap((r) => [r.gold, r.v1, r.v2]))].sort();
    const indexOf = new Map(labelSet.map((l, i) => [l, i]));
    return {
      slug: 'byo',
      title: 'your two builds',
      task,
      labels: labelSet,
      examples: rows.map((r, i) => ({
        id: r.id || `row-${i}`,
        text: r.id || `row ${i}`,
        label: indexOf.get(r.gold)!,
        slice: r.slice ?? 'all',
        v1: { p: indexOf.get(r.v1)!, s: 0, c: (r.v1 === r.gold ? 1 : 0) as 0 | 1 },
        v2: { p: indexOf.get(r.v2)!, s: 0, c: (r.v2 === r.gold ? 1 : 0) as 0 | 1 },
      })),
    };
  }
  return {
    slug: 'byo',
    title: 'your two builds',
    task,
    unit: 'units',
    examples: rows.map((r, i) => {
      const g = Number(r.gold), a = Number(r.v1), b = Number(r.v2);
      return {
        id: r.id || `row-${i}`,
        text: r.id || `row ${i}`,
        label: g,
        slice: r.slice ?? 'all',
        v1: { pred: a, err: Math.abs(a - g) },
        v2: { pred: b, err: Math.abs(b - g) },
      };
    }),
  };
}

function renderByoResults(): void {
  if (!byoSnap || !byoGolden) return;
  const s = byoSnap;
  const banner = $('byo-verdict');
  banner.className = `gate-banner ${s.verdict.ship ? 'ship' : 'hold'}`;
  banner.replaceChildren(
    el('p', 'gb-head', s.verdict.headline),
    el('p', 'gb-sub', `v1: ${byoNames[0]} · v2: ${byoNames[1]} · n=${s.n.toLocaleString('en-US')} · gate at defaults (maxDrop 0.5 pts / maxIncrease 0.02, alpha 0.05)`),
  );

  const grid = $('byo-stats');
  grid.replaceChildren();
  const cards: Array<[string, string, string, string]> = s.task === 'regression'
    ? [
        [`${s.maeV1!.toFixed(4)}`, `v1 MAE (${s.unit})`, '', byoNames[0]],
        [`${s.maeV2!.toFixed(4)}`, `v2 MAE (${s.unit})`, s.maeV2! > s.maeV1! ? 'bad' : 'ok', byoNames[1]],
        [`${s.errDelta! >= 0 ? '+' : ''}${s.errDelta!.toFixed(4)}`, 'paired error delta', s.errDelta! > 0 ? 'bad' : 'ok',
          `95% CI [${s.ci.lo.toFixed(4)}, ${s.ci.hi.toFixed(4)}]`],
        [fmtP(s.sign!.pExact), 'sign test exact p', s.sign!.pExact < 0.05 ? 'bad' : '', `${s.sign!.worse} worse vs ${s.sign!.better} better`],
      ]
    : [
        [`${pct(s.accV1!, 2)}`, 'v1 accuracy', '', byoNames[0]],
        [`${pct(s.accV2!, 2)}`, 'v2 accuracy', s.accV2! < s.accV1! ? 'bad' : 'ok', byoNames[1]],
        [`${signedPts(s.delta!)} pts`, 'paired delta', s.delta! < 0 ? 'bad' : 'ok', `95% CI [${pts(s.ci.lo)}, ${pts(s.ci.hi)}]`],
        [fmtP(s.mcnemar!.pExact), 'McNemar exact p', s.mcnemar!.pExact < 0.05 ? 'bad' : '',
          `${s.mcnemar!.b10} regressions vs ${s.mcnemar!.b01} improvements`],
      ];
  for (const [v, k, tone, sub] of cards) {
    const card = el('div', 'stat');
    card.append(el('div', `stat-v ${tone}`, v), el('div', 'stat-k', k), el('div', 'stat-ci', sub));
    grid.append(card);
  }

  // discordance / sign panel
  const grid2 = $('byo-discord');
  grid2.replaceChildren();
  if (s.task === 'regression') {
    $('byo-discord-title').textContent = 'Sign test on per-row error';
    const st = s.sign!;
    const cells: Array<[string, string, string]> = [
      ['', 'v2 better', 'v2 worse'],
      ['rows', String(st.better), String(st.worse)],
      ['ties', String(st.ties), ''],
    ];
    cells.forEach(([a, b, c], ri) => {
      [a, b, c].forEach((txt, ci) => {
        const isHead = ri === 0 || ci === 0;
        const d = el('div', isHead ? 'mh' : ri === 1 && ci === 2 ? 'hot' : ri === 1 && ci === 1 ? 'warm' : '');
        d.append(el('span', isHead ? '' : 'mv', txt));
        grid2.append(d);
      });
    });
    $('byo-discord-caption').textContent =
      `${st.worse} rows worse under the new build, ${st.better} better (${st.ties} ties excluded). p = ${fmtP(st.pExact)}.`;
  } else {
    $('byo-discord-title').textContent = 'McNemar discordance';
    const bothRight = byoGolden.examples.filter((e) => e.v1.c === 1 && e.v2.c === 1).length;
    const bothWrong = byoGolden.examples.filter((e) => e.v1.c === 0 && e.v2.c === 0).length;
    const cells: Array<[string, string, string]> = [
      ['', 'v2 correct', 'v2 wrong'],
      ['v1 correct', String(bothRight), String(s.mcnemar!.b10)],
      ['v1 wrong', String(s.mcnemar!.b01), String(bothWrong)],
    ];
    cells.forEach(([a, b, c], ri) => {
      [a, b, c].forEach((txt, ci) => {
        const isHead = ri === 0 || ci === 0;
        const d = el('div', isHead ? 'mh' : ri === 1 && ci === 2 ? 'hot' : ri === 2 && ci === 1 ? 'warm' : '');
        d.append(el('span', isHead ? '' : 'mv', txt));
        grid2.append(d);
      });
    });
    $('byo-discord-caption').textContent =
      `${s.mcnemar!.b10} examples flipped for the worse, ${s.mcnemar!.b01} for the better. ` +
      `Exact binomial p = ${fmtP(s.mcnemar!.pExact)} (chi-square ${fmtP(s.mcnemar!.pChi2)}).`;
  }

  // slices
  const swrap = $('byo-slices-wrap');
  const hasSlices = byoGolden.examples.some((e) => e.slice !== 'all');
  swrap.hidden = !hasSlices;
  if (hasSlices) {
    const tbody = document.querySelector('#byo-slices tbody');
    if (tbody) {
      tbody.replaceChildren();
      for (const row of s.slices) {
        const tr = document.createElement('tr');
        const cells = s.task === 'regression'
          ? [row.slice, String(row.n), row.errV1!.toFixed(4), row.errV2!.toFixed(4),
             `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(4)} [${row.lo.toFixed(4)}, ${row.hi.toFixed(4)}]`]
          : [row.slice, String(row.n), pct(row.accV1!), pct(row.accV2!),
             `${signedPts(row.delta)} [${pts(row.lo)}, ${pts(row.hi)}]`];
        for (const t of cells) {
          const td = document.createElement('td');
          td.className = 'mono';
          td.textContent = t;
          tr.append(td);
        }
        tbody.append(tr);
      }
    }
  }

  $('byo-results').hidden = false;
  drawByoCharts();
}

function drawByoCharts(): void {
  if (!byoSnap || $('tab-byo').hidden) return;
  const s = byoSnap;
  if (s.task === 'regression') {
    $('byo-hist-title').textContent = 'Paired bootstrap: mean error delta (v2 - v1)';
    drawHistogramGeneric('byo-hist', s.bootHistogram, s.ci, s.errDelta!,
      `mean absolute-error delta, ${s.unit}`, (x) => x.toFixed(3));
    $('byo-hist-caption').textContent =
      `95% of resampled error deltas fall in [${s.ci.lo.toFixed(4)}, ${s.ci.hi.toFixed(4)}] ${s.unit}.`;
  } else {
    $('byo-hist-title').textContent = 'Paired bootstrap: accuracy delta (v2 - v1)';
    drawHistogramGeneric('byo-hist', s.bootHistogram, s.ci, s.delta!,
      'accuracy delta, points', (x) => pts(x));
    $('byo-hist-caption').textContent =
      `95% of resampled deltas fall in [${pts(s.ci.lo)}, ${pts(s.ci.hi)}] points.`;
  }
}

function wireByo(): void {
  const form = $('byo-form') as HTMLFormElement;
  const file = $('byo-file') as HTMLInputElement;
  const taskSel = $('byo-task') as HTMLSelectElement;
  const names = $('byo-names') as HTMLInputElement;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    byoStatus('');
    const f = file.files?.[0];
    if (!f) {
      byoStatus('choose a CSV first', true);
      return;
    }
    try {
      const text = await f.text();
      const rows = joinCombined(parseCsv(text));
      const detected = detectTask(rows);
      const task = taskSel.value === 'auto' ? detected : (taskSel.value as 'classification' | 'regression');
      if (task === 'regression') {
        for (const r of rows) {
          for (const [which, v] of [['gold', r.gold], ['v1', r.v1], ['v2', r.v2]] as Array<[string, string]>) {
            if (v === '' || Number.isNaN(Number(v))) {
              throw new Error(`row ${r.id}: ${which} value "${v}" is not numeric (task = regression)`);
            }
          }
        }
      }
      const nm = names.value.split(',').map((s) => s.trim()).filter(Boolean);
      byoNames = [nm[0] ?? 'v1 (incumbent)', nm[1] ?? 'v2 (candidate)'];
      // resample budget scales down for very large uploads
      const n = rows.length;
      const resamples = n <= 2000 ? 10000 : n <= 8000 ? 4000 : 2000;
      byoGolden = buildByoGolden(rows, task);
      byoSnap = analyze(byoGolden, { bootResamples: resamples }) as Snapshot;
      renderByoResults();
      byoStatus(
        `${n.toLocaleString('en-US')} rows, task ${task}${taskSel.value === 'auto' ? ' (detected)' : ''}, ` +
        `${resamples.toLocaleString('en-US')} resamples - computed locally, nothing uploaded.`,
      );
    } catch (err) {
      byoSnap = null;
      $('byo-results').hidden = true;
      byoStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  $('byo-report').addEventListener('click', () => {
    if (!byoSnap) return;
    const blob = new Blob([reportMarkdown(byoSnap, byoNames, 'in-browser')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backslide-report.md';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

/* ---------------- render all ---------------- */
function renderAll(): void {
  $('boot-stats').textContent =
    `${snap.title} · ${snap.pins.dataset.name} (n=${snap.n.toLocaleString('en-US')}) · snapshot ${snap.generated} · ` +
    (snap.task === 'regression'
      ? `err delta ${snap.errDelta! >= 0 ? '+' : ''}${snap.errDelta!.toFixed(4)} ${snap.unit} [${snap.ci.lo.toFixed(4)}, ${snap.ci.hi.toFixed(4)}], sign test p=${fmtP(snap.sign!.pExact)}`
      : `delta ${signedPts(snap.delta!)} pts [${pts(snap.ci.lo)}, ${pts(snap.ci.hi)}], McNemar p=${fmtP(snap.mcnemar!.pExact)}`);

  renderVerdictNote();
  renderVerdictStats();
  wireGate();
  renderAllPairsTable();
  renderExamplesHead();
  renderFilters();
  renderExamples();
  drawHistogram();
  drawDiscordance();
  renderClassBreakdown();
  renderStatCards();
  drawForest();
  renderSliceTable();
  renderExemplars();

  $('slices-note').textContent = snap.task === 'regression'
    ? 'Regressions rarely spread evenly. Each row carries a deterministic price-band tag; the ' +
      'forest plot shows the per-slice error delta with its bootstrap interval, and the table ' +
      'adds an enrichment test - is this band holding more than its share of the worsened rows?'
    : 'Regressions rarely spread evenly. Each example carries deterministic capability tags ' +
      '(negation, comparative, numeric, length); the forest plot shows the per-slice accuracy ' +
      'delta with its bootstrap interval, and the table adds an enrichment test - is this slice ' +
      'holding more than its share of the regressions?';
  $('stats-note').textContent = snap.task === 'regression'
    ? 'Paired statistics use both builds\' errors on the same rows, which is far more ' +
      'sensitive than comparing two independent MAE numbers.'
    : 'Paired statistics use both models\' answers on the same examples, which is far more ' +
      'sensitive than comparing two independent accuracy numbers.';
}

/* ---------------- boot ---------------- */
async function main(): Promise<void> {
  const bundle = await fetch('./data/pairs/bundle.json').then((r) => {
    if (!r.ok) throw new Error(`bundle: HTTP ${r.status}`);
    return r.json() as Promise<{
      pairs: IndexEntry[];
      artifacts: Record<string, { golden: Golden; snapshot: Snapshot }>;
    }>;
  });
  pairsIndex = bundle.pairs;
  for (const [slug, a] of Object.entries(bundle.artifacts)) {
    artifacts.set(slug, { golden: a.golden, snap: a.snapshot });
  }
  const requested = new URLSearchParams(location.search).get('pair');
  const initial = pairsIndex.some((p) => p.slug === requested)
    ? requested!
    : 'sst2-int8';
  await selectPair(initial, false);
  wireProbe();
  wireByo();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      drawHistogram();
      drawForest();
      drawByoCharts();
    }, 150);
  });
}

main().catch((err) => {
  $('boot-stats').textContent = `failed to load artifacts: ${err instanceof Error ? err.message : String(err)}`;
});
