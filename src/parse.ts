/**
 * CSV parsing and task detection, shared by the browser "your models" flow
 * and the Node CLI. Dependency-free, no eval, no prototype tricks: every
 * value stays a string until the caller validates it.
 */

export const MAX_CSV_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS = 20000;

/** RFC4180-ish CSV: quoted fields, escaped quotes, CRLF/LF. No header magic. */
export function parseCsv(text: string, maxBytes: number = MAX_CSV_BYTES): string[][] {
  if (text.length > maxBytes) {
    throw new Error(`file too large (${(text.length / 1e6).toFixed(1)} MB); cap is ${(maxBytes / 1e6).toFixed(0)} MB`);
  }
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
        if (rows.length > MAX_ROWS) {
          throw new Error(`too many rows; cap is ${MAX_ROWS.toLocaleString('en-US')}`);
        }
      }
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ColumnPick {
  id: number;
  gold: number;
  v1: number;
  v2: number;
  slice: number; // -1 when absent
}

/**
 * Resolve column indexes from a header row. Accepts the canonical names
 * (id, gold, v1, v2, slice) case-insensitively, with a few obvious aliases.
 */
export function resolveColumns(header: string[]): ColumnPick {
  const norm = header.map((h) => h.trim().toLowerCase());
  const find = (names: string[]): number => {
    for (const n of names) {
      const i = norm.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const id = find(['id', 'example', 'example_id', 'key']);
  const gold = find(['gold', 'label', 'target', 'truth', 'y', 'actual']);
  const v1 = find(['v1', 'incumbent', 'old', 'baseline', 'pred_v1', 'pred_old']);
  const v2 = find(['v2', 'candidate', 'new', 'pred_v2', 'pred_new']);
  const slice = find(['slice', 'segment', 'group']);
  if (gold < 0 || v1 < 0 || v2 < 0) {
    throw new Error(
      'header must name gold/v1/v2 columns ' +
      '(accepted: gold|label|target, v1|incumbent|old|baseline, v2|candidate|new)',
    );
  }
  return { id, gold, v1, v2, slice };
}

export interface JoinedRow {
  id: string;
  gold: string;
  v1: string;
  v2: string;
  slice: string | null;
}

/**
 * Join a combined CSV (one row per example, gold + both predictions) into
 * analysis rows. First row must be a header.
 */
export function joinCombined(rows: string[][]): JoinedRow[] {
  if (rows.length < 2) throw new Error('file has a header but no data rows');
  const cols = resolveColumns(rows[0]!);
  const out: JoinedRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const id = cols.id >= 0 ? (r[cols.id] ?? '').trim() : `row-${i}`;
    if (seen.has(id)) throw new Error(`duplicate id "${id}"`);
    seen.add(id);
    out.push({
      id,
      gold: (r[cols.gold] ?? '').trim(),
      v1: (r[cols.v1] ?? '').trim(),
      v2: (r[cols.v2] ?? '').trim(),
      slice: cols.slice >= 0 ? ((r[cols.slice] ?? '').trim() || null) : null,
    });
  }
  return out;
}

/** Join separate gold/v1/v2 files (each: id,value with header) on id. */
export function joinSeparate(goldRows: string[][], v1Rows: string[][], v2Rows: string[][]): JoinedRow[] {
  const toMap = (rows: string[][], name: string): Map<string, string> => {
    if (rows.length < 2) throw new Error(`${name}: file has a header but no data rows`);
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const idCol = header.indexOf('id') >= 0 ? header.indexOf('id') : 0;
    const valCol = header.findIndex((h, i) => i !== idCol && h !== 'slice');
    if (valCol < 0) throw new Error(`${name}: needs an id column and a value column`);
    const m = new Map<string, string>();
    for (let i = 1; i < rows.length; i++) {
      const id = (rows[i]![idCol] ?? '').trim();
      if (m.has(id)) throw new Error(`${name}: duplicate id "${id}"`);
      m.set(id, (rows[i]![valCol] ?? '').trim());
    }
    return m;
  };
  const gold = toMap(goldRows, 'gold file');
  const v1 = toMap(v1Rows, 'v1 file');
  const v2 = toMap(v2Rows, 'v2 file');
  const out: JoinedRow[] = [];
  for (const [id, g] of gold) {
    const a = v1.get(id);
    const b = v2.get(id);
    if (a === undefined || b === undefined) {
      throw new Error(`id "${id}" is missing a prediction in ${a === undefined ? 'the v1 file' : 'the v2 file'}`);
    }
    out.push({ id, gold: g, v1: a, v2: b, slice: null });
  }
  return out;
}

const isNum = (s: string): boolean => s !== '' && !Number.isNaN(Number(s));

/**
 * Task detection: regression when every value is numeric and the gold column
 * carries non-integers or more than 20 distinct values; otherwise
 * classification. Callers expose an explicit override - detection is a hint.
 */
export function detectTask(rows: JoinedRow[]): 'classification' | 'regression' {
  const allNumeric = rows.every((r) => isNum(r.gold) && isNum(r.v1) && isNum(r.v2));
  if (!allNumeric) return 'classification';
  const golds = rows.map((r) => Number(r.gold));
  const distinct = new Set(golds).size;
  const anyFractional = golds.some((g) => !Number.isInteger(g));
  return anyFractional || distinct > 20 ? 'regression' : 'classification';
}
