/* FinPal Family - statements saved as PDF.

   A PDF page is positioned text, not a table. The text of every page is read with pdf.js, put back into
   lines, rows and columns, and handed to the same Leumi and MAX readers as a spreadsheet:
   - a line: pieces of text on one baseline;
   - a table starts at a header line (words such as "תאריך", "תיאור", "סכום חיוב"); the same header again
     at the top of the next page continues it;
   - columns: the empty vertical strips that run through all the rows with a date;
   - a line without a date right under a row continues that row's text (a description on two lines).
   Hebrew is stored in a PDF in visual order. pdf.js gives every piece in reading order, and the pieces of
   one cell are put in reading order here: right to left, with numbers and Latin words left to right. */

const HEB = /[֐-׿]/;
const LTR = /[A-Za-z0-9]/;
const DATE = /(^|[^\d])\d{1,2}[./-]\d{1,2}[./-](\d{4}|\d{2})(?![\d])/;
const NUMERIC = /^[\s()+\-₪$€£.,\d]+$/;
const MAX_PAGES = 200;
const MAX_RUNS = 300000;

export class PdfPasswordError extends Error {
  constructor(wrong) { super(wrong ? 'wrong password' : 'password needed'); this.name = 'PdfPasswordError'; this.wrong = !!wrong; }
}

let lib = null;
async function pdfjs() {
  if (!lib) {
    // tests under Node bring pdf.js's build for Node (globalThis.FINPAL_PDFJS = {api, core})
    const given = globalThis.FINPAL_PDFJS;
    const [api, core] = given ? [given.api, given.core]
      : await Promise.all([import('./vendor/pdfjs/pdf.min.mjs'), import('./vendor/pdfjs/pdf.worker.min.mjs')]);
    globalThis.pdfjsWorker = core; // pdf.js runs right here (already off the screen thread), no second worker
    lib = api;
  }
  return lib;
}

export function isPdf(data) {
  const head = data.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true; // %PDF-
  }
  return false;
}

/** the tables of a PDF statement: [{name, rows, width}] like the spreadsheet readers give.
    fields: for each kind of column, the names it goes by; norm: the readers' normalizer for comparing them. */
export async function pdfTables(data, { password, fields, norm } = {}) {
  const P = await pdfjs();
  const task = P.getDocument({
    data: data.slice(), password: password || undefined, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, enableXfa: false, stopAtErrors: false, verbosity: 0,
    disableAutoFetch: true, disableStream: true, disableRange: true, isOffscreenCanvasSupported: false
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    try { await task.destroy(); } catch (x) { /* ignore */ }
    if (e && e.name === 'PasswordException') throw new PdfPasswordError(e.code === 2);
    throw e;
  }
  try {
    const lines = [];
    let runs = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const ls = pageLines(P, page.getViewport({ scale: 1 }), content.items, n);
      for (const l of ls) { lines.push(l); runs += l.runs.length; }
      page.cleanup();
      if (runs > MAX_RUNS) break;
    }
    return { tables: buildTables(lines, fields || [], norm || (s => s)), text: runs > 0 };
  } finally {
    try { await task.destroy(); } catch (x) { /* ignore */ }
  }
}

// ------------------------------------------------------------------ lines
function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }

function pageLines(P, viewport, items, page) {
  const runs = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const t = P.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(t[2], t[3]) || it.height || 10;
    const w = Math.max(Math.abs(it.width) * viewport.scale, 0.1);
    runs.push({ s: it.str, x0: t[4], x1: t[4] + w, y: t[5], size });
  }
  runs.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.y - last.y) <= Math.max(1.5, 0.45 * Math.min(r.size, last.size))) last.runs.push(r);
    else lines.push({ y: r.y, size: r.size, page, runs: [r] });
  }
  for (const l of lines) {
    l.runs.sort((a, b) => a.x0 - b.x0);
    l.size = median(l.runs.map(r => r.size)) || 10;
    l.text = cellText(l.runs, l.size);
    l.date = l.runs.some(r => DATE.test(r.s));
  }
  return lines;
}

