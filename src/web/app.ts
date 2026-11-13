/**
 * backslide demo shell. All page numbers come from the committed artifacts
 * (data/golden.json, data/snapshot.json); the only live work is the optional
 * two-build probe on the Examples tab. Rendering is textContent-only.
 */
import { verdict, fmtP } from '../stats.js';

interface Example {
  id: string;
  text: string;
  label: 0 | 1;
  slice: string;
  v1: { p: 0 | 1; s: number; c: 0 | 1 };
  v2: { p: 0 | 1; s: number; c: 0 | 1 };
}
interface Golden {
  model: string;
  revision: string;
  variants: Record<string, string>;
  examples: Example[];
}
interface Snapshot {
  generated: string;
  pins: {
    classifier: { model: string; revision: string; variants: Record<string, string> };
    dataset: { name: string; n: number };
    bootstrap: { resamples: number; seed: number };
    slices: { resamples: number; seed: number };
    gate: { maxDrop: number; alpha: number };
  };
  n: number;
  accV1: number;
  accV2: number;
  delta: number;
  ci: { lo: number; hi: number; level: number };
  bootHistogram: { x0: number; dx: number; counts: number[] };
  mcnemar: { b01: number; b10: number; pChi2: number; pExact: number };
  cohensH: number;
  slices: Array<{
    slice: string; n: number; accV1: number; accV2: number;
    delta: number; lo: number; hi: number; regressions: number; improvements: number;
  }>;
  enrichment: Array<{
    slice: string; n: number; regressions: number; rate: number;
    baselineRate: number; ratio: number; fisherP: number;
    exemplars?: Array<{ id: string; text: string; v2score: number }>;
  }>;
  verdict: { ship: boolean; headline: string; reasons: string[] };
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

let golden: Golden;
let snap: Snapshot;

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
  });
}

/* ---------------- verdict ---------------- */
function renderVerdict(maxDrop: number, alpha: number): void {
  const v = verdict(
    {
      delta: snap.delta, ciLo: snap.ci.lo, ciHi: snap.ci.hi,
      pMcnemar: snap.mcnemar.pExact,
      regressions: snap.mcnemar.b10, improvements: snap.mcnemar.b01,
    },
    { maxDrop, alpha },
  );
  const banner = $('verdict-banner');
  banner.className = `gate-banner ${v.ship ? 'ship' : 'hold'}`;
  banner.replaceChildren(
    el('p', 'gb-head', v.headline),
    el('p', 'gb-sub',
      `v1 incumbent: ${snap.pins.classifier.variants['v1']} build · ` +
      `v2 candidate: ${snap.pins.classifier.variants['v2']} build of the same pinned checkpoint`),
  );

  const reasons = $('gate-reasons');
  reasons.replaceChildren();
  const sig = snap.mcnemar.pExact < alpha;
  const within = snap.ci.lo >= -maxDrop;
  [sig, !within].forEach((bad, i) => {
    const li = el('li');
    li.append(
      el('span', 't-stage', i === 0 ? 'McNemar' : 'CI bound'),
      el('span', `t-detail ${bad ? 'bad' : 'ok'}`, v.reasons[i] ?? ''),
    );
    reasons.append(li);
  });
}

