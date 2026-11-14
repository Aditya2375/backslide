#!/usr/bin/env node
/**
 * backslide CLI - gate a candidate model build against its incumbent with
 * paired statistics, in CI or on a laptop. Zero runtime dependencies.
 *
 *   node cli/backslide.mjs compare --combined preds.csv [options]
 *   node cli/backslide.mjs compare --gold gold.csv --v1 old.csv --v2 new.csv [options]
 *
 * Options:
 *   --task auto|classification|regression   (default auto)
 *   --max-drop PTS      tolerated accuracy drop in points (classification, 0.5)
 *   --max-increase U    tolerated MAE increase in target units (regression, 0.02)
 *   --alpha A           significance level (0.05)
 *   --resamples N       bootstrap resamples (10000)
 *   --seed S            bootstrap seed (1337)
 *   --unit U            regression target unit label (units)
 *   --names "a,b"       display names for the two builds
 *   --json PATH         write the full snapshot as JSON
 *   --md PATH           write a markdown report
 *   --quiet             only the exit code
 *
 * Exit codes: 0 ship, 1 hold, 2 usage/data error.
 * Needs the compiled engine: run `npm ci && npm run build` once first.
 */
import { readFileSync, writeFileSync } from 'node:fs';

async function loadEngine() {
  try {
    const [analyze, parse, stats, report] = await Promise.all([
      import('../dist/src/analyze.js'),
      import('../dist/src/parse.js'),
      import('../dist/src/stats.js'),
      import('../dist/src/report.js'),
    ]);
    return { ...analyze, ...parse, ...stats, ...report };
  } catch {
    console.error('backslide: engine not built. Run: npm ci && npm run build');
    process.exit(2);
  }
}

function parseArgs(argv) {
  const args = { task: 'auto', maxDrop: 0.5, maxIncrease: 0.02, alpha: 0.05, resamples: 10000, seed: 1337, unit: 'units' };
  const pos = [];
  const FLAGS = new Set(['--quiet']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (FLAGS.has(a)) { args[key] = true; continue; }
      const val = argv[++i];
      if (val === undefined) throw new Error(`option ${a} needs a value`);
      args[key] = val;
    } else {
      pos.push(a);
    }
  }
  return { cmd: pos[0], args };
}

const { cmd, args } = parseArgs(process.argv.slice(2));
if (cmd !== 'compare') {
  console.error('usage: node cli/backslide.mjs compare (--combined F | --gold F --v1 F --v2 F) [options]');
  process.exit(cmd === undefined ? 0 : 2);
}
if (!args.combined && !(args.gold && args.v1 && args.v2)) {
  console.error('backslide: give either --combined FILE or --gold FILE --v1 FILE --v2 FILE');
  process.exit(2);
}

const E = await loadEngine();

let rows;
try {
  if (args.combined) {
    rows = E.joinCombined(E.parseCsv(readFileSync(args.combined, 'utf8'), Infinity));
  } else {
    rows = E.joinSeparate(
      E.parseCsv(readFileSync(args.gold, 'utf8'), Infinity),
      E.parseCsv(readFileSync(args.v1, 'utf8'), Infinity),
      E.parseCsv(readFileSync(args.v2, 'utf8'), Infinity),
    );
  }
} catch (err) {
  console.error(`backslide: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const task = args.task === 'auto' ? E.detectTask(rows) : args.task;
if (task !== 'classification' && task !== 'regression') {
  console.error(`backslide: unknown --task ${args.task}`);
  process.exit(2);
}

const names = (args.names ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const v1Name = names[0] ?? 'v1 (incumbent)';
const v2Name = names[1] ?? 'v2 (candidate)';

let golden;
if (task === 'classification') {
  const labelSet = [...new Set(rows.flatMap((r) => [r.gold, r.v1, r.v2]))].sort();
  const indexOf = new Map(labelSet.map((l, i) => [l, i]));
  golden = {
    slug: 'cli',
    title: 'CLI comparison',
    task,
    labels: labelSet,
    measured: 'cli',
    examples: rows.map((r, i) => ({
      id: r.id || `row-${i}`,
      text: r.id || `row ${i}`,
      label: indexOf.get(r.gold),
      slice: r.slice ?? 'all',
      v1: { p: indexOf.get(r.v1), s: 0, c: r.v1 === r.gold ? 1 : 0 },
      v2: { p: indexOf.get(r.v2), s: 0, c: r.v2 === r.gold ? 1 : 0 },
    })),
  };
} else {
  for (const r of rows) {
    for (const [which, v] of [['gold', r.gold], ['v1', r.v1], ['v2', r.v2]]) {
      if (v === '' || Number.isNaN(Number(v))) {
        console.error(`backslide: row ${r.id}: ${which} value "${v}" is not numeric (task = regression)`);
        process.exit(2);
      }
    }
  }
  golden = {
    slug: 'cli',
    title: 'CLI comparison',
    task,
    unit: args.unit,
    measured: 'cli',
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

const snap = E.analyze(golden, {
  bootResamples: Number(args.resamples),
  bootSeed: Number(args.seed),
  gateDrop: Number(args.maxDrop) / 100,
  gateIncrease: Number(args.maxIncrease),
  gateAlpha: Number(args.alpha),
});

if (args.json) writeFileSync(args.json, JSON.stringify(snap, null, 2));
if (args.md) writeFileSync(args.md, E.reportMarkdown(snap, [v1Name, v2Name], 'by the backslide CLI'));

if (!args.quiet) {
  const out = [];
  out.push(`backslide: ${task} · n=${snap.n}`);
  if (task === 'classification') {
    out.push(`  accuracy: ${(snap.accV1 * 100).toFixed(2)}% -> ${(snap.accV2 * 100).toFixed(2)}%  ` +
      `(delta ${(snap.delta * 100).toFixed(2)} pts, 95% CI [${(snap.ci.lo * 100).toFixed(2)}, ${(snap.ci.hi * 100).toFixed(2)}])`);
    out.push(`  McNemar: ${snap.mcnemar.b10} regressions vs ${snap.mcnemar.b01} improvements, ` +
      `exact p=${E.fmtP(snap.mcnemar.pExact)} (chi-square ${E.fmtP(snap.mcnemar.pChi2)})`);
  } else {
    out.push(`  MAE: ${snap.maeV1.toFixed(4)} -> ${snap.maeV2.toFixed(4)} ${snap.unit}  ` +
      `(delta ${snap.errDelta >= 0 ? '+' : ''}${snap.errDelta.toFixed(4)}, 95% CI [${snap.ci.lo.toFixed(4)}, ${snap.ci.hi.toFixed(4)}])`);
    out.push(`  sign test: ${snap.sign.worse} worse vs ${snap.sign.better} better (${snap.sign.ties} ties), p=${E.fmtP(snap.sign.pExact)}`);
  }
  for (const r of snap.verdict.reasons) out.push(`  ${r}`);
  out.push(`  verdict: ${snap.verdict.ship ? 'SHIP' : 'HOLD'}`);
  console.log(out.join('\n'));
}

process.exit(snap.verdict.ship ? 0 : 1);