// ------------------------------------------------------------------ text of one cell, in reading order
function cellText(runs, size) {
  if (!runs.length) return '';
  const vis = runs.slice().sort((a, b) => a.x0 - b.x0);
  const words = [];
  for (const r of vis) {
    const last = words[words.length - 1];
    if (last && r.x0 - last.x1 < 0.12 * (r.size || size)) { last.parts.push(r); last.x1 = Math.max(last.x1, r.x1); }
    else words.push({ parts: [r], x1: r.x1 });
  }
  for (const w of words) {
    w.heb = w.parts.some(p => HEB.test(p.s));
    // pieces of a Hebrew word placed one after another are read right to left; Latin and numbers left to right
    const parts = w.heb ? w.parts.slice().reverse() : w.parts;
    w.text = parts.map(p => p.s).join('').replace(/\s+/g, ' ').trim();
  }
  if (!words.some(w => w.heb)) return words.map(w => w.text).join(' ').trim();
  const out = [];
  for (let i = words.length - 1; i >= 0;) {
    if (words[i].heb || !LTR.test(words[i].text)) { out.push(words[i].text); i--; continue; }
    let j = i;
    while (j - 1 >= 0 && !words[j - 1].heb && LTR.test(words[j - 1].text)) j--;
    out.push(words.slice(j, i + 1).map(w => w.text).join(' '));
    i = j - 1;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ tables
/** how many kinds of column a text names ("תאריך" and "תאריך חיוב" in one place still count as one or two
    kinds, so a sentence that mentions a date is not a header: a header names three kinds or more) */
function hits(text, fields, norm) {
  const t = norm(text);
  let n = 0;
  for (const syns of fields) if (syns.some(w => t.includes(w))) n++;
  return n;
}
const lineHits = (line, fields, norm) => (line.date ? 0 : hits(line.text, fields, norm));

/** columns: the x ranges with text in (almost) every row; the gaps between them separate the columns */
function columnsOf(rows, size) {
  let lo = Infinity, hi = -Infinity;
  for (const l of rows) for (const r of l.runs) { lo = Math.min(lo, r.x0); hi = Math.max(hi, r.x1); }
  if (!isFinite(lo)) return [];
  const W = Math.ceil(hi - lo) + 2;
  const cover = new Uint16Array(W);
  for (const l of rows) {
    const seen = new Uint8Array(W);
    for (const r of l.runs) for (let x = Math.max(0, Math.floor(r.x0 - lo)); x < Math.min(W, Math.ceil(r.x1 - lo)); x++) seen[x] = 1;
    for (let i = 0; i < W; i++) cover[i] += seen[i];
  }
  const allow = Math.floor(rows.length * 0.04);
  const minGap = Math.max(2, 0.5 * size);
  const segs = [];
  let start = -1;
  for (let i = 0; i <= W; i++) {
    const on = i < W && cover[i] > allow;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { segs.push([start + lo, i + lo]); start = -1; }
  }
  // a gap narrower than a few letters is a space between words of one cell, not a new column
  const cols = [];
  for (const s of segs) {
    const last = cols[cols.length - 1];
    if (last && s[0] - last[1] < minGap) last[1] = s[1];
    else cols.push([s[0], s[1]]);
  }
  return cols;
}

function overlapOf(cols, r) {
  let best = -1, bestOverlap = 0;
  cols.forEach(([a, b], i) => {
    const o = Math.min(b, r.x1) - Math.max(a, r.x0);
    if (o > bestOverlap) { bestOverlap = o; best = i; }
  });
  return best;
}

function columnOf(cols, r) {
  let best = overlapOf(cols, r);
  if (best >= 0) return best;
  const c = (r.x0 + r.x1) / 2;
  let dist = Infinity;
  cols.forEach(([a, b], i) => { const d = c < a ? a - c : c > b ? c - b : 0; if (d < dist) { dist = d; best = i; } });
  return best;
}

/** words close together are one phrase ("היתרה בש"ח"): a phrase goes to one column as a whole */
function phrases(runs, size) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r.x0 - last.x1 < Math.max(2, 0.5 * (r.size || size))) { last.runs.push(r); last.x1 = Math.max(last.x1, r.x1); }
    else out.push({ runs: [r], x0: r.x0, x1: r.x1 });
  }
  return out;
}