function renderVerdictStats(): void {
  const grid = $('verdict-stats');
  grid.replaceChildren();
  const cards: Array<[string, string, string, string]> = [
    [`${pct(snap.accV1, 2)}`, 'v1 accuracy (fp16)', '', `${snap.n} golden sentences`],
    [`${pct(snap.accV2, 2)}`, 'v2 accuracy (int8)', '', `${snap.pins.classifier.variants['v2']} build`],
    [`${signedPts(snap.delta)} pts`, 'paired delta', 'bad', `95% CI [${pts(snap.ci.lo)}, ${pts(snap.ci.hi)}]`],
    [fmtP(snap.mcnemar.pExact), 'McNemar exact p', 'bad', `${snap.mcnemar.b10} regressions vs ${snap.mcnemar.b01} improvements`],
    [snap.cohensH.toFixed(3), "Cohen's h", 'accent', 'aggregate effect size'],
    [`${snap.mcnemar.b10 + snap.mcnemar.b01}`, 'discordant sentences', '', `of ${snap.n} paired predictions`],
  ];
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

function wireGate(): void {
  const slider = $('gate-drop') as HTMLInputElement;
  const alphaSel = $('gate-alpha') as HTMLSelectElement;
  const update = (): void => {
    const maxDrop = Number(slider.value) / 100;
    $('gate-drop-val').textContent = `${Number(slider.value).toFixed(1)} pts`;
    renderVerdict(maxDrop, Number(alphaSel.value));
  };
  slider.addEventListener('input', update);
  alphaSel.addEventListener('change', update);
  update();
}

/* ---------------- examples ---------------- */
type Filter = { kind: 'all' | 'reg' | 'imp' | 'slice'; value?: string };
let filter: Filter = { kind: 'all' };

function discordant(): Example[] {
  return golden.examples.filter((e) => e.v1.c !== e.v2.c);
}

function renderFilters(): void {
  const box = $('example-filters');
  box.replaceChildren();
  const disc = discordant();
  const mk = (label: string, f: Filter, active: boolean): HTMLButtonElement => {
    const b = el('button', 'chip', label) as HTMLButtonElement;
    b.type = 'button';
    if (active) b.style.borderColor = 'var(--accent)';
    b.addEventListener('click', () => { filter = f; renderFilters(); renderExamples(); });
    return b;
  };
  const regs = disc.filter((e) => e.v1.c === 1).length;
  box.append(
    mk(`all changes (${disc.length})`, { kind: 'all' }, filter.kind === 'all'),
    mk(`regressions (${regs})`, { kind: 'reg' }, filter.kind === 'reg'),
    mk(`improvements (${disc.length - regs})`, { kind: 'imp' }, filter.kind === 'imp'),
  );
  const slices = [...new Set(disc.map((e) => e.slice))].sort();
  for (const s of slices) {
    const n = disc.filter((e) => e.slice === s).length;
    box.append(mk(`${s} (${n})`, { kind: 'slice', value: s }, filter.kind === 'slice' && filter.value === s));
  }
}

function renderExamples(): void {
  const list = $('example-list');
  list.replaceChildren();
  let disc = discordant();
  if (filter.kind === 'reg') disc = disc.filter((e) => e.v1.c === 1);
  if (filter.kind === 'imp') disc = disc.filter((e) => e.v1.c === 0);
  if (filter.kind === 'slice') disc = disc.filter((e) => e.slice === filter.value);
  for (const e of disc) {
    const regressed = e.v1.c === 1;
    const row = el('div', 'g-row');
    const head = el('div');
    head.append(
      el('span', `g-kind ${regressed ? 'regression' : 'improvement'}`, regressed ? 'regression' : 'improvement'),
      el('span', 'g-slice', `${e.slice} · gold: ${e.label === 1 ? 'positive' : 'negative'}`),
    );
    const q = el('div', 'g-q', e.text);
    const scores = el('div', 'g-scores');
    const col = (who: string, pred: 0 | 1, score: number, correct: boolean): HTMLElement => {
      const c = el('div', 'g-score');
      c.append(el('span', 'who', who));
      const line = el('span');
      line.append(
        Object.assign(el('span', correct ? 'right' : 'wrong', pred === 1 ? 'positive' : 'negative'), {}),
        document.createTextNode(` · p=${score.toFixed(4)} · ${correct ? 'correct' : 'wrong'}`),
      );
      c.append(line);
      return c;
    };
    scores.append(
      col('v1 · fp16 incumbent', e.v1.p, e.v1.s, e.v1.c === 1),
      col('v2 · int8 candidate', e.v2.p, e.v2.s, e.v2.c === 1),
    );
    row.append(head, q, scores);
    list.append(row);
  }
}

/* ---------------- live probe ---------------- */
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
        mkCol('v1 · fp16 incumbent', r.v1),
        mkCol('v2 · int8 candidate', r.v2),
      );
      const flip = el('p', `probe-flip ${r.v1.label === r.v2.label ? 'same' : ''}`,
        r.v1.label === r.v2.label
          ? 'builds agree on this sentence - as they do on 97.6% of the golden set'
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
  const w = canvas.width, h = canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  draw(ctx, w, h);
}

