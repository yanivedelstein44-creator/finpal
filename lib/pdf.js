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

// ------------------------------------------------------------------ columns
const RES = 4; // coverage is measured in quarters of a point: some statements leave under 2pt between columns

/** where the rows have text: for every x, in how many rows */
function coverageOf(rows) {
  let lo = Infinity, hi = -Infinity;
  for (const l of rows) for (const r of l.runs) { lo = Math.min(lo, r.x0); hi = Math.max(hi, r.x1); }
  if (!isFinite(lo)) return null;
  const W = Math.ceil((hi - lo) * RES) + 2;
  const cover = new Uint16Array(W);
  const seen = new Uint8Array(W);
  for (const l of rows) {
    seen.fill(0);
    for (const r of l.runs) for (let x = Math.max(0, Math.floor((r.x0 - lo) * RES)); x < Math.min(W, Math.ceil((r.x1 - lo) * RES)); x++) seen[x] = 1;
    for (let i = 0; i < W; i++) cover[i] += seen[i];
  }
  return { lo, W, cover, allow: Math.floor(rows.length * 0.04) };
}

/** columns: the x ranges with text in (almost) every row; the gaps between them separate the columns */
function columnsOf(cov, size) {
  const { lo, W, cover, allow } = cov;
  const minGap = Math.max(2, 0.5 * size);
  const segs = [];
  let start = -1;
  for (let i = 0; i <= W; i++) {
    const on = i < W && cover[i] > allow;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { segs.push([lo + start / RES, lo + i / RES]); start = -1; }
  }
  // a gap narrower than a few letters is a space between words of one cell, not a new column
  const cols = [];
  for (const sg of segs) {
    const last = cols[cols.length - 1];
    if (last && sg[0] - last[1] < minGap) last[1] = sg[1];
    else cols.push([sg[0], sg[1]]);
  }
  return cols;
}

/** the header in cells: phrases of the header lines, a heading on two lines being one cell */
function headerCells(header) {
  const cells = [];
  for (const l of header) for (const p of phrases(l.runs, l.size)) {
    const c = cells.find(q => q.line !== l && Math.min(q.x1, p.x1) - Math.max(q.x0, p.x0) > 0.3 * Math.min(q.x1 - q.x0, p.x1 - p.x0));
    if (c) { c.x0 = Math.min(c.x0, p.x0); c.x1 = Math.max(c.x1, p.x1); } else cells.push({ x0: p.x0, x1: p.x1, line: l });
  }
  return cells.sort((a, b) => a.x0 - b.x0);
}

/** two columns set close together (under 2pt apart in some statements) look like one; when the header
    names two columns over it, it is cut at the emptiest strip between the two headings */