/** one line as a row of cells, right to left (the order of the columns in a Hebrew sheet). In a row with a
    date every piece finds its own column; in a header or a line of text, whole phrases do. */
function rowOf(cols, line) {
  const byCol = cols.map(() => []);
  const units = line.date ? line.runs.map(r => ({ runs: [r], x0: r.x0, x1: r.x1 })) : phrases(line.runs, line.size);
  for (const u of units) { const i = columnOf(cols, u); if (i >= 0) byCol[i].push(...u.runs); }
  return byCol.map(rs => cellText(rs, line.size)).reverse();
}

/** the header over the columns. A heading that is over its column's text belongs to it. In a Hebrew table a
    heading is set to the right of its cell, so one beside the text (numbers are set to the left) belongs to
    the column on its left; a heading on a second line goes with the one above it; a heading with no column
    of its own (a column that is empty in every row) gets a new, empty column. */
function placeHeader(cols, header) {
  const ph = [];
  for (const l of header) for (const p of phrases(l.runs, l.size)) ph.push(Object.assign(p, { line: l }));
  const rtl = HEB.test(header.map(l => l.text).join(' '));
  const at = new Map();
  const owned = new Set();
  for (const p of ph) { const i = overlapOf(cols, p); if (i >= 0) { at.set(p, i); owned.add(i); } }
  const stack = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of ph) {
        if (at.has(p)) continue;
        for (const q of ph) {
          if (!at.has(q) || q.line === p.line || typeof at.get(q) !== 'number') continue;
          const o = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
          if (o > 0.3 * Math.min(p.x1 - p.x0, q.x1 - q.x0)) { at.set(p, at.get(q)); changed = true; break; }
        }
      }
    }
  };
  stack();
  for (const p of ph) {
    if (at.has(p)) continue;
    let i = -1;
    if (rtl) { cols.forEach((c, k) => { if (c[1] <= p.x0) i = k; }); }
    else { for (let k = cols.length - 1; k >= 0; k--) if (cols[k][0] >= p.x1) i = k; }
    if (i >= 0 && !owned.has(i)) { at.set(p, i); owned.add(i); }
  }
  stack();
  // headings left without a column: new, empty columns where they stand
  const extra = ph.filter(p => !at.has(p));
  const all = cols.map((c, k) => ({ x0: c[0], x1: c[1], k, texts: [] }));
  const fresh = [];
  for (const p of extra) {
    const near = fresh.find(f => Math.min(f.x1, p.x1) - Math.max(f.x0, p.x0) > 0);
    if (near) { near.parts.push(p); near.x0 = Math.min(near.x0, p.x0); near.x1 = Math.max(near.x1, p.x1); }
    else fresh.push({ x0: p.x0, x1: p.x1, parts: [p] });
  }
  for (const f of fresh) all.push({ x0: f.x0, x1: f.x1, k: -1, texts: [], parts: f.parts });
  all.sort((a, b) => a.x0 - b.x0);
  const newCols = all.map(c => [c.x0, c.x1]);
  const head = all.map(c => {
    const parts = c.k >= 0 ? ph.filter(p => at.get(p) === c.k) : c.parts;
    const byLine = header.map(l => parts.filter(p => p.line === l).flatMap(p => p.runs)).filter(rs => rs.length);
    return byLine.map(rs => cellText(rs, rs[0].size)).join(' ');
  });
  return { cols: newCols, head: head.reverse() };
}