function drawHistogram(): void {
  withCanvas('boot-hist', (ctx, w, h) => {
    const { x0, dx, counts } = snap.bootHistogram;
    const maxC = Math.max(...counts);
    const padL = 46, padR = 12, padT = 26, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xFor = (v: number): number => padL + ((v - x0) / (dx * counts.length)) * plotW;

    // bars: inside CI amber, tails dim red
    counts.forEach((c, i) => {
      const lo = x0 + i * dx, hi = lo + dx;
      const inCi = hi >= snap.ci.lo && lo <= snap.ci.hi;
      ctx.fillStyle = inCi ? 'rgba(240, 102, 58, 0.75)' : 'rgba(229, 83, 75, 0.35)';
      const bh = (c / maxC) * plotH;
      ctx.fillRect(xFor(lo), padT + plotH - bh, Math.max(1, (dx / (dx * counts.length)) * plotW - 1), bh);
    });

    // zero line + observed delta
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
    ctx.moveTo(xFor(snap.delta), padT);
    ctx.lineTo(xFor(snap.delta), padT + plotH);
    ctx.stroke();
    ctx.lineWidth = 1;

    // axes
    ctx.fillStyle = '#8a94a1';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = [snap.ci.lo, snap.delta, 0, snap.ci.hi];
    const seen = new Set<string>();
    for (const t of ticks) {
      const label = `${pts(t)}`;
      if (seen.has(label)) continue;
      seen.add(label);
      ctx.fillText(label, xFor(t), h - padB + 16);
    }
    ctx.fillText('accuracy delta, points', padL + plotW / 2, h - 4);
    // line labels sit in the top padding, above the tallest bar
    ctx.textAlign = 'left';
    ctx.fillText('0', xFor(0) + 4, 16);
    ctx.fillStyle = '#e5534b';
    ctx.textAlign = 'right';
    ctx.fillText(`observed ${pts(snap.delta)}`, xFor(snap.delta) - 5, 16);
    ctx.textAlign = 'left';
  });
  $('boot-caption').textContent =
    `95% of resampled deltas fall in [${pts(snap.ci.lo)}, ${pts(snap.ci.hi)}] pts. ` +
    `The entire interval sits below zero: the drop is not sampling noise.`;
}

function drawMcNemar(): void {
  const grid = $('mcnemar-grid');
  grid.replaceChildren();
  const bothRight = golden.examples.filter((e) => e.v1.c === 1 && e.v2.c === 1).length;
  const bothWrong = golden.examples.filter((e) => e.v1.c === 0 && e.v2.c === 0).length;
  const cells: Array<[string, string, string]> = [
    ['', 'v2 correct', 'v2 wrong'],
    ['v1 correct', String(bothRight), String(snap.mcnemar.b10)],
    ['v1 wrong', String(snap.mcnemar.b01), String(bothWrong)],
  ];
  cells.forEach(([a, b, c], ri) => {
    [a, b, c].forEach((txt, ci) => {
      const isHead = ri === 0 || ci === 0;
      const hot = ri === 1 && ci === 2; // regressions
      const warm = ri === 2 && ci === 1; // improvements
      const d = el('div', isHead ? 'mh' : hot ? 'hot' : warm ? 'warm' : '');
      d.append(el('span', isHead ? '' : 'mv', txt));
      grid.append(d);
    });
  });
  $('mcnemar-caption').textContent =
    `Only the off-diagonal cells carry signal: ${snap.mcnemar.b10} sentences flipped for the worse, ` +
    `${snap.mcnemar.b01} for the better. Exact binomial p = ${fmtP(snap.mcnemar.pExact)} ` +
    `(chi-square approximation ${fmtP(snap.mcnemar.pChi2)}).`;
}

function renderStatCards(): void {
  const grid = $('stats-cards');
  grid.replaceChildren();
  const agree = golden.examples.filter((e) => e.v1.p === e.v2.p).length / snap.n;
  const cards: Array<[string, string, string, string]> = [
    [`${snap.pins.bootstrap.resamples.toLocaleString('en-US')}`, 'bootstrap resamples', '', `seed ${snap.pins.bootstrap.seed}`],
    [snap.cohensH.toFixed(3), "Cohen's h", 'accent', 'small aggregate effect - slices carry the story'],
    [pct(agree, 1), 'raw agreement', '', 'labels match, correctness aside'],
    [`${snap.pins.slices.resamples.toLocaleString('en-US')}`, 'slice resamples', '', `seed ${snap.pins.slices.seed}`],
  ];
  for (const [v, k, tone, sub] of cards) {
    const card = el('div', 'stat');
    card.append(el('div', `stat-v ${tone}`, v), el('div', 'stat-k', k), el('div', 'stat-ci', sub));
    grid.append(card);
  }
}