function splitByHeader(cols, cov, cells) {
  const { lo, W, cover, allow } = cov;
  const out = [];
  for (const [a, b] of cols) {
    const over = cells.filter(c => Math.min(b, c.x1) - Math.max(a, c.x0) > 0);
    let from = a;
    for (let k = 0; k + 1 < over.length; k++) {
      const L = over[k], R = over[k + 1];
      const w0 = Math.max(Math.floor((Math.max(from, L.x1 - 3) - lo) * RES), 0);
      const w1 = Math.min(Math.ceil((Math.min(b, R.x0 + 3) - lo) * RES), W - 1);
      let best = null;
      for (let i = w0; i <= w1;) {
        if (cover[i] > allow) { i++; continue; }
        let j = i;
        while (j + 1 <= w1 && cover[j + 1] <= allow) j++;
        if (!best || j - i > best[1] - best[0]) best = [i, j];
        i = j + 1;
      }
      if (!best) continue;
      const cutL = lo + best[0] / RES, cutR = lo + (best[1] + 1) / RES;
      if (cutL > from) out.push([from, cutL]);
      from = cutR;
    }
    if (b > from) out.push([from, b]);
  }
  return out;
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

/** a line's text, column by column (in the order of cols, left to right). In a row with a date every
    piece finds its own column; in a header or a line of text, whole phrases do. */
function cellsOf(cols, line, asRow = line.date) {
  const byCol = cols.map(() => []);
  const units = asRow ? line.runs.map(r => ({ runs: [r], x0: r.x0, x1: r.x1 })) : phrases(line.runs, line.size);
  for (const u of units) { const i = columnOf(cols, u); if (i >= 0) byCol[i].push(...u.runs); }
  return byCol.map(rs => cellText(rs, line.size));
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
          if (!at.has(q) || q.line === p.line) continue;
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
  const all = cols.map((c, k) => ({ x0: c[0], x1: c[1], k, parts: ph.filter(p => at.get(p) === k) }));
  const fresh = [];
  for (const p of ph.filter(q => !at.has(q))) {
    const near = fresh.find(f => Math.min(f.x1, p.x1) - Math.max(f.x0, p.x0) > 0);
    if (near) { near.parts.push(p); near.x0 = Math.min(near.x0, p.x0); near.x1 = Math.max(near.x1, p.x1); }
    else fresh.push({ x0: p.x0, x1: p.x1, k: -1, parts: [p] });
  }
  all.push(...fresh);
  all.sort((a, b) => a.x0 - b.x0);
  return all.map(c => {
    const byLine = header.map(l => c.parts.filter(p => p.line === l).flatMap(p => p.runs)).filter(rs => rs.length);
    return { x0: c.x0, x1: c.x1, head: byLine.map(rs => cellText(rs, rs[0].size)).join(' ') };
  });
}

/** a column with no heading and text in it is the rest of its neighbour's text: a merchant's name and its
    city in a fixed-width field ("NETFLIX.COM ... Amsterd") are one cell */
function joinHeadless(cols, dataLines) {
  const texty = cols.map(() => [0, 0]);
  for (const l of dataLines) cellsOf(cols.map(c => [c.x0, c.x1]), l).forEach((t, i) => { if (t) { texty[i][1]++; if (!NUMERIC.test(t) && /[A-Za-z֐-׿]/.test(t)) texty[i][0]++; } });
  const isText = i => texty[i][1] > 0 && texty[i][0] >= 0.7 * texty[i][1];
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].head || !isText(i)) continue;
    const cand = [i - 1, i + 1].filter(k => k >= 0 && k < cols.length && cols[k].head && isText(k));
    if (!cand.length) continue;
    const k = cand.sort((p, q) => Math.abs(cols[p].x0 - cols[i].x0) - Math.abs(cols[q].x0 - cols[i].x0))[0];
    cols[k] = { x0: Math.min(cols[k].x0, cols[i].x0), x1: Math.max(cols[k].x1, cols[i].x1), head: cols[k].head };
    cols.splice(i, 1);
    texty.splice(i, 1);
    i = -1; // start over: the columns moved
  }
  return cols;
}

// ------------------------------------------------------------------ tables
const TOTAL = /^\(?\s*(סה["״']?כ|סך הכל|סה"כ)/;
const NOTE = /^[^\d:]{1,14}:/; // "הערה: ...", "הועבר ל: ..." are notes, not the rest of a description
const CARD = /(?:מסתיים|המסתיים|שמסתיים)\s*ב-?\s*(\d{4})\b/;
const DATE_G = /(?:^|[^\d])(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}))(?![\d])/g;
const lastDate = text => { let m, d = null; DATE_G.lastIndex = 0; while ((m = DATE_G.exec(text))) d = m[1]; return d; };

/** how many kinds of column a text names ("תאריך" and "תאריך חיוב" in one place still count as one or two
    kinds, so a sentence that mentions a date is not a header: a header names three kinds or more) */