function buildTables(lines, fieldsIn, norm) {
  const fields = fieldsIn.map(syns => [...new Set(syns.map(w => norm(w)).filter(w => w && w.length >= 3))]).filter(f => f.length);
  const near = (a, b) => a.page === b.page && Math.abs(b.y - a.y) <= 1.9 * Math.max(a.size, b.size);
  /** the header block that starts at line i: the line and up to two header lines right below it */
  const headerAt = i => {
    if (lineHits(lines[i], fields, norm) < 2) return null;
    let e = i;
    while (e + 1 < lines.length && e < i + 2 && !lines[e + 1].date && near(lines[e], lines[e + 1]) && lineHits(lines[e + 1], fields, norm) >= 1) e++;
    let s0 = i;
    while (s0 - 1 >= 0 && s0 > i - 2 && !lines[s0 - 1].date && near(lines[s0 - 1], lines[s0]) && lineHits(lines[s0 - 1], fields, norm) >= 1) s0--;
    const text = lines.slice(s0, e + 1).map(l => l.text).join(' ');
    if (hits(text, fields, norm) < 3) return null;
    return { s0, e, key: norm(text) };
  };
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const hb = headerAt(i);
    if (!hb) { i++; continue; }
    const h0 = hb.s0, h1 = hb.e, key = hb.key;
    const header = lines.slice(h0, h1 + 1);
    // the table's name: the title right above the header ("עסקאות שאושרו וטרם נקלטו")
    let name = '';
    if (h0 - 1 >= 0) {
      const l = lines[h0 - 1];
      if (l.page === header[0].page && !l.date && header[0].y - l.y <= 6 * header[0].size) name = l.text;
    }
    // the body: until another (different) header; the same header on the next page goes on
    const idx = [];
    let j = h1 + 1;
    for (; j < lines.length; j++) {
      const hb2 = headerAt(j);
      if (hb2) {
        // a header on two lines: its first line is not part of this table
        while (idx.length && idx[idx.length - 1] >= hb2.s0) idx.pop();
        if (hb2.key === key) { j = hb2.e; continue; }
        j = hb2.s0;
        break;
      }
      idx.push(j);
    }
    i = Math.max(j, i + 1);
    const body = idx.map(k => lines[k]);
    const dataLines = body.filter(l => l.date);
    if (!dataLines.length) continue;
    const size = median(dataLines.map(l => l.size)) || 10;
    const found = columnsOf(dataLines, size);
    if (found.length < 2) continue;
    const { cols, head } = placeHeader(found, header);
    const rows = [head];
    let prev = null, prevLine = null;
    for (const l of body) {
      const cells = rowOf(cols, l);
      if (l.date) { rows.push(cells); prev = cells; prevLine = l; continue; }
      // a description on two lines: text only, right under a row, in the row's text columns
      const filled = cells.map((t, c) => [t, c]).filter(([t]) => t);
      const continues = prev && prevLine.page === l.page && l.y > prevLine.y && l.y - prevLine.y <= 1.75 * Math.max(l.size, prevLine.size)
        && filled.length && filled.every(([t, c]) => !NUMERIC.test(t) && prev[c] && !NUMERIC.test(prev[c]));
      // a word broken at a hyphen ("12-" / "345") is joined back without a space
      if (continues) { for (const [t, c] of filled) prev[c] = /\S-$/.test(prev[c]) ? prev[c] + t : `${prev[c]} ${t}`; prevLine = l; continue; }
      rows.push(cells);
      prev = null;
    }
    tables.push({ name: name || `עמוד ${header[0].page}`, rows, width: cols.length });
  }
  return tables;
}

/** for tests: the raw lines of a PDF, in reading order */
export async function pdfLines(data, password) {
  const P = await pdfjs();
  const task = P.getDocument({ data: data.slice(), password, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    for (const l of pageLines(P, page.getViewport({ scale: 1 }), content.items, n)) out.push(cellText(l.runs, l.size));
  }
  await task.destroy();
  return out;
}