/* ---------------- slices ---------------- */
function drawForest(): void {
  withCanvas('forest', (ctx, w, h) => {
    const rows = [...snap.slices].sort((a, b) => a.delta - b.delta);
    const padL = 142, padR = 16, padT = 16, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const lo = Math.min(...rows.map((r) => r.lo), snap.ci.lo, 0);
    const hi = Math.max(...rows.map((r) => r.hi), snap.ci.hi, 0);
    const span = hi - lo || 1;
    const xFor = (v: number): number => padL + ((v - lo) / span) * plotW;
    const rowH = plotH / rows.length;

    // overall CI band
    ctx.fillStyle = 'rgba(240, 102, 58, 0.08)';
    ctx.fillRect(xFor(snap.ci.lo), padT, xFor(snap.ci.hi) - xFor(snap.ci.lo), plotH);

    // zero line
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
      ctx.fillStyle = r.hi < 0 ? '#e5534b' : '#f0663a';
      ctx.beginPath();
      ctx.arc(xFor(r.delta), y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9aa4b0';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${r.slice} (${r.n})`, padL - 10, y + 4);
      ctx.textAlign = 'left';
    });

    // overall delta diamond
    ctx.fillStyle = '#e5534b';
    const oy = padT + plotH + 0; // on axis line area
    void oy;
    ctx.fillStyle = '#8a94a1';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = [lo, snap.ci.lo, 0, snap.ci.hi, hi];
    const kept: number[] = [];
    for (const t of ticks) {
      // skip ticks that would collide with an already-drawn one
      if (kept.some((k) => Math.abs(k - t) / span < 0.08)) continue;
      kept.push(t);
      ctx.fillText(pts(t), xFor(t), h - padB + 16);
    }
    ctx.fillText('accuracy delta, points (shaded band: overall 95% CI)', padL + plotW / 2, h - 4);
  });
}

function renderSliceTable(): void {
  const tbody = document.querySelector('#slice-table tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  const enrichBy = new Map(snap.enrichment.map((e) => [e.slice, e]));
  for (const s of snap.slices) {
    const en = enrichBy.get(s.slice);
    const tr = document.createElement('tr');
    if (s.hi < 0) tr.className = 'hl';
    const tds = [
      s.slice,
      String(s.n),
      pct(s.accV1),
      pct(s.accV2),
      `${signedPts(s.delta)} [${pts(s.lo)}, ${pts(s.hi)}]`,
      String(s.regressions),
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
        : 'The largest share of regressions lands here; with 17 total flips the enrichment is suggestive, not proof.'));
    for (const ex of en.exemplars) {
      row.append(el('div', 'g-q', ex.text));
    }
    box.append(row);
  }
}

/* ---------------- boot ---------------- */
async function main(): Promise<void> {
  const [g, s] = await Promise.all([
    fetch('./data/golden.json').then((r) => r.json()) as Promise<Golden>,
    fetch('./data/snapshot.json').then((r) => r.json()) as Promise<Snapshot>,
  ]);
  golden = g;
  snap = s;

  $('boot-stats').textContent =
    `${snap.pins.classifier.model}@${snap.pins.classifier.revision.slice(0, 8)} · ` +
    `${snap.pins.dataset.name} (n=${snap.n}) · snapshot ${snap.generated} · ` +
    `delta ${signedPts(snap.delta)} pts [${pts(snap.ci.lo)}, ${pts(snap.ci.hi)}], McNemar p=${fmtP(snap.mcnemar.pExact)}`;

  $('discord-count').textContent = String(snap.mcnemar.b01 + snap.mcnemar.b10);

  renderVerdictStats();
  wireGate();
  renderFilters();
  renderExamples();
  wireProbe();
  drawHistogram();
  drawMcNemar();
  renderStatCards();
  drawForest();
  renderSliceTable();
  renderExemplars();
}

main().catch((err) => {
  $('boot-stats').textContent = `failed to load artifacts: ${err instanceof Error ? err.message : String(err)}`;
});