function hits(text, fields, norm) {
  const t = norm(text);
  let n = 0;
  for (const syns of fields) if (syns.some(w => t.includes(w))) n++;
  return n;
}
// a total ("סה"כ חיוב ... בתאריך 11/10/26") or a note ("הערה: חיוב עסקת חו"ל בש"ח") names columns too, but is no header
const plain = line => !line.date && !TOTAL.test(line.text) && !NOTE.test(line.text);
const lineHits = (line, fields, norm) => (plain(line) ? hits(line.text, fields, norm) : 0);
// the second line of a heading ("העסקה", "החיוב"): words only, no date and no amount
const headerLike = l => plain(l) && !/\d[\d,]*\.\d\d/.test(l.text) && l.text.length <= 140 && /[֐-׿A-Za-z]/.test(l.text);

/** the rows of a table have their date in one column (or two: "תאריך" and "תאריך ערך"); a line with a date
    somewhere else, like a sentence under the table or a table of rates, is not a row of it. The date column
    is the one under a date heading; with no such heading, where (nearly) all the dates are. */
function rowsOf(dateLines, header) {
  const pieces = dateLines.map(l => l.runs.filter(r => DATE.test(r.s)));
  const heads = [];
  for (const l of header) for (const p of phrases(l.runs, l.size)) if (/תאריך|date/i.test(cellText(p.runs, l.size))) heads.push([p.x0 - 4, p.x1 + 4]);
  const under = r => heads.some(([a, b]) => Math.min(b, r.x1) - Math.max(a, r.x0) > 0);
  const byHeading = dateLines.filter((l, k) => pieces[k].some(under));
  if (byHeading.length) return byHeading;
  let lo = Infinity, hi = -Infinity;
  for (const ps of pieces) for (const r of ps) { lo = Math.min(lo, r.x0); hi = Math.max(hi, r.x1); }
  if (!isFinite(lo) || dateLines.length < 3) return dateLines;
  const W = Math.ceil(hi - lo) + 2;
  const cover = new Uint16Array(W), seen = new Uint8Array(W);
  const span = r => [Math.max(0, Math.floor(r.x0 - lo)), Math.min(W, Math.ceil(r.x1 - lo))];
  for (const ps of pieces) {
    seen.fill(0);
    for (const r of ps) { const [a, b] = span(r); for (let x = a; x < b; x++) seen[x] = 1; }
    for (let x = 0; x < W; x++) cover[x] += seen[x];
  }
  let max = 0;
  for (let x = 0; x < W; x++) max = Math.max(max, cover[x]);
  const need = Math.max(2, Math.ceil(0.8 * max));
  return dateLines.filter((l, k) => pieces[k].some(r => { const [a, b] = span(r); for (let x = a; x < b; x++) if (cover[x] >= need) return true; return false; }));
}

function buildTables(lines, fieldsIn, norm) {
  const fields = fieldsIn.map(syns => [...new Set(syns.map(w => norm(w)).filter(w => w && w.length >= 3))]).filter(f => f.length);
  const near = (a, b) => a.page === b.page && Math.abs(b.y - a.y) <= 1.9 * Math.max(a.size, b.size);
  for (const l of lines) { l.total = TOTAL.test(l.text); if (l.total) l.date = false; l.dateText = lastDate(l.text); }
  /** the header block at line i: the line, the header lines right above it, and up to two lines of words
      right below it (a heading on two lines) */
  const headerAt = i => {
    if (lineHits(lines[i], fields, norm) < 2) return null;
    let e = i;
    while (e + 1 < lines.length && e < i + 2 && near(lines[e], lines[e + 1]) && (lineHits(lines[e + 1], fields, norm) >= 1 || headerLike(lines[e + 1]))) e++;
    let s0 = i;
    while (s0 - 1 >= 0 && s0 > i - 2 && !lines[s0 - 1].date && near(lines[s0 - 1], lines[s0]) && lineHits(lines[s0 - 1], fields, norm) >= 1) s0--;
    const text = lines.slice(s0, e + 1).map(l => l.text).join(' ');
    if (hits(text, fields, norm) < 3) return null;
    return { s0, e, key: norm(lines.slice(s0, i + 1).map(l => l.text).join(' ')) };
  };
  // what a card statement says once, above its tables: the card ("לכרטיס שמסתיים ב-8843") and the date of
  // the statement ("פירוט החיובים בחשבון לתאריך 10/10/26")
  let card = '', statementDate = '';
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const l0 = lines[i];
    if (!l0.date || l0.total) {
      const m = CARD.exec(l0.text);
      if (m) card = m[1];
    }
    if (!statementDate && /לתאריך/.test(l0.text) && l0.dateText) statementDate = l0.dateText;
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
      // "לכרטיס שמסתיים ב-1234": the next card's part of the statement
      if (idx.length && plain(lines[j]) && CARD.test(lines[j].text)) break;
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
    const dataLines = rowsOf(body.filter(l => l.date), header);
    if (!dataLines.length) continue;
    const isRow = new Set(dataLines);
    const size = median(dataLines.map(l => l.size)) || 10;
    const cov = coverageOf(dataLines);
    if (!cov) continue;
    const found = splitByHeader(columnsOf(cov, size), cov, headerCells(header));
    if (found.length < 2) continue;
    const cols = joinHeadless(placeHeader(found, header), dataLines);
    const ranges = cols.map(c => [c.x0, c.x1]);
    const head = cols.map(c => c.head).reverse();
    // a card statement: the card and the charge date of every row, as the spreadsheet export has them
    const cardTable = card && head.some(h => /בית\s*ה?עסק/.test(h));
    const addCard = cardTable && !head.some(h => /ספרות|כרטיס/.test(h));
    const addCharge = cardTable && !head.some(h => /(תאריך|מועד)\s*ה?חיוב/.test(h));
    const notesAt = head.findIndex(h => /^(הערות|הערה)/.test(h));
    if (addCard) head.push('4 ספרות אחרונות של כרטיס האשראי');
    if (addCharge) head.push('תאריך חיוב');
    const rows = [head];
    const pending = []; // rows waiting for the total line that tells their charge date
    let prev = null, prevLine = null;
    const finish = date => { for (const r of pending) r[r.length - 1] = date || statementDate; pending.length = 0; };
    for (const l of body) {
      if (l.total) { if (addCharge) finish(l.dateText); prev = null; continue; } // a total is never a transaction
      const row = isRow.has(l);
      const cells = cellsOf(ranges, l, row).reverse();
      if (addCard) cells.push(row ? card : '');
      if (addCharge) cells.push('');
      if (row) {
        rows.push(cells);
        if (addCharge) pending.push(cells);
        prev = cells; prevLine = l;
        continue;
      }
      // a note under a row ("הועבר ל: ...") goes with the row's notes
      if (prev && notesAt >= 0 && NOTE.test(l.text) && prevLine.page === l.page && l.y > prevLine.y && l.y - prevLine.y <= 2.5 * Math.max(l.size, prevLine.size)) {
        prev[notesAt] = prev[notesAt] ? `${prev[notesAt]} · ${l.text}` : l.text;
        continue;
      }
      // a description on two lines: text only, right under a row, in the row's text columns
      const filled = cells.map((t, c) => [t, c]).filter(([t]) => t);
      const continues = prev && !NOTE.test(l.text) && prevLine.page === l.page && l.y > prevLine.y && l.y - prevLine.y <= 1.75 * Math.max(l.size, prevLine.size)
        && filled.length && filled.every(([t, c]) => !NUMERIC.test(t) && prev[c] && !NUMERIC.test(prev[c]));
      // a word broken at a hyphen ("12-" / "345") is joined back without a space
      if (continues) { for (const [t, c] of filled) prev[c] = /\S-$/.test(prev[c]) ? prev[c] + t : `${prev[c]} ${t}`; prevLine = l; continue; }
      rows.push(cells);
      prev = null;
    }
    if (addCharge) finish('');
    tables.push({ name: name || `עמוד ${header[0].page}`, rows, width: head.length });
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
