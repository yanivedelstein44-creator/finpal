/*
 * FinPal Family — readers for Bank Leumi (עו"ש) and MAX credit-card export files.
 *
 * A faithful JavaScript port of the desktop app's Python implementation
 * (YourAIFinPal/finpal/file_manager: readers.py, columns.py, normalize.py, leumi.py,
 * max_card.py, models.assign_uids, importer.parse_file), including the observable
 * behaviour of the Python libraries it relies on — xlrd 2.0 (.xls), openpyxl 3.1 (.xlsx),
 * html.parser, csv.Sniffer + csv.reader, xml.etree, str methods, float formatting — so the
 * transactions, and in particular `uid` / `soft_key`, are identical to the desktop app.
 *
 * Runs unchanged in the browser (Chrome on Android) and in Node 22.
 * No DOM (no DOMParser) and no Node APIs: only TextDecoder/TextEncoder, crypto.subtle
 * (optional, pure-JS fallback included) and the vendored fflate (inflate only).
 *
 * Public API:
 *   parseFile(name, bytes: Uint8Array) -> Promise<{ name, kind, txns, warnings, error, sha256 }>
 * It never throws: malformed input is reported through `error` (or kind === null).
 */
import { Inflate, strFromU8 } from './vendor/fflate.js';

// ═══════════════════════════════ limits (readers.py) ═══════════════════════════════
const MAX_ROWS = 50_000;
const MAX_COLS = 256;                          // per row, and for colspan / ss:Index / MergeAcross
const MAX_FILE_BYTES = 50 * 1024 * 1024;       // the file itself
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;  // declared xlsx content (zip bomb)

/** readers.UnsupportedFile — its message is reported as-is. */
class UnsupportedFile extends Error {}
/** Any other read failure (Python: an exception inside read_tables). */
class ReadError extends Error {}
const fail = (msg) => { throw new ReadError(msg); };

// ═══════════════════════════ Python compatibility layer ════════════════════════════
// The predicates below were checked against CPython 3.13 for every Unicode 15.1 code point.

/** str.isspace() and re's \s (identical sets in CPython). */
function isPyWs(c) {
  return (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000;
}
const WS_CLASS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const RE_WS_RUN = new RegExp(`[${WS_CLASS}]+`, 'g');                 // re.compile(r"\s+")
const RE_NOT_ALPHA_SPACE = new RegExp(`[^\\p{L}${WS_CLASS}]`, 'gu'); // not isalpha()/isspace()

/** str.strip() */
function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isPyWs(s.charCodeAt(a))) a++;
  while (b > a && isPyWs(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** len(s) in code points. */
function cpLen(s) {
  let n = s.length;
  for (let i = 0; i + 1 < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n--; i++; }
  }
  return n;
}

/** s[:n] in code points. */
function cpPrefix(s, n) {
  if (s.length <= n) return s;
  let i = 0;
  for (let k = 0; k < n && i < s.length; k++) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return s.slice(0, i);
}

// Unicode decimal digits (\d, int(), float()): every Nd block is a run of 0..9.
const RE_ND_ONE = /^\p{Nd}$/u;
const digitCache = new Map();
function digitValue(cp) {
  if (cp >= 48 && cp <= 57) return cp - 48;
  let v = digitCache.get(cp);
  if (v === undefined) {
    let s = cp;
    while (s > 0 && RE_ND_ONE.test(String.fromCodePoint(s - 1))) s--;
    v = (cp - s) % 10;
    digitCache.set(cp, v);
  }
  return v;
}
/** Map every Unicode decimal digit to ASCII (what int()/float() do internally). */
function asciiDigits(s) {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(s)) return s;
  return s.replace(/\p{Nd}/gu, (ch) => String(digitValue(ch.codePointAt(0))));
}
/** int() of a string that the caller already matched as \d+ . */
const pyIntDigits = (s) => Number(asciiDigits(s));

// str.isdigit() = Nd plus these Numeric_Type=Digit characters (superscripts, circled …).
const ISDIGIT_EXTRA = [[0xb2, 0xb3], [0xb9, 0xb9], [0x1369, 0x1371], [0x19da, 0x19da],
  [0x2070, 0x2070], [0x2074, 0x2079], [0x2080, 0x2089], [0x2460, 0x2468], [0x2474, 0x247c],
  [0x2488, 0x2490], [0x24ea, 0x24ea], [0x24f5, 0x24fd], [0x24ff, 0x24ff], [0x2776, 0x277e],
  [0x2780, 0x2788], [0x278a, 0x2792], [0x10a40, 0x10a43], [0x10e60, 0x10e68],
  [0x11052, 0x1105a], [0x1f100, 0x1f10a]];
const isDigitExtra = (cp) => ISDIGIT_EXTRA.some(([a, b]) => cp >= a && cp <= b);
const isPyDigitCp = (ch) => RE_ND_ONE.test(ch) || isDigitExtra(ch.codePointAt(0));
/** str.isdigit() */
function pyIsDigit(s) {
  if (!s) return false;
  for (const ch of s) if (!isPyDigitCp(ch)) return false;
  return true;
}
/** int(s) for a string that passed isdigit(): ValueError for non-decimal digits ("²"). */
function pyIntOfDigit(s) {
  for (const ch of s) if (!RE_ND_ONE.test(ch)) fail(`invalid literal for int() with base 10: '${s}'`);
  return pyIntDigits(s);
}

/** float(str) — returns null where Python raises ValueError. */
const RE_PYFLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const RE_PYFLOAT_SPECIAL = /^([+-]?)(?:(inf|infinity)|nan)$/i;
function pyFloat(text) {
  const s = asciiDigits(pyStrip(String(text)));
  if (RE_PYFLOAT.test(s)) return Number(s.replace(/_/g, ''));
  const m = RE_PYFLOAT_SPECIAL.exec(s);
  if (m) return m[2] ? (m[1] === '-' ? -Infinity : Infinity) : NaN;
  return null;
}
/** int(str) — throws like Python's ValueError. Number when exact, else BigInt. */
const RE_PYINT = /^[+-]?\d(?:_?\d)*$/;
function pyInt(text) {
  const s = asciiDigits(pyStrip(String(text)));
  if (!RE_PYINT.test(s)) fail(`invalid literal for int() with base 10: '${text}'`);
  const t = s.replace(/_/g, '');
  const n = Number(t);
  if (Number.isSafeInteger(n)) return n === 0 ? 0 : n;   // ints have no -0
  return BigInt(t);
}

/** round(x) — round half to even, to an integer. */
function pyRoundInt(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** repr(float) */
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, e] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = Number(e);
  const decpt = exp + 1;
  let out;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) out = `0.${'0'.repeat(-decpt)}${digits}`;
    else if (decpt >= digits.length) out = `${digits}${'0'.repeat(decpt - digits.length)}.0`;
    else out = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  } else {
    out = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return x < 0 ? `-${out}` : out;
}

/** f"{x:.2f}" — exact decimal expansion, ties to even (toFixed breaks ties away from zero). */
function pyFormat2(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.00' : '0.00';
  const ax = Math.abs(x);
  const sign = x < 0 ? '-' : '';
  if (ax >= 1e21) return `${sign}${BigInt(ax)}.00`;
  const e8 = ax * 8;                 // x*100 == k + 0.5 exactly  <=>  8x is an odd integer
  if (Number.isInteger(e8) && e8 % 2 === 1) {
    let n = (25n * BigInt(e8) - 1n) / 2n;   // floor(100 * |x|)
    if (n % 2n === 1n) n += 1n;
    const s = n.toString().padStart(3, '0');
    return `${sign}${s.slice(0, -2)}.${s.slice(-2)}`;
  }
  return x.toFixed(2);
}
/** round(x, 2) */
const pyRound2 = (x) => (Number.isFinite(x) ? Number(pyFormat2(x)) : x);

/** str(int) */
const intStr = (v) => (Math.abs(v) < 1e21 ? String(v) : BigInt(v).toString());

// ── datetime ─────────────────────────────────────────────────────────────────────────
const DIM = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DBM = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y, m) => (m === 2 && isLeap(y) ? 29 : DIM[m]);
const MAX_ORD = 3652059;  // date(9999, 12, 31).toordinal()
function ymd2ord(y, m, d) {
  const y1 = y - 1;
  return y1 * 365 + Math.floor(y1 / 4) - Math.floor(y1 / 100) + Math.floor(y1 / 400) +
    DBM[m] + (m > 2 && isLeap(y) ? 1 : 0) + d;
}
function ord2ymd(n) {
  n -= 1;
  const n400 = Math.floor(n / 146097); n -= n400 * 146097;
  let year = n400 * 400 + 1;
  const n100 = Math.floor(n / 36524); n -= n100 * 36524;
  const n4 = Math.floor(n / 1461); n -= n4 * 1461;
  const n1 = Math.floor(n / 365); n -= n1 * 365;
  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (n + 50) >> 5;
  let preceding = DBM[month] + (month > 2 && leap ? 1 : 0);
  if (preceding > n) {
    month -= 1;
    preceding -= DIM[month] + (month === 2 && leap ? 1 : 0);
  }
  return [year, month, n - preceding + 1];
}
const pad = (n, w) => String(n).padStart(w, '0');
const validYmd = (y, m, d) => y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
function fmtTime(h, mi, s, us) {
  return `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}${us ? `.${pad(us, 6)}` : ''}`;
}
/** utcoffset in microseconds -> "+HH:MM[:SS[.ffffff]]" (datetime._format_offset) */
function fmtOffset(off) {
  if (off === null) return '';
  const sign = off < 0 ? '-' : '+';
  let a = Math.abs(off);
  const us = a % 1e6; a = (a - us) / 1e6;
  const ss = a % 60; a = (a - ss) / 60;
  const mm = a % 60;
  const hh = (a - mm) / 60;
  let out = `${sign}${pad(hh, 2)}:${pad(mm, 2)}`;
  if (ss || us) out += `:${pad(ss, 2)}${us ? `.${pad(us, 6)}` : ''}`;
  return out;
}
class PyDate {
  constructor(y, m, d) { this.year = y; this.month = m; this.day = d; }
  static fromOrdinal(n) { const [y, m, d] = ord2ymd(n); return new PyDate(y, m, d); }
  isoformat() { return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`; }
  toString() { return this.isoformat(); }
}
class PyDateTime {
  constructor(y, mo, d, h = 0, mi = 0, s = 0, us = 0, tz = null) {
    Object.assign(this, { year: y, month: mo, day: d, hour: h, minute: mi, second: s, us, tz });
  }
  /** datetime from an ordinal day plus microseconds into that day. */
  static fromOrdinal(ord, usOfDay) {
    const [y, m, d] = ord2ymd(ord);
    const us = usOfDay % 1e6;
    let t = (usOfDay - us) / 1e6;
    const s = t % 60; t = (t - s) / 60;
    const mi = t % 60;
    return new PyDateTime(y, m, d, (t - mi) / 60, mi, s, us);
  }
  date() { return new PyDate(this.year, this.month, this.day); }
  toString() {
    return `${this.date().isoformat()} ${fmtTime(this.hour, this.minute, this.second, this.us)}${fmtOffset(this.tz)}`;
  }
}
class PyTime {
  constructor(h, mi, s, us) { Object.assign(this, { hour: h, minute: mi, second: s, us }); }
  toString() { return fmtTime(this.hour, this.minute, this.second, this.us); }
}
class PyTimedelta {
  constructor(days, seconds, us) { this.days = days; this.seconds = seconds; this.us = us; }
  toString() {
    const s = this.seconds;
    const out = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}${this.us ? `.${pad(this.us, 6)}` : ''}`;
    if (!this.days) return out;
    return `${this.days} day${Math.abs(this.days) === 1 ? '' : 's'}, ${out}`;
  }
}
/** datetime.timedelta(days=<float>) normalisation (CPython _pydatetime). */
function timedeltaFromDays(value) {
  const days = Math.trunc(value);
  const dayfrac = value - days;
  const ds = dayfrac * 86400.0;
  const dsWhole = Math.trunc(ds);
  let s = dsWhole;
  let d = days;
  const usdouble = (ds - dsWhole) * 1e6;
  let micro = pyRoundInt(usdouble);
  let carry = Math.floor(micro / 1e6); micro -= carry * 1e6; s += carry;
  carry = Math.floor(s / 86400); s -= carry * 86400; d += carry;
  if (Math.abs(d) > 999999999) throw new RangeError('timedelta # of days is too large');
  return new PyTimedelta(d, s, micro);
}

/** str(value) as used by clean_text (integral floats print as ints). */
function pyStr(v) {
  switch (typeof v) {
    case 'string': return v;
    case 'number': return Number.isInteger(v) ? intStr(v) : pyFloatRepr(v);
    case 'bigint': return v.toString();
    case 'boolean': return v ? 'True' : 'False';
    default: return String(v);
  }
}

// ═══════════════════════════════ text decoding ═════════════════════════════════════
// cp1255 exactly as Python's codec (undefined bytes -> U+FFFD with errors="replace";
// WHATWG windows-1255 differs for 0x81, 0x8A, 0x8C-0x90, 0x9A, 0x9C-0x9F, 0xCA …).
const CP1255 = (() => {
  const high = '\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\ufffd\u2039\ufffd\ufffd\ufffd\ufffd' +
    '\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\ufffd\u203a\ufffd\ufffd\ufffd\ufffd' +
    '\u00a0\u00a1\u00a2\u00a3\u20aa\u00a5\u00a6\u00a7\u00a8\u00a9\u00d7\u00ab\u00ac\u00ad\u00ae\u00af' +
    '\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00f7\u00bb\u00bc\u00bd\u00be\u00bf' +
    '\u05b0\u05b1\u05b2\u05b3\u05b4\u05b5\u05b6\u05b7\u05b8\u05b9\ufffd\u05bb\u05bc\u05bd\u05be\u05bf' +
    '\u05c0\u05c1\u05c2\u05c3\u05f0\u05f1\u05f2\u05f3\u05f4\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd' +
    '\u05d0\u05d1\u05d2\u05d3\u05d4\u05d5\u05d6\u05d7\u05d8\u05d9\u05da\u05db\u05dc\u05dd\u05de\u05df' +
    '\u05e0\u05e1\u05e2\u05e3\u05e4\u05e5\u05e6\u05e7\u05e8\u05e9\u05ea\ufffd\ufffd\u200e\u200f\ufffd';
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) t[i] = i < 128 ? i : high.charCodeAt(i - 128);
  return t;
})();
function unitsToString(u16) {
  let s = '';
  for (let i = 0; i < u16.length; i += 0x4000) s += String.fromCharCode.apply(null, u16.subarray(i, i + 0x4000));
  return s;
}
function decodeCp1255(bytes, strict = false) {
  const u = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const c = CP1255[bytes[i]];
    if (strict && c === 0xfffd) fail(`'charmap' codec can't decode byte 0x${bytes[i].toString(16)}`);
    u[i] = c;
  }
  return unitsToString(u);
}
/** latin-1 (NOT TextDecoder('latin1'), which is windows-1252). */
const decodeLatin1 = (bytes) => unitsToString(Uint16Array.from(bytes));
const decoders = new Map();
function getDecoder(label, fatal, ignoreBOM) {
  const key = `${label}|${fatal}|${ignoreBOM}`;
  let d = decoders.get(key);
  if (!d) { d = new TextDecoder(label, { fatal, ignoreBOM }); decoders.set(key, d); }
  return d;
}
/** UTF-8; fatal = strict (throws), else U+FFFD replacement like errors="replace". */
function decodeUtf8(bytes, fatal) {
  if (typeof TextDecoder !== 'function') return strFromU8(bytes);
  try {
    return getDecoder('utf-8', fatal, true).decode(bytes);
  } catch (e) {
    throw new ReadError(`'utf-8' codec can't decode bytes: ${e.message}`);
  }
}
function decodeUtf16(bytes, bigEndian, fatal, ignoreBOM) {
  try {
    return getDecoder(bigEndian ? 'utf-16be' : 'utf-16le', fatal, ignoreBOM).decode(bytes);
  } catch (e) {
    throw new ReadError(`'utf-16' codec can't decode bytes: ${e.message}`);
  }
}
const startsWithBytes = (b, sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x);

/** readers.decode_bytes */
function decodeBytes(data) {
  if (startsWithBytes(data, [0xef, 0xbb, 0xbf])) return decodeUtf8(data.subarray(3), false);
  if (startsWithBytes(data, [0xff, 0xfe])) return decodeUtf16(data, false, false, false);
  if (startsWithBytes(data, [0xfe, 0xff])) return decodeUtf16(data, true, false, false);
  const head = decodeLatin1(data.subarray(0, 3000)).toLowerCase();
  const m = /charset=["']?([a-z0-9_-]+)/.exec(head);
  if (m) {
    const enc = m[1];
    if (['windows-1255', 'cp1255', 'iso-8859-8', 'iso-8859-8-i'].includes(enc)) return decodeCp1255(data);
    if (enc === 'utf-8' || enc === 'utf8') return decodeUtf8(data, false);
  }
  try {
    return decodeUtf8(data, true);
  } catch {
    return decodeCp1255(data);
  }
}

// ═════════════════════════════════ normalize.py ════════════════════════════════════
const RE_BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const RE_QUOTES = /["'\u05f4\u05f3`\u00b4\u2018\u2019\u201c\u201d]/g;

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const s = pyStr(value).replace(RE_BIDI, '').replace(/\u00a0/g, ' ');
  return pyStrip(s.replace(RE_WS_RUN, ' '));
}
function normHeader(value) {
  const s = cleanText(value).replace(RE_QUOTES, '');
  return pyStrip(s.replace(RE_WS_RUN, ' ')).toLowerCase();
}
/** Stable key for "the same merchant" (drops branch numbers, punctuation, case). */
function merchantKey(desc) {
  const low = cleanText(desc).toLowerCase();
  const s = pyStrip(low.replace(RE_NOT_ALPHA_SPACE, ' ').replace(RE_WS_RUN, ' '));
  return s || low;
}

const RE_DMY = /^(\p{Nd}{1,2})[./-](\p{Nd}{1,2})[./-](\p{Nd}{2,4})/u;
const RE_YMD = /^(\p{Nd}{4})[./-](\p{Nd}{1,2})[./-](\p{Nd}{1,2})/u;
const ORD_1899_12_30 = ymd2ord(1899, 12, 30);
const safeDate = (y, m, d) => (validYmd(y, m, d) ? new PyDate(y, m, d) : null);

/** Day-first date parsing -> PyDate | null */
function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof PyDateTime) return value.date();
  if (value instanceof PyDate) return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (Number.isNaN(value)) return null;
    if (value > 20000 && value < 80000) return PyDate.fromOrdinal(ORD_1899_12_30 + Math.trunc(Number(value)));
    return null;
  }
  const s = cleanText(value);
  let m = RE_YMD.exec(s);
  if (m) return safeDate(pyIntDigits(m[1]), pyIntDigits(m[2]), pyIntDigits(m[3]));
  m = RE_DMY.exec(s);
  if (m) {
    let y = pyIntDigits(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return safeDate(y, pyIntDigits(m[2]), pyIntDigits(m[1]));
  }
  return null;
}

// Python's re.IGNORECASE also folds ı/İ onto i and ſ onto s.
const RE_CURRENCY_JUNK = /(₪|ש"ח|ש״ח|שח|n[iıİ][sſ]|[iıİ]l[sſ]|u[sſ]d|eur|\$|€|£)/giu;
const RE_THOUSANDS = /^\p{Nd}{1,3}(?:,\p{Nd}{3})+$/u;
const RE_DECIMAL_COMMA = /^\p{Nd}+,\p{Nd}{1,2}$/u;

/** Amount parsing ("1,234.50", "(12)", "12-", "₪ 5") -> number | null */
function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  if (typeof value === 'bigint') return Number(value);
  let s = cleanText(value).replace(RE_CURRENCY_JUNK, '').split(' ').join('');
  if (!s || s === '-' || s === '--') return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.includes(',') && s.includes('.')) s = s.split(',').join('');
  else if (s.includes(',')) {
    if (RE_THOUSANDS.test(s)) s = s.split(',').join('');
    else if (RE_DECIMAL_COMMA.test(s)) s = s.split(',').join('.');
    else s = s.split(',').join('');
  }
  const num = pyFloat(s);
  if (num === null) return null;
  return neg ? -num : num;
}

const ILS_NAMES = new Set(['', '₪', 'שח', 'ils', 'nis', 'שקל', 'שקלים']);
function isIls(currency) {
  const c = normHeader(currency);
  return ILS_NAMES.has(c) || c.includes('₪');
}

const RE_INSTALLMENT = new RegExp(`תשלום[${WS_CLASS}]*(\\p{Nd}+)[${WS_CLASS}]*(?:מתוך|מ-|/)[${WS_CLASS}]*(\\p{Nd}+)`, 'u');
function parseInstallment(...texts) {
  for (const t of texts) {
    const m = RE_INSTALLMENT.exec(cleanText(t));
    if (m) return [pyIntDigits(m[1]), pyIntDigits(m[2])];
  }
  return [null, null];
}

/** Python truthiness `x or 0.0` for parse_amount results. */
const or0 = (v) => (v === null || v === 0 ? 0 : v);

// ═════════════════════════════════ columns.py ══════════════════════════════════════
/** Table: { name, rows, width }. width != null: every row is logically padded to it
 *  (openpyxl pads to 256, xlrd to ncols); rows may then be sparse arrays. */
const rowLen = (table, row) => (table.width ?? row.length);
const cellAt = (row, i) => (row[i] === undefined ? null : row[i]);

function fieldSpec(name, synonyms) {
  return {
    name,
    norm: synonyms.map((s) => (s.startsWith('=') ? [normHeader(s.slice(1)), true] : [normHeader(s), false])),
  };
}
function matchSpec(cells, spec, used) {
  for (const [syn] of spec.norm) {
    for (const [i, c] of cells) if (!used.has(i) && c === syn) return i;
  }
  for (const [syn, exact] of spec.norm) {
    if (exact) continue;
    const lim = cpLen(syn) + 25;
    for (const [i, c] of cells) if (!used.has(i) && c.includes(syn) && cpLen(c) <= lim) return i;
  }
  return null;
}
function findHeader(table, specs, required, anyOf, maxScan = 40) {
  let best = null;
  const lim = Math.min(maxScan, table.rows.length);
  for (let r = 0; r < lim; r++) {
    const row = table.rows[r];
    if (rowLen(table, row) === 0) continue;
    const cells = [];
    row.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const c = normHeader(v);
      if (c) cells.push([i, c]);
    });
    if (cells.length < 2) continue;
    const mapping = Object.create(null);
    const used = new Set();
    let score = 0;
    for (const spec of specs) {
      const idx = matchSpec(cells, spec, used);
      if (idx !== null) { mapping[spec.name] = idx; used.add(idx); score++; }
    }
    if (!required.every((k) => k in mapping)) continue;
    if (anyOf && !anyOf.some((k) => k in mapping)) continue;
    if (best === null || score > best.score) best = { row: r, mapping, score };
  }
  return best;
}
function cellOf(table, row, mapping, name) {
  const idx = mapping[name];
  if (idx === undefined || idx >= rowLen(table, row)) return null;
  return cellAt(row, idx);
}

// ═══════════════════════════════════ readers ═══════════════════════════════════════
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function sniffKind(data) {
  const head = data.subarray(0, 4096);
  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx';
  if (startsWithBytes(head, OLE_SIG)) return 'xls';
  const text = decodeBytes(head).toLowerCase();
  if (text.includes('<workbook') && text.includes('office:spreadsheet')) return 'xml';
  if (text.includes('<table') || text.includes('<html') || text.includes('<!doctype html')) return 'html';
  if (head.includes(0) && !startsWithBytes(head, [0xff, 0xfe]) && !startsWithBytes(head, [0xfe, 0xff])) return 'unknown';
  return 'csv';
}

function readTables(name, data) {
  if (data.length > MAX_FILE_BYTES) throw new UnsupportedFile(`הקובץ גדול מדי לקובץ בנק: ${name}`);
  switch (sniffKind(data)) {
    case 'xlsx': return readXlsx(name, data);
    case 'xls': return readXls(data);
    case 'html': return readHtml(data);
    case 'xml': return readSpreadsheetMl(data);
    case 'csv': return readCsv(name, data);
    default: throw new UnsupportedFile(`סוג קובץ לא נתמך: ${name}`);
  }
}

// ─────────────────────── HTML (port of html.parser.HTMLParser) ───────────────────────
const HTML_ENTITIES = (() => {
  const src =
    'AElig*=c6 AMP*=26 Aacute*=c1 Acirc*=c2 Agrave*=c0 Alpha=391 ApplyFunction=2061 Aring*=c5 ' +
    'Atilde*=c3 Auml*=c4 Beta=392 COPY*=a9 Ccedil*=c7 Chi=3a7 Dagger=2021 Delta=394 ETH*=d0 ' +
    'Eacute*=c9 Ecirc*=ca Egrave*=c8 Epsilon=395 Eta=397 Euml*=cb GT*=3e Gamma=393 Hat=5e Iacute*=cd ' +
    'Icirc*=ce Igrave*=cc InvisibleComma=2063 InvisibleTimes=2062 Iota=399 Iuml*=cf Kappa=39a LT*=3c ' +
    'Lambda=39b MediumSpace=205f Mu=39c NewLine=a NoBreak=2060 NonBreakingSpace=a0 Ntilde*=d1 Nu=39d ' +
    'OElig=152 Oacute*=d3 Ocirc*=d4 Ograve*=d2 Omega=3a9 Omicron=39f Oslash*=d8 Otilde*=d5 Ouml*=d6 ' +
    'Phi=3a6 Pi=3a0 Prime=2033 Psi=3a8 QUOT*=22 REG*=ae Rho=3a1 Scaron=160 Sigma=3a3 THORN*=de Tab=9 ' +
    'Tau=3a4 Theta=398 ThinSpace=2009 Uacute*=da Ucirc*=db Ugrave*=d9 Upsilon=3a5 Uuml*=dc Vert=2016 ' +
    'VeryThinSpace=200a Xi=39e Yacute*=dd Yuml=178 ZeroWidthSpace=200b Zeta=396 aacute*=e1 acirc*=e2 ' +
    'acute*=b4 aelig*=e6 af=2061 agrave*=e0 alefsym=2135 alpha=3b1 amp*=26 and=2227 ang=2220 apos=27 ' +
    'aring*=e5 ast=2a asymp=2248 atilde*=e3 auml*=e4 bdquo=201e beta=3b2 brvbar*=a6 bsol=5c bull=2022 ' +
    'bullet=2022 cap=2229 ccedil*=e7 cedil*=b8 cent*=a2 check=2713 chi=3c7 circ=2c6 clubs=2663 ' +
    'colon=3a comma=2c commat=40 cong=2245 copy*=a9 crarr=21b5 cross=2717 cup=222a curren*=a4 ' +
    'dArr=21d3 dagger=2020 darr=2193 dash=2010 deg*=b0 delta=3b4 diams=2666 divide*=f7 dollar=24 ' +
    'eacute*=e9 ecirc*=ea egrave*=e8 empty=2205 emsp=2003 emsp13=2004 emsp14=2005 ensp=2002 ' +
    'epsilon=3b5 equals=3d equiv=2261 eta=3b7 eth*=f0 euml*=eb euro=20ac excl=21 exist=2203 ' +
    'female=2640 fnof=192 forall=2200 frac12*=bd frac13=2153 frac14*=bc frac15=2155 frac16=2159 ' +
    'frac18=215b frac23=2154 frac34*=be frac38=215c frac58=215d frac78=215e frasl=2044 gamma=3b3 ' +
    'ge=2265 grave=60 gt*=3e hArr=21d4 hairsp=200a half=bd harr=2194 hearts=2665 hellip=2026 ' +
    'horbar=2015 hyphen=2010 iacute*=ed ic=2063 icirc*=ee iexcl*=a1 igrave*=ec image=2111 infin=221e ' +
    'int=222b iota=3b9 iquest*=bf isin=2208 it=2062 iuml*=ef kappa=3ba lArr=21d0 lambda=3bb lang=27e8 ' +
    'laquo*=ab larr=2190 lbrace=7b lbrack=5b lceil=2308 lcub=7b ldquo=201c ldquor=201e le=2264 ' +
    'lfloor=230a lowast=2217 lowbar=5f loz=25ca lpar=28 lrm=200e lsaquo=2039 lsqb=5b lsquo=2018 ' +
    'lsquor=201a lt*=3c macr*=af male=2642 mdash=2014 micro*=b5 middot*=b7 minus=2212 mldr=2026 ' +
    'mu=3bc nabla=2207 nbsp*=a0 ndash=2013 ne=2260 ni=220b nldr=2025 not*=ac notin=2209 nsub=2284 ' +
    'ntilde*=f1 nu=3bd num=23 numsp=2007 oacute*=f3 ocirc*=f4 oelig=153 ograve*=f2 oline=203e ' +
    'omega=3c9 omicron=3bf oplus=2295 or=2228 ordf*=aa ordm*=ba oslash*=f8 otilde*=f5 otimes=2297 ' +
    'ouml*=f6 para*=b6 part=2202 percnt=25 period=2e permil=2030 perp=22a5 phi=3c6 phone=260e pi=3c0 ' +
    'piv=3d6 plus=2b plusmn*=b1 pound*=a3 prime=2032 prod=220f prop=221d psi=3c8 puncsp=2008 quest=3f ' +
    'quot*=22 rArr=21d2 radic=221a rang=27e9 raquo*=bb rarr=2192 rbrace=7d rbrack=5d rceil=2309 ' +
    'rcub=7d rdquo=201d rdquor=201d real=211c reg*=ae rfloor=230b rho=3c1 rlm=200f rpar=29 ' +
    'rsaquo=203a rsqb=5d rsquo=2019 rsquor=2019 sbquo=201a scaron=161 sdot=22c5 sect*=a7 semi=3b ' +
    'shy*=ad sigma=3c3 sigmaf=3c2 sim=223c sol=2f spades=2660 star=2606 starf=2605 sub=2282 sube=2286 ' +
    'sum=2211 sup=2283 sup1*=b9 sup2*=b2 sup3*=b3 supe=2287 szlig*=df tau=3c4 there4=2234 theta=3b8 ' +
    'thetasym=3d1 thinsp=2009 thorn*=fe tilde=2dc times*=d7 trade=2122 uArr=21d1 uacute*=fa uarr=2191 ' +
    'ucirc*=fb ugrave*=f9 uml*=a8 upsih=3d2 upsilon=3c5 uuml*=fc verbar=7c vert=7c weierp=2118 xi=3be ' +
    'yacute*=fd yen*=a5 yuml*=ff zeta=3b6 zwj=200d zwnj=200c';
  // "name*" = legacy entity, valid with and without ';' (html.entities.html5 keys).
  const map = new Map();
  for (const item of src.split(' ')) {
    const [k, cp] = item.split('=');
    const ch = String.fromCodePoint(parseInt(cp, 16));
    const legacy = k.endsWith('*');
    const nm = legacy ? k.slice(0, -1) : k;
    map.set(`${nm};`, ch);
    if (legacy) map.set(nm, ch);
  }
  return map;
})();
const INVALID_CHARREFS = new Map([[0x00, '\ufffd'], [0x0d, '\r'], [0x80, '€'], [0x81, '\x81'],
  [0x82, '‚'], [0x83, 'ƒ'], [0x84, '„'], [0x85, '…'], [0x86, '†'],
  [0x87, '‡'], [0x88, 'ˆ'], [0x89, '‰'], [0x8a, 'Š'], [0x8b, '‹'],
  [0x8c, 'Œ'], [0x8d, '\x8d'], [0x8e, 'Ž'], [0x8f, '\x8f'], [0x90, '\x90'],
  [0x91, '‘'], [0x92, '’'], [0x93, '“'], [0x94, '”'], [0x95, '•'],
  [0x96, '–'], [0x97, '—'], [0x98, '˜'], [0x99, '™'], [0x9a, 'š'],
  [0x9b, '›'], [0x9c, 'œ'], [0x9d, '\x9d'], [0x9e, 'ž'], [0x9f, 'Ÿ']]);
const isInvalidCodepoint = (n) => (n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) ||
  (n >= 0x7f && n <= 0x9f) || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe;

const RE_CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;
function replaceCharref(s) {
  if (s[0] === '#') {
    const num = s[1] === 'x' || s[1] === 'X' ? parseInt(s.slice(2), 16) : parseInt(s.slice(1), 10);
    if (INVALID_CHARREFS.has(num)) return INVALID_CHARREFS.get(num);
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '\ufffd';
    if (isInvalidCodepoint(num)) return '';
    return String.fromCodePoint(num);
  }
  const hit = HTML_ENTITIES.get(s);
  if (hit !== undefined) return hit;
  const cps = Array.from(s);
  for (let x = cps.length - 1; x > 1; x--) {
    const p = HTML_ENTITIES.get(cps.slice(0, x).join(''));
    if (p !== undefined) return p + cps.slice(x).join('');
  }
  return `&${s}`;
}
/** html.unescape */
const htmlUnescape = (s) => (s.includes('&') ? s.replace(RE_CHARREF, (_, g) => replaceCharref(g)) : s);
const RE_ATTR_CHARREF = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g;
const unescapeAttr = (s) => s.replace(RE_ATTR_CHARREF, (ref) => {
  if (ref.startsWith('&#')) return htmlUnescape(ref);
  if (!ref.endsWith('=') && HTML_ENTITIES.has(ref.slice(1))) return htmlUnescape(ref);
  return ref;
});

// Regular expressions of html.parser (CPython 3.13).
const RE_STARTTAGOPEN = /<[a-zA-Z]/y;
const RE_ENDTAGOPEN = /<\/[a-zA-Z]/y;
const RE_TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const RE_ATTRFIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const RE_LOCATETAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const RE_COMMENTCLOSE = /--!?>/g;
const RE_COMMENTABRUPT = /-?>/y;
const CDATA_CONTENT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
const RCDATA_CONTENT = new Set(['textarea', 'title']);
const stickyAt = (re, s, i) => { re.lastIndex = i; return re.exec(s); };

/** feed(all) + close() of HTMLParser(convert_charrefs=True); calls sink.start/end/data. */
function htmlParse(raw, sink) {
  const n = raw.length;
  let i = 0;
  let cdataElem = null;
  let cdataRe = null;
  let escapable = true;
  const clearCdata = () => { cdataElem = null; cdataRe = null; escapable = true; };

  const parseBogusComment = (p) => { const e = raw.indexOf('>', p + 2); return e < 0 ? -1 : e + 1; };
  const parseComment = (p) => {
    let m = stickyAt(RE_COMMENTABRUPT, raw, p + 4);
    if (!m) { RE_COMMENTCLOSE.lastIndex = p + 4; m = RE_COMMENTCLOSE.exec(raw); }
    return m ? m.index + m[0].length : -1;
  };
  const parseDecl = (p) => {
    if (raw.startsWith('<![CDATA[', p)) { const e = raw.indexOf(']]>', p + 9); return e < 0 ? -1 : e + 3; }
    if (raw.slice(p, p + 9).toLowerCase() === '<!doctype') { const e = raw.indexOf('>', p + 9); return e < 0 ? -1 : e + 1; }
    return parseBogusComment(p);
  };
  const parseStarttag = (p) => {
    const endpos = p + 1 + stickyAt(RE_LOCATETAGEND, raw, p + 1)[0].length;
    if (raw[endpos - 1] !== '>') return -1;
    const tm = stickyAt(RE_TAGFIND, raw, p + 1);
    let k = p + 1 + tm[0].length;
    const tag = tm[1].toLowerCase();
    const attrs = [];
    while (k < endpos) {
      const m = stickyAt(RE_ATTRFIND, raw, k);
      if (!m || !m[0].length) break;
      let val = m[2] ? m[3] : null;
      if (val !== null && ((val[0] === "'" && val.endsWith("'")) || (val[0] === '"' && val.endsWith('"')))) val = val.slice(1, -1);
      if (val) val = unescapeAttr(val);
      attrs.push([m[1].toLowerCase(), val]);
      k += m[0].length;
    }
    const end = pyStrip(raw.slice(k, endpos));
    if (end !== '>' && end !== '/>') { sink.data(raw.slice(p, endpos)); return endpos; }
    sink.start(tag, attrs);
    if (end.endsWith('/>')) sink.end(tag);
    else if (CDATA_CONTENT.has(tag) || tag === 'plaintext' || RCDATA_CONTENT.has(tag)) {
      cdataElem = tag;
      escapable = RCDATA_CONTENT.has(tag);
      cdataRe = tag === 'plaintext' ? null : new RegExp(`</${tag}(?=[\\t\\n\\r\\f />])`, 'gi');
    }
    return endpos;
  };
  const parseEndtag = (p) => {
    if (raw.indexOf('>', p + 2) < 0) return -1;
    if (!stickyAt(RE_ENDTAGOPEN, raw, p)) return raw[p + 2] === '>' ? p + 3 : parseBogusComment(p);
    const j = p + 2 + stickyAt(RE_LOCATETAGEND, raw, p + 2)[0].length;
    if (raw[j - 1] !== '>') return -1;
    sink.end(stickyAt(RE_TAGFIND, raw, p + 2)[1].toLowerCase());
    clearCdata();
    return j;
  };

  while (i < n) {
    let j;
    if (cdataElem === null) {
      j = raw.indexOf('<', i);
      if (j < 0) j = n;
    } else if (cdataRe === null) {
      j = n;                                  // <plaintext>: everything is data
    } else {
      cdataRe.lastIndex = i;
      const m = cdataRe.exec(raw);
      if (!m) break;
      j = m.index;
    }
    if (i < j) sink.data(escapable ? htmlUnescape(raw.slice(i, j)) : raw.slice(i, j));
    i = j;
    if (i >= n) break;
    let k;
    if (stickyAt(RE_STARTTAGOPEN, raw, i)) k = parseStarttag(i);
    else if (raw.startsWith('</', i)) k = parseEndtag(i);
    else if (raw.startsWith('<!--', i)) k = parseComment(i);
    else if (raw.startsWith('<?', i)) k = parseBogusComment(i);
    else if (raw.startsWith('<!', i)) k = parseDecl(i);
    else { sink.data('<'); k = i + 1; }
    if (k < 0) {                              // unterminated construct at EOF
      if (!stickyAt(RE_STARTTAGOPEN, raw, i) && raw.startsWith('</', i) && i + 2 === n) sink.data('</');
      k = n;
    }
    i = k;
  }
  if (i < n) sink.data(escapable ? htmlUnescape(raw.slice(i)) : raw.slice(i));
}

/** readers._TableParser */
class HtmlTableSink {
  constructor() { this.tables = []; this.stack = []; }
  closeCell(t) {
    if (t.cell === null) return;
    const text = pyStrip(t.cell.join('').replace(RE_WS_RUN, ' '));
    if (t.row === null) t.row = [];
    if (t.row.length < MAX_COLS) {
      t.row.push(text);
      const extra = Math.min(t.colspan - 1, MAX_COLS - t.row.length);
      for (let k = 0; k < extra; k++) t.row.push('');
    }
    t.cell = null;
  }
  closeRow(t) {
    this.closeCell(t);
    if (t.row !== null) {
      if (t.rows.length < MAX_ROWS) t.rows.push(t.row);
      t.row = null;
    }
  }
  start(tag, attrs) {
    if (tag === 'table') { this.stack.push({ rows: [], row: null, cell: null, colspan: 1 }); return; }
    const t = this.stack[this.stack.length - 1];
    if (!t) return;
    if (tag === 'tr') {
      this.closeRow(t);
      t.row = [];
    } else if (tag === 'td' || tag === 'th') {
      this.closeCell(t);
      if (t.row === null) t.row = [];
      let span = null;
      for (const [k, v] of attrs) if (k === 'colspan') span = v;   // dict(attrs): last wins
      span = span || '1';
      t.colspan = pyIsDigit(span) ? Math.min(pyIntOfDigit(span), MAX_COLS) : 1;
      t.cell = [];
    } else if (tag === 'br' && t.cell !== null) {
      t.cell.push(' ');
    }
  }
  end(tag) {
    const t = this.stack[this.stack.length - 1];
    if (!t) return;
    if (tag === 'td' || tag === 'th') this.closeCell(t);
    else if (tag === 'tr') this.closeRow(t);
    else if (tag === 'table') {
      this.closeRow(t);
      this.tables.push(t.rows);
      this.stack.pop();
    }
  }
  data(d) {
    const t = this.stack[this.stack.length - 1];
    if (t && t.cell !== null) t.cell.push(d);
  }
}
function readHtml(data) {
  const sink = new HtmlTableSink();
  htmlParse(decodeBytes(data), sink);
  while (sink.stack.length) {                 // unclosed tables
    const t = sink.stack.pop();
    sink.closeRow(t);
    sink.tables.push(t.rows);
  }
  return sink.tables.map((rows, i) => ({ name: `table${i + 1}`, rows, width: null })).filter((t) => t.rows.length);
}

// ───────────────────── XML (strict, namespace-aware, like expat/ET) ─────────────────────
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const RE_XML_BAD_CHAR = /[^\t\n\r\x20-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
const NAME_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
// XML NameChar includes ZWNJ/ZWJ and combining marks as single code points ('u' flag).
// eslint-disable-next-line no-misleading-character-class
const RE_XML_NAME = new RegExp(`[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]*`, 'uy');
const XML_PREDEFINED = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };
const isXmlWs = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const xmlErr = (msg) => fail(`XML: ${msg}`);
const isXmlChar = (n) => n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0xd7ff) ||
  (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

function xmlDecodeRefs(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf('&', i);
    if (a < 0) return out + s.slice(i);
    const b = s.indexOf(';', a + 1);
    if (b < 0) xmlErr('not well-formed (invalid token)');
    const body = s.slice(a + 1, b);
    let rep;
    if (body[0] === '#') {
      const hex = body[1] === 'x';
      const digits = body.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) xmlErr('not well-formed (invalid token)');
      const num = parseInt(digits, hex ? 16 : 10);
      if (!isXmlChar(num)) xmlErr('reference to invalid character number');
      rep = String.fromCodePoint(num);
    } else if (Object.hasOwn(XML_PREDEFINED, body)) {
      rep = XML_PREDEFINED[body];
    } else {
      xmlErr(`undefined entity &${body};`);
    }
    out += s.slice(i, a) + rep;
    i = b + 1;
  }
}

/**
 * Streaming XML parser. handler.start(tag, attrs) / end(tag) / text(str); tags and attribute
 * names are ElementTree style ("{uri}local"). A handler may throw STOP to end early.
 */
function xmlParse(src, handler) {
  src = src.replace(/\r\n?/g, '\n');
  if (RE_XML_BAD_CHAR.test(src)) xmlErr('not well-formed (invalid token)');
  const n = src.length;
  let i = 0;
  const stack = [];
  const rootScope = Object.create(null);
  rootScope[''] = '';
  rootScope.xml = XML_NS;
  let scope = rootScope;
  let seenRoot = false;
  const resolve = (qname, sc, isElement) => {
    const c = qname.indexOf(':');
    if (c < 0) {
      if (!isElement) return qname;
      const u = sc[''];
      return u ? `{${u}}${qname}` : qname;
    }
    if (c === 0 || c === qname.length - 1 || qname.indexOf(':', c + 1) >= 0) xmlErr('not well-formed (invalid token)');
    const prefix = qname.slice(0, c);
    const uri = prefix === 'xmlns' ? undefined : sc[prefix];
    if (uri === undefined || uri === '') xmlErr(`unbound prefix ${prefix}`);
    return `{${uri}}${qname.slice(c + 1)}`;
  };
  const text = (a, b) => {
    const t = src.slice(a, b);
    if (!stack.length) {
      for (let q = 0; q < t.length; q++) if (!isXmlWs(t.charCodeAt(q))) xmlErr(seenRoot ? 'junk after document element' : 'syntax error');
      return;
    }
    handler.text(xmlDecodeRefs(t));
  };
  const readName = (p) => {
    const c0 = src.charCodeAt(p);
    if ((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90) || c0 === 95 || c0 === 58) {   // ASCII fast path
      let j = p + 1;
      for (;;) {
        const c = src.charCodeAt(j);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 45 || c === 46) j++;
        else if (c >= 0x80) break;                       // non-ASCII: use the full NameChar regex
        else return src.slice(p, j);
      }
    }
    const m = stickyAt(RE_XML_NAME, src, p);
    if (!m) xmlErr('not well-formed (invalid token)');
    return m[0];
  };
  const tagCache = new WeakMap();                       // scope -> Map(qname -> "{uri}local")
  const resolveTag = (qname, sc) => {
    let m = tagCache.get(sc);
    if (!m) { m = new Map(); tagCache.set(sc, m); }
    let t = m.get(qname);
    if (t === undefined) { t = resolve(qname, sc, true); m.set(qname, t); }
    return t;
  };
  if (src.startsWith('<?xml') && isXmlWs(src.charCodeAt(5))) {
    const e = src.indexOf('?>', 5);
    if (e < 0) xmlErr('unclosed token');
    i = e + 2;
  }
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(i, n); break; }
    if (lt > i) text(i, lt);
    i = lt;
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 0x2f) {                                        // </name>
      const qn = readName(i + 2);
      let j = i + 2 + qn.length;
      while (isXmlWs(src.charCodeAt(j))) j++;
      if (src.charCodeAt(j) !== 0x3e) xmlErr('not well-formed (invalid token)');
      const fr = stack.pop();
      if (!fr || fr.qname !== qn) xmlErr('mismatched tag');
      scope = fr.parentScope;
      handler.end(fr.tag);
      i = j + 1;
    } else if (c1 === 0x21) {                                 // <! ... >
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('--', i + 4);
        if (e < 0) xmlErr('unclosed token');
        if (src.charCodeAt(e + 2) !== 0x3e) xmlErr('not well-formed (invalid token)');
        i = e + 3;
      } else if (src.startsWith('<![CDATA[', i)) {
        if (!stack.length) xmlErr('not well-formed (invalid token)');
        const e = src.indexOf(']]>', i + 9);
        if (e < 0) xmlErr('unclosed CDATA section');
        handler.text(src.slice(i + 9, e));
        i = e + 3;
      } else if (src.startsWith('<!DOCTYPE', i) && !seenRoot) {
        let j = i + 9;
        let depth = 0;
        for (;;) {
          if (j >= n) xmlErr('unclosed token');
          const ch = src[j];
          if (ch === '"' || ch === "'") {
            const e = src.indexOf(ch, j + 1);
            if (e < 0) xmlErr('unclosed token');
            j = e + 1;
            continue;
          }
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (ch === '>' && depth <= 0) break;
          j++;
        }
        i = j + 1;
      } else {
        xmlErr('not well-formed (invalid token)');
      }
    } else if (c1 === 0x3f) {                                 // <?pi ... ?>
      const target = readName(i + 2);
      if (target.toLowerCase() === 'xml') xmlErr('XML or text declaration not at start of entity');
      const e = src.indexOf('?>', i + 2);
      if (e < 0) xmlErr('unclosed token');
      i = e + 2;
    } else {                                                  // <name attr="v" ...>
      if (seenRoot && !stack.length) xmlErr('junk after document element');
      const qname = readName(i + 1);
      let j = i + 1 + qname.length;
      const raw = [];
      let selfClose = false;
      for (;;) {
        const ws0 = j;
        while (isXmlWs(src.charCodeAt(j))) j++;
        const ch = src.charCodeAt(j);
        if (ch === 0x3e) { j++; break; }
        if (ch === 0x2f) {
          if (src.charCodeAt(j + 1) !== 0x3e) xmlErr('not well-formed (invalid token)');
          j += 2;
          selfClose = true;
          break;
        }
        if (j >= n) xmlErr('unclosed token');
        if (j === ws0) xmlErr('not well-formed (invalid token)');
        const an = readName(j);
        j += an.length;
        while (isXmlWs(src.charCodeAt(j))) j++;
        if (src.charCodeAt(j) !== 0x3d) xmlErr('not well-formed (invalid token)');
        j++;
        while (isXmlWs(src.charCodeAt(j))) j++;
        const q = src[j];
        if (q !== '"' && q !== "'") xmlErr('not well-formed (invalid token)');
        const ve = src.indexOf(q, j + 1);
        if (ve < 0) xmlErr('unclosed token');
        const rv = src.slice(j + 1, ve);
        if (rv.includes('<')) xmlErr('not well-formed (invalid token)');
        raw.push([an, xmlDecodeRefs(rv.replace(/[\t\n]/g, ' '))]);
        j = ve + 1;
      }
      let sc = scope;
      for (const [an, av] of raw) {
        if (an === 'xmlns' || an.startsWith('xmlns:')) {
          if (sc === scope) sc = Object.create(scope);
          if (an === 'xmlns') sc[''] = av;
          else {
            if (!av) xmlErr('unbound prefix');
            sc[an.slice(6)] = av;
          }
        }
      }
      const tag = resolveTag(qname, sc);
      const attrs = Object.create(null);
      for (const [an, av] of raw) {
        if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
        const rn = resolve(an, sc, false);
        if (rn in attrs) xmlErr('duplicate attribute');
        attrs[rn] = av;
      }
      seenRoot = true;
      handler.start(tag, attrs);
      if (selfClose) handler.end(tag);
      else { stack.push({ qname, tag, parentScope: scope }); scope = sc; }
      i = j;
    }
  }
  if (stack.length || !seenRoot) xmlErr('no element found');
}
const STOP = Symbol('stop');
const localName = (tag) => (tag.charCodeAt(0) === 0x7b ? tag.slice(tag.indexOf('}') + 1) : tag);

/** Decode XML bytes the way expat does (BOM / XML declaration; strict). */
function decodeXmlBytes(bytes) {
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) return decodeUtf8(bytes.subarray(3), true);
  if (startsWithBytes(bytes, [0xff, 0xfe])) return decodeUtf16(bytes, false, true, false);
  if (startsWithBytes(bytes, [0xfe, 0xff])) return decodeUtf16(bytes, true, true, false);
  if (startsWithBytes(bytes, [0x3c, 0x00, 0x3f, 0x00])) return decodeUtf16(bytes, false, true, true);
  if (startsWithBytes(bytes, [0x00, 0x3c, 0x00, 0x3f])) return decodeUtf16(bytes, true, true, true);
  const head = decodeLatin1(bytes.subarray(0, 256));
  const m = /^<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(head);
  const enc = m ? m[1].toLowerCase() : 'utf-8';
  if (enc === 'utf-8' || enc === 'utf8') return decodeUtf8(bytes, true);
  if (['windows-1255', 'cp1255', 'iso-8859-8', 'iso-8859-8-i'].includes(enc)) return decodeCp1255(bytes, true);
  if (['iso-8859-1', 'latin-1', 'latin1', 'l1'].includes(enc)) return decodeLatin1(bytes);
  if (enc === 'us-ascii' || enc === 'ascii') {
    if (bytes.some((b) => b > 0x7f)) xmlErr('not well-formed (invalid token)');
    return decodeLatin1(bytes);
  }
  let dec;
  try {
    dec = new TextDecoder(enc, { fatal: true });
  } catch {
    xmlErr(`unknown encoding: ${enc}`);
  }
  try {
    return dec.decode(bytes);
  } catch {
    return xmlErr('not well-formed (invalid token)');
  }
}

/** Small DOM for ElementTree-like queries: { tag, attrs, children: (Element|string)[] }. */
function xmlTree(text) {
  let root = null;
  const stack = [];
  xmlParse(text, {
    start(tag, attrs) {
      const el = { tag, attrs, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(el);
      else root = el;
      stack.push(el);
    },
    end() { stack.pop(); },
    text(s) { stack[stack.length - 1].children.push(s); },
  });
  return root;
}
/** Element.iter(tag): document order, including the element itself. */
function* iterTag(root, tag) {
  const todo = [root];
  while (todo.length) {
    const el = todo.pop();
    if (el.tag === tag) yield el;
    for (let k = el.children.length - 1; k >= 0; k--) if (typeof el.children[k] !== 'string') todo.push(el.children[k]);
  }
}
/** "".join(Element.itertext()) */
function itertext(root) {
  let out = '';
  const todo = [root];
  while (todo.length) {
    const el = todo.pop();
    if (typeof el === 'string') { out += el; continue; }
    for (let k = el.children.length - 1; k >= 0; k--) todo.push(el.children[k]);
  }
  return out;
}
const childElements = (el) => el.children.filter((c) => typeof c !== 'string');
/** Element.text: character data before the first child element (null if none). */
function elText(el) {
  let s = '';
  for (const c of el.children) {
    if (typeof c !== 'string') break;
    s += c;
  }
  return s === '' ? null : s;
}

// ───────────────────────────── SpreadsheetML 2003 ─────────────────────────────
const NS_SS = '{urn:schemas-microsoft-com:office:spreadsheet}';

/**
 * datetime.fromisoformat -> PyDateTime | null. Port of CPython 3.13's C implementation
 * (Modules/_datetimemodule.c), which scans the UTF-8 bytes and is more lenient than the
 * pure-Python _pydatetime version (e.g. "...T0000325" style basic formats).
 */
function pyFromIsoformat(str) {
  const cps = Array.from(str);
  if (cps.length < 7) return null;
  // _sanitize_isoformat_str: a non-ASCII separator (code point 7, 8 or 10) becomes 'T'
  for (const pos of [7, 8, 10]) {
    if (pos > cps.length) break;
    if (pos < cps.length && cps[pos].codePointAt(0) > 127) { cps[pos] = 'T'; break; }
  }
  const b = utf8Encode(cps.join(''));
  const len = b.length;
  const at = (i) => (i < len ? b[i] : 0);       // NUL-terminated buffer
  const isDig = (c) => c >= 48 && c <= 57;
  let p = 0;
  const digits = (n) => {                        // parse_digits
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = at(p++) - 48;
      if (c < 0 || c > 9) return null;
      v = v * 10 + c;
    }
    return v;
  };
  // _find_isoformat_datetime_separator
  let sep;
  if (len === 7) sep = 7;
  else if (at(4) === 0x2d) {
    if (at(5) === 0x57) {
      if (len > 8 && at(8) === 0x2d) {
        if (len === 9) return null;
        sep = len > 10 && isDig(at(10)) ? 8 : 10;
      } else sep = 8;
    } else sep = 10;
  } else if (at(4) === 0x57) {
    let idx = 7;
    while (idx < len && isDig(at(idx))) idx++;
    sep = idx < 9 ? idx : (idx % 2 === 0 ? 7 : 8);
  } else sep = 8;
  // parse_isoformat_date
  let year = digits(4);
  if (year === null) return null;
  let month;
  let day;
  const usesSep = at(p) === 0x2d;
  if (usesSep) p++;
  if (at(p) === 0x57) {
    p++;
    const week = digits(2);
    if (week === null) return null;
    let isoDay = 1;
    if (p < sep) {
      if (usesSep && at(p++) !== 0x2d) return null;
      isoDay = digits(1);
      if (isoDay === null) return null;
    }
    if (year < 1 || year > 9999) return null;
    const jan1 = ymd2ord(year, 1, 1);
    const firstWeekday = (jan1 + 6) % 7;          // 0 = Monday
    if (week <= 0 || week >= 53) {
      if (!(week === 53 && (firstWeekday === 3 || (firstWeekday === 2 && isLeap(year))))) return null;
    }
    if (isoDay <= 0 || isoDay >= 8) return null;
    const monday = jan1 - firstWeekday + (firstWeekday > 3 ? 7 : 0);
    [year, month, day] = ord2ymd(monday + (week - 1) * 7 + isoDay - 1);
  } else {
    month = digits(2);
    if (month === null) return null;
    if (usesSep && at(p++) !== 0x2d) return null;
    day = digits(2);
    if (day === null) return null;
  }
  let hour = 0; let minute = 0; let second = 0; let us = 0; let tz = null;
  if (len > sep) {
    // parse_hh_mm_ss_ff over [from, to): {rv, vals, us}; rv 1 = "not at end of string"
    const hhmmss = (from, to) => {
      p = from;
      const vals = [0, 0, 0];
      let hasSep = true;
      for (let i = 0; i < 3; i++) {
        const v = digits(2);
        if (v === null) return { rv: -3 };
        vals[i] = v;
        const c = at(p++);
        if (i === 0) hasSep = c === 0x3a;
        if (p >= to) return { rv: c !== 0 ? 1 : 0, vals, us: 0 };
        if (hasSep && c === 0x3a) continue;
        if (c === 0x2e || c === 0x2c) break;
        if (!hasSep) { p--; continue; }
        return { rv: -4 };
      }
      const toParse = Math.min(to - p, 6);
      let f = toParse > 0 ? digits(toParse) : 0;
      if (f === null) return { rv: -3 };
      if (toParse > 0 && toParse < 6) f *= 10 ** (6 - toParse);
      while (isDig(at(p))) p++;
      return { rv: at(p) !== 0 ? 1 : 0, vals, us: f };
    };
    const t0 = sep + 1;
    let tzPos = t0;
    do {
      const c = at(tzPos);
      if (c === 0x5a || c === 0x2b || c === 0x2d) break;
    } while (++tzPos < len);
    const r1 = hhmmss(t0, tzPos);
    if (r1.rv < 0) return null;
    [hour, minute, second] = r1.vals;
    us = r1.us;
    if (tzPos === len) {
      if (r1.rv === 1) return null;
    } else if (at(tzPos) === 0x5a) {
      if (at(tzPos + 1) !== 0) return null;
      tz = 0;
    } else {
      const sign = at(tzPos) === 0x2d ? -1 : 1;
      const r2 = hhmmss(tzPos + 1, len);
      if (r2.rv !== 0) return null;
      const [th, tm, ts] = r2.vals;
      if (th > 23 || tm > 59 || ts > 59) return null;
      const off = th * 3600 + tm * 60 + ts;
      tz = off === 0 ? 0 : sign * (off * 1e6 + r2.us);
    }
  }
  if (!validYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return new PyDateTime(year, month, day, hour, minute, second, us, tz);
}

function readSpreadsheetMl(data) {
  const root = xmlTree(decodeXmlBytes(data));
  const tables = [];
  for (const ws of iterTag(root, `${NS_SS}Worksheet`)) {
    const name = ws.attrs[`${NS_SS}Name`] || 'Sheet';
    const rows = [];
    for (const row of iterTag(ws, `${NS_SS}Row`)) {
      const out = [];
      for (const cell of childElements(row)) {
        if (cell.tag !== `${NS_SS}Cell`) continue;
        const idx = cell.attrs[`${NS_SS}Index`];
        if (idx && pyIsDigit(idx)) {
          const lim = Math.min(pyIntOfDigit(idx), MAX_COLS) - 1;
          while (out.length < lim) out.push(null);
        }
        const dataEl = childElements(cell).find((c) => c.tag === `${NS_SS}Data`);
        let value = null;
        if (dataEl) {
          const typ = dataEl.attrs[`${NS_SS}Type`];
          const text = itertext(dataEl);
          if (typ === 'Number') {
            const f = pyFloat(text);
            value = f === null ? text : f;
          } else if (typ === 'DateTime') {
            value = pyFromIsoformat(cpPrefix(text, 19)) ?? text;
          } else {
            value = text;
          }
        }
        out.push(value);
        const merge = cell.attrs[`${NS_SS}MergeAcross`];
        if (merge && pyIsDigit(merge)) {
          const k = Math.max(0, Math.min(pyIntOfDigit(merge), MAX_COLS - out.length));
          for (let q = 0; q < k; q++) out.push(null);
        }
        if (out.length >= MAX_COLS) break;
      }
      rows.push(out.slice(0, MAX_COLS));
      if (rows.length >= MAX_ROWS) break;
    }
    tables.push({ name, rows, width: null });
  }
  return tables;
}

// ───────────────────────── CSV (csv.Sniffer + csv.reader) ─────────────────────────
const SNIFF_NOT_WORD = '[^\\p{L}\\p{N}_\\n"\']';
// Possessive body (?:(?P=quote){2}|(?!(?P=quote)).)*+ emulated with an atomic lookahead.
const SNIFF_BODY = '(?=(?<body>(?:\\k<quote>\\k<quote>|(?!\\k<quote>)[\\s\\S])*))\\k<body>';
const SNIFF_BOL = '(?:(?<![\\s\\S])|(?<=\\n)|\\n)';   // (?:^|\n) with re.MULTILINE
const SNIFF_EOL = '(?:(?=\\n)|(?![\\s\\S])|\\n)';    // (?:$|\n) with re.MULTILINE
const SNIFF_RES = [
  `(?<delim>${SNIFF_NOT_WORD})(?<space> ?)(?<quote>["'])${SNIFF_BODY}\\k<quote>\\k<delim>`,
  `${SNIFF_BOL}(?<quote>["'])${SNIFF_BODY}\\k<quote>(?<delim>${SNIFF_NOT_WORD})(?<space> ?)`,
  `(?<delim>${SNIFF_NOT_WORD})(?<space> ?)(?<quote>["'])${SNIFF_BODY}\\k<quote>${SNIFF_EOL}`,
  `${SNIFF_BOL}(?<quote>["'])${SNIFF_BODY}\\k<quote>${SNIFF_EOL}`,
].map((s) => new RegExp(s, 'gu'));

function firstMaxKey(map) {
  let best;
  let bv = -Infinity;
  for (const [k, v] of map) if (v > bv) { best = k; bv = v; }
  return best;
}
function guessQuoteAndDelimiter(data, delimiters) {
  let matches = [];
  for (const re of SNIFF_RES) {
    re.lastIndex = 0;
    matches = [...data.matchAll(re)];
    if (matches.length) break;
  }
  if (!matches.length) return '';
  const delims = new Map();
  for (const m of matches) {
    const g = m.groups;
    if (!('delim' in g)) continue;
    if (g.delim && delimiters.includes(g.delim)) delims.set(g.delim, (delims.get(g.delim) || 0) + 1);
  }
  if (!delims.size) return '';
  const d = firstMaxKey(delims);
  return d === '\n' ? '' : d;
}
function guessDelimiter(data, delimiters) {
  const lines = data.split('\n').filter(Boolean);
  const chunkLength = Math.min(10, lines.length);
  let iteration = 0;
  const charFrequency = new Map();
  const modes = new Map();
  const delims = new Map();
  let start = 0;
  let end = chunkLength;
  while (start < lines.length) {
    iteration++;
    for (const line of lines.slice(start, end)) {
      const counts = new Array(127).fill(0);
      for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c < 127) counts[c]++; }
      for (let c = 0; c < 127; c++) {
        let meta = charFrequency.get(c);
        if (!meta) { meta = new Map(); charFrequency.set(c, meta); }
        meta.set(counts[c], (meta.get(counts[c]) || 0) + 1);
      }
    }
    for (const [c, meta] of charFrequency) {
      const items = [...meta.entries()];
      if (items.length === 1 && items[0][0] === 0) continue;
      if (items.length > 1) {
        let best = items[0];
        for (const it of items) if (it[1] > best[1]) best = it;
        let others = 0;
        for (const it of items) if (it !== best) others += it[1];
        modes.set(c, [best[0], best[1] - others]);
      } else {
        modes.set(c, items[0]);
      }
    }
    const total = Math.min(chunkLength * iteration, lines.length);
    let consistency = 1.0;
    while (delims.size === 0 && consistency >= 0.9) {
      for (const [c, v] of modes) {
        const k = String.fromCharCode(c);
        if (v[0] > 0 && v[1] > 0 && v[1] / total >= consistency && delimiters.includes(k)) delims.set(k, v);
      }
      consistency -= 0.01;
    }
    if (delims.size === 1) return [...delims.keys()][0];
    start = end;
    end += chunkLength;
  }
  if (!delims.size) return '';
  for (const d of [',', '\t', ';', ' ', ':']) if (delims.has(d)) return d;
  const items = [...delims.entries()].map(([k, v]) => [v, k]);
  items.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return items[items.length - 1][1];
}
/** csv.Sniffer().sniff(sample, delimiters).delimiter, or null for csv.Error. */
function sniffDelimiter(sample, delimiters) {
  const data = sample.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return guessQuoteAndDelimiter(data, delimiters) || guessDelimiter(data, delimiters) || null;
}

const CSV_FIELD_LIMIT = 131072;
/** csv.reader(io.StringIO(text), delimiter=delim) (excel dialect), first `limit` records. */
function csvRows(text, delim, limit) {
  const S_START_RECORD = 0; const S_START_FIELD = 1; const S_IN_FIELD = 2;
  const S_IN_QUOTED = 3; const S_QUOTE_IN_QUOTED = 4; const S_EAT_CRNL = 5;
  const rows = [];
  let pos = 0;
  const n = text.length;
  let fields; let field; let fieldLen; let state;
  const save = () => { fields.push(field); field = ''; fieldLen = 0; };
  const add = (c) => {
    if (fieldLen >= CSV_FIELD_LIMIT) fail(`field larger than field limit (${CSV_FIELD_LIMIT})`);
    field += c;
    fieldLen++;
  };
  const step = (c) => {                     // c === null is the end-of-line marker
    switch (state) {
      case S_START_RECORD:
        if (c === null) return;
        if (c === '\n' || c === '\r') { state = S_EAT_CRNL; return; }
        state = S_START_FIELD;
      // falls through
      case S_START_FIELD:
        if (c === '\n' || c === '\r' || c === null) { save(); state = c === null ? S_START_RECORD : S_EAT_CRNL; }
        else if (c === '"') state = S_IN_QUOTED;
        else if (c === delim) save();
        else { add(c); state = S_IN_FIELD; }
        return;
      case S_IN_FIELD:
        if (c === '\n' || c === '\r' || c === null) { save(); state = c === null ? S_START_RECORD : S_EAT_CRNL; }
        else if (c === delim) { save(); state = S_START_FIELD; }
        else add(c);
        return;
      case S_IN_QUOTED:
        if (c === null) return;
        if (c === '"') state = S_QUOTE_IN_QUOTED;
        else add(c);
        return;
      case S_QUOTE_IN_QUOTED:
        if (c === '"') { add(c); state = S_IN_QUOTED; }
        else if (c === delim) { save(); state = S_START_FIELD; }
        else if (c === '\n' || c === '\r' || c === null) { save(); state = c === null ? S_START_RECORD : S_EAT_CRNL; }
        else { add(c); state = S_IN_FIELD; }
        return;
      default:                                // S_EAT_CRNL
        if (c === '\n' || c === '\r') return;
        if (c === null) { state = S_START_RECORD; return; }
        fail("new-line character seen in unquoted field - do you need to open the file with newline=''?");
    }
  };
  const recordOpen = () => state !== S_START_RECORD;   // a quoted field spans lines
  while (rows.length < limit) {                        // Reader.__next__
    fields = []; field = ''; fieldLen = 0; state = S_START_RECORD;
    let eof = false;
    do {
      if (pos >= n) {
        if (fieldLen !== 0 || state === S_IN_QUOTED) { save(); break; }
        eof = true;
        break;
      }
      let e = text.indexOf('\n', pos);                 // io.StringIO splits on '\n' only
      e = e < 0 ? n : e + 1;
      const line = text.slice(pos, e);
      pos = e;
      for (const c of line) step(c);
      step(null);
    } while (recordOpen());
    if (eof) break;
    rows.push(fields);
  }
  return rows;
}
function pathStem(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}
function readCsv(name, data) {
  const text = decodeBytes(data);
  const sample = cpPrefix(text, 5000);
  let delim = sniffDelimiter(sample, ',;\t|');
  if (delim === null) delim = sample.split('\t').length > sample.split(',').length ? '\t' : ',';
  const rows = csvRows(text, delim, MAX_ROWS).map((r) => (r.length > MAX_COLS ? r.slice(0, MAX_COLS) : r));
  return [{ name: pathStem(name), rows, width: null }];
}

// ───────────────────────── ZIP (bounded central-directory reader) ─────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(u8) {
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const u16le = (b, p) => b[p] | (b[p + 1] << 8);
const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u64le = (b, p) => u32le(b, p) + u32le(b, p + 4) * 0x100000000;

/** zipfile.ZipFile(...) for reading: same validation as CPython 3.13 (+ CRC check on read). */
function zipOpen(data) {
  const n = data.length;
  const SIG_EOCD = 0x06054b50;
  // _EndRecData
  const endRec = (p) => ({ size: u32le(data, p + 12), offset: u32le(data, p + 16), location: p });
  let end = null;
  if (n >= 22 && u32le(data, n - 22) === SIG_EOCD && data[n - 2] === 0 && data[n - 1] === 0) end = endRec(n - 22);
  else if (n >= 22) {
    const lo = Math.max(n - 65535 - 22, 0);
    for (let q = n - 4; q >= lo; q--) {
      if (u32le(data, q) === SIG_EOCD) { end = q + 22 <= n ? endRec(q) : null; break; }
    }
  }
  if (!end) fail('File is not a zip file');
  // _EndRecData64
  let off = end.location - 20;
  if (off >= 0 && u32le(data, off) === 0x07064b50) {
    const reloff = u64le(data, off + 8);
    if (u32le(data, off + 4) !== 0 || u32le(data, off + 16) > 1) fail('zipfiles that span multiple disks are not supported');
    off -= 56;
    if (reloff > off) fail('Corrupt zip64 end of central directory locator');
    let base = reloff;
    let extrasz = off - reloff;
    if (base + 56 > n) fail('File is not a zip file');
    if (u32le(data, base) !== 0x06064b50 && reloff !== off) { base = off; extrasz = 0; }
    if (u32le(data, base) !== 0x06064b50) fail('Zip64 end of central directory record not found');
    const dirsize = u64le(data, base + 40);
    const diroffset = u64le(data, base + 48);
    if (diroffset + dirsize !== reloff || u64le(data, base + 4) + 12 !== 56 + extrasz) {
      fail('Corrupt zip64 end of central directory record');
    }
    end = { size: dirsize, offset: diroffset, location: off - extrasz };
  }
  // _RealGetContents
  const concat = end.location - end.size - end.offset;
  const startDir = end.offset + concat;
  if (startDir < 0) fail('Bad offset for central directory');
  const cd = data.subarray(startDir, startDir + end.size);
  const nameOf = (bytes, utf8) => (utf8 ? decodeUtf8(bytes, true) : decodeCp437(bytes));
  const entries = [];
  for (let p = 0; p < end.size;) {
    if (p + 46 > cd.length) fail('Truncated central directory');
    if (u32le(cd, p) !== 0x02014b50) fail('Bad magic number for central directory');
    const flags = u16le(cd, p + 8);
    const fnLen = u16le(cd, p + 28);
    const exLen = u16le(cd, p + 30);
    const cmLen = u16le(cd, p + 32);
    if (cd[p + 6] > 63) fail(`zip file version ${(cd[p + 6] / 10).toFixed(1)}`);
    const orig = nameOf(cd.subarray(p + 46, p + 46 + fnLen), flags & 0x800);
    const nul = orig.indexOf('\u0000');
    const ent = {
      orig, name: nul >= 0 ? orig.slice(0, nul) : orig, flags, method: u16le(cd, p + 10),
      crc: u32le(cd, p + 16), csize: u32le(cd, p + 20), usize: u32le(cd, p + 24), offset: u32le(cd, p + 42),
    };
    // ZipInfo._decodeExtra
    let x = cd.subarray(p + 46 + fnLen, p + 46 + fnLen + exLen);
    while (x.length >= 4) {
      const tp = u16le(x, 0);
      const ln = u16le(x, 2);
      if (ln + 4 > x.length) fail(`Corrupt extra field ${tp.toString(16).padStart(4, '0')} (size=${ln})`);
      if (tp === 0x0001) {
        let q = 4;
        const take = (what) => { if (q + 8 > ln + 4) fail(`Corrupt zip64 extra field. ${what} not found.`); const v = u64le(x, q); q += 8; return v; };
        if (ent.usize === 0xffffffff) ent.usize = take('File size');
        if (ent.csize === 0xffffffff) ent.csize = take('Compress size');
        if (ent.offset === 0xffffffff) ent.offset = take('Header offset');
      } else if (tp === 0x7075) {
        if (ln < 5) fail('Corrupt unicode path extra field (0x7075)');
        if (x[4] === 1 && u32le(x, 5) === crc32(cd.subarray(p + 46, p + 46 + fnLen))) {
          let up;
          try { up = decodeUtf8(x.subarray(9, ln + 4), true); } catch { fail('Corrupt unicode path extra field (0x7075): invalid utf-8 bytes'); }
          if (up) { const z = up.indexOf('\u0000'); ent.name = z >= 0 ? up.slice(0, z) : up; }
        }
      }
      x = x.subarray(ln + 4);
    }
    ent.offset += concat;
    entries.push(ent);
    p += 46 + fnLen + exLen + cmLen;
  }
  // _end_offset of each entry (overlap detection)
  let endOffset = startDir;
  [...entries].sort((e1, e2) => e1.offset - e2.offset).reverse().forEach((e) => { e.endOffset = endOffset; endOffset = e.offset; });
  const byName = new Map(entries.map((e) => [e.name, e]));     // NameToInfo: last entry wins
  return {
    entries,
    has: (nm) => byName.has(nm),
    read(nm) {                                                   // ZipFile.read
      const ent = byName.get(nm);
      if (!ent) fail(`There is no item named '${nm}' in the archive`);
      const lh = ent.offset;
      if (lh < 0 || lh + 30 > n) fail('Truncated file header');
      if (u32le(data, lh) !== 0x04034b50) fail('Bad magic number for file header');
      const lfn = u16le(data, lh + 26);
      const start = lh + 30 + lfn + u16le(data, lh + 28);
      if (ent.flags & 0x20) fail('compressed patched data (flag bit 5)');
      if (ent.flags & 0x40) fail('strong encryption (flag bit 6)');
      if (nameOf(data.subarray(lh + 30, lh + 30 + lfn), u16le(data, lh + 6) & 0x800) !== ent.orig) {
        fail(`File name in directory '${ent.orig}' and header differ.`);
      }
      if (start + ent.csize > ent.endOffset && ent.endOffset !== ent.offset) fail(`Overlapped entries: '${ent.orig}' (possible zip bomb)`);
      if (ent.flags & 1) fail(`File '${nm}' is encrypted, password required for extraction`);
      if (ent.method !== 0 && ent.method !== 8) fail(`compression type ${ent.method} is not supported`);
      const comp = data.subarray(start, start + ent.csize);
      if (comp.length < ent.csize) fail(`Truncated data for '${nm}'`);
      // ZipExtFile: output is capped at the declared size and a deflate stream that ends early is
      // accepted as far as it goes (zlib decompressobj + flush); the CRC decides.
      let out;
      if (ent.method === 0) out = comp.subarray(0, ent.usize);
      else {
        // streamed in 16 KB steps and stopped once the declared size is reached: a member that lies about
        // its size (a zip bomb) costs at most one step beyond it, never the whole stream (inflateSync with a
        // fixed buffer keeps decoding into nothing until the end)
        const parts = [];
        let got = 0;
        const inf = new Inflate();
        inf.ondata = (d) => { parts.push(d); got += d.length; };
        try {
          for (let k = 0; k < comp.length && got < ent.usize; k += 16384) {
            const end = Math.min(comp.length, k + 16384);
            inf.push(comp.subarray(k, end), end >= comp.length);
          }
        } catch (e) {
          if (!/unexpected EOF/i.test(errMsg(e))) fail(`Error -3 while decompressing data: ${errMsg(e)}`);
        }
        out = new Uint8Array(Math.min(got, ent.usize));
        let o = 0;
        for (const d of parts) { if (o >= out.length) break; out.set(d.subarray(0, out.length - o), o); o += d.length; }
      }
      if (crc32(out) !== ent.crc) fail(`Bad CRC-32 for file '${nm}'`);
      return out;
    },
  };
}
/** cp437 (zipfile's default for names without the UTF-8 flag). */
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const decodeCp437 = (bytes) => Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join('');

// ─────────────────────────────── xlsx (openpyxl) ───────────────────────────────
const NS_MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}';
const NS_REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}';
const CT_SHARED_STRINGS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml';
const CT_WORKBOOKS = [   // _find_workbook_part order: XLTM, XLTX, XLSM, XLSX
  'application/vnd.ms-excel.template.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
];
const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'mm-dd-yy', 15: 'd-mmm-yy',
  16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yy h:mm', 37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)', 41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_)_("$"* \\(#,##0.00\\)_("$"* "-"??_)_(@_)', 45: 'mm:ss', 46: '[h]:mm:ss',
  47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};
function isDateFormat(fmt) {                    // openpyxl.styles.numbers.is_date_format
  if (fmt === null || fmt === undefined) return false;
  const f = fmt.split(';')[0].replace(/".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g, '');
  return /(?<![_\\])[dmhysDMHYS]/.test(f);
}
const isTimedeltaFormat = (fmt) => (fmt === null || fmt === undefined ? false
  : /\[hh?\](:mm(:ss(\.0*)?)?)?|\[mm?\](:ss(\.0*)?)?|\[ss?\](\.0*)?/i.test(fmt.split(';')[0]));

/** openpyxl Text.from_tree(node).content for an <si>/<is> element of xmlTree(). */
function richTextContent(el) {
  let plain = null;
  const runs = [];
  for (const c of childElements(el)) {
    const ln = localName(c.tag);
    if (ln === 't') plain = elText(c);
    else if (ln === 'r') {
      let t = null;
      for (const rc of childElements(c)) if (localName(rc.tag) === 't') t = elText(rc);
      runs.push(t);
    }
  }
  return (plain ?? '') + runs.filter((t) => t !== null).join('');
}

function readSharedStrings(bytes) {
  const strings = [];
  const SI = `${NS_MAIN}si`;
  const stack = [];          // nested <si> are handled like iterparse end events
  xmlParse(decodeXmlBytes(bytes), {
    start(tag, attrs) {
      const el = { tag, attrs, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(el);
      if (stack.length || tag === SI) stack.push(el);
    },
    end(tag) {
      if (!stack.length) return;
      const el = stack.pop();
      if (tag === SI) strings.push(richTextContent(el).split('x005F_').join(''));
    },
    text(s) { if (stack.length) stack[stack.length - 1].children.push(s); },
  });
  return strings;
}
function relsPath(path) {                        // get_rels_path
  const i = path.lastIndexOf('/');
  return `${i >= 0 ? path.slice(0, i) : ''}${i >= 0 ? '/' : ''}_rels/${path.slice(i + 1)}.rels`;
}
function normPath(p) {                           // posixpath.normpath (relative paths)
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/') || '.';
}
function readRels(zip, path) {                    // get_dependents(...).to_dict()
  const root = xmlTree(decodeXmlBytes(zip.read(path)));
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
  const rels = new Map();
  for (const el of childElements(root)) {
    if (localName(el.tag) !== 'Relationship') continue;
    let target = el.attrs.Target ?? '';
    if (el.attrs.TargetMode !== 'External') {
      target = target.startsWith('/') ? target.slice(1) : normPath(parent ? `${parent}/${target}` : target);
    }
    rels.set(el.attrs.Id, { target, type: el.attrs.Type ?? '' });
  }
  return rels;
}
const pyBoolAttr = (v) => v !== undefined && v !== '' && !['false', 'f', '0'].includes(v);

/** openpyxl.utils.datetime.from_excel (raises RangeError where Python overflows). */
function fromExcel(value, mac, timedelta) {
  if (typeof value === 'bigint' || !Number.isFinite(value)) throw new RangeError('overflow');
  if (timedelta) {
    let td = timedeltaFromDays(value);
    if (td.us) {
      const total = td.days * 86400 + td.seconds + td.us / 1e6;
      const ms = pyRoundInt(td.us / 1000) * 1000;
      const whole = Math.floor(total);
      let d = Math.floor(whole / 86400);
      let s = whole - d * 86400;
      let us = ms;
      if (us >= 1e6) { us -= 1e6; s += 1; if (s >= 86400) { s -= 86400; d += 1; } }
      td = new PyTimedelta(d, s, us);
    }
    return td;
  }
  const day = Math.floor(value);
  const fraction = value - day;
  const ms = pyRoundInt(fraction * 86400 * 1000);
  const diffDays = Math.floor(ms / 86400000);
  const diffMs = ms - diffDays * 86400000;
  if (value >= 0 && value < 1 && diffDays === 0) {
    const us = (diffMs % 1000) * 1000;
    let t = Math.floor(diffMs / 1000);
    const s = t % 60; t = (t - s) / 60;
    return new PyTime((t - (t % 60)) / 60, t % 60, s, us);
  }
  let d = day;
  if (!mac && value > 0 && value < 60) d += 1;
  const ord = (mac ? ymd2ord(1904, 1, 1) : ORD_1899_12_30) + d + diffDays;
  if (!(ord >= 1 && ord <= MAX_ORD)) throw new RangeError('overflow');
  return PyDateTime.fromOrdinal(ord, diffMs * 1000);
}
const RE_ISO = /^(?<date>(?<year>\p{Nd}{4})-(?<month>\p{Nd}{2})-(?<day>\p{Nd}{2}))?T?(?<time>(?<hour>\p{Nd}{2}):(?<minute>\p{Nd}{2})(?::(?<second>\p{Nd}{2})(?<micro>\.\p{Nd}{1,3})?)?)?Z?/u;
const RE_ISO_DURATION = /^PT(?:(?<hours>\p{Nd}+)H)?(?:(?<minutes>\p{Nd}+)M)?(?:(?<seconds>\p{Nd}+(?:\.\p{Nd}{1,3})?)S)?/u;
/** openpyxl.utils.datetime.from_ISO8601 (t="d" cells). */
function fromIso8601(str) {
  const m = RE_ISO.exec(str);
  if (m && (m.groups.date !== undefined || m.groups.time !== undefined)) {
    const g = m.groups;
    const num = (k) => (g[k] ? pyIntDigits(g[k]) : 0);
    const us = g.micro ? Math.trunc(pyFloat(g.micro) * 1_000_000) : 0;
    const [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(num);
    if ((g.time && (h > 23 || mi > 59 || s > 59)) || (g.date && !validYmd(y, mo, d))) fail(`Invalid datetime value ${str}`);
    if (!g.date) return new PyTime(h, mi, s, us);
    if (!g.time) return new PyDate(y, mo, d);
    return new PyDateTime(y, mo, d, h, mi, s, us);
  }
  const dm = RE_ISO_DURATION.exec(str);
  if (dm && Object.values(dm.groups).some((v) => v !== undefined)) {
    const g = dm.groups;
    const f = (k) => (g[k] ? pyFloat(g[k]) : 0);
    return timedeltaFromDays((f('hours') * 3600 + f('minutes') * 60 + f('seconds')) / 86400);
  }
  return fail(`Invalid datetime value ${str}`);
}
function columnIndexFromString(col) {           // openpyxl.utils.cell.column_index_from_string
  const msg = `'${col}' is not a valid column name. Column names are from A to ZZZ`;
  if (cpLen(col) > 3) fail(msg);
  const letters = Array.from(col.toUpperCase()).reverse().slice(0, 3);
  let idx = 0;
  let power = 1;
  for (const ch of letters) {
    const c = ch.charCodeAt(0);
    if (ch.length !== 1 || c < 65 || c > 90) fail(msg);
    idx += (c - 64) * power;
    power *= 26;
  }
  if (!(idx > 0 && idx < 18279)) fail(msg);
  return idx;
}
function coordinateToColumn(coord) {            // coordinate_to_tuple(...)[1]
  let idx = 0;
  while (idx < coord.length && !(coord.charCodeAt(idx) >= 48 && coord.charCodeAt(idx) <= 57)) idx++;
  if (idx === coord.length) idx = coord.length - 1;
  pyInt(coord.slice(idx));                       // int(row) must succeed
  return columnIndexFromString(coord.slice(0, idx));
}

function readXlsx(name, data) {
  const zip = zipOpen(data);
  if (zip.entries.reduce((a, x) => a + x.usize, 0) > MAX_UNZIPPED_BYTES) {
    throw new UnsupportedFile(`תוכן הקובץ גדול מדי: ${name}`);
  }
  // [Content_Types].xml
  const ct = xmlTree(decodeXmlBytes(zip.read('[Content_Types].xml')));
  const overrides = [];
  const defaults = [];
  for (const el of childElements(ct)) {
    const ln = localName(el.tag);
    if (ln === 'Override') overrides.push(el.attrs);
    else if (ln === 'Default') defaults.push(el.attrs);
  }
  const findCt = (t) => overrides.find((o) => o.ContentType === t);
  const ssPart = findCt(CT_SHARED_STRINGS);
  const shared = ssPart ? readSharedStrings(zip.read(String(ssPart.PartName ?? '').slice(1))) : [];
  let wbPart = null;
  for (const t of CT_WORKBOOKS) { wbPart = findCt(t); if (wbPart) break; }
  if (!wbPart) {
    if (!defaults.some((d) => CT_WORKBOOKS.includes(d.ContentType))) fail('File contains no valid workbook part');
    wbPart = { PartName: '/xl/workbook.xml' };
  }
  const wbPath = String(wbPart.PartName ?? '').slice(1);
  // workbook.xml
  const wb = xmlTree(decodeXmlBytes(zip.read(wbPath)));
  let mac = false;
  const sheets = [];
  for (const el of childElements(wb)) {
    const ln = localName(el.tag);
    if (ln === 'workbookPr') mac = pyBoolAttr(el.attrs.date1904);
    else if (ln === 'sheets') {
      for (const s of childElements(el)) sheets.push({ name: s.attrs.name, id: s.attrs[`${NS_REL}id`] ?? s.attrs.id });
    }
  }
  // ExcelReader.read_properties / read_custom / read_theme also read (and validate) these parts
  if (zip.has('docProps/core.xml')) {
    const core = xmlTree(decodeXmlBytes(zip.read('docProps/core.xml')));
    if (Object.keys(core.attrs).some((k) => !k.startsWith('{'))) fail("DocumentProperties: unexpected keyword argument");
    for (const el of childElements(core)) {
      if (!['created', 'modified', 'lastPrinted'].includes(localName(el.tag))) continue;
      const t = elText(el);
      if (t !== null && !(fromIso8601(t) instanceof PyDateTime)) fail("expected <class 'datetime.datetime'>");
    }
  }
  if (zip.has('docProps/custom.xml')) xmlTree(decodeXmlBytes(zip.read('docProps/custom.xml')));
  if (zip.has('xl/theme/theme1.xml')) zip.read('xl/theme/theme1.xml');
  // styles -> indexes of date / timedelta cell formats
  let dateFormats = new Set();
  let tdFormats = new Set();
  if (zip.has('xl/styles.xml')) {
    const st = xmlTree(decodeXmlBytes(zip.read('xl/styles.xml')));
    const custom = new Map();
    const xfs = [];
    for (const el of childElements(st)) {
      const ln = localName(el.tag);
      if (ln === 'numFmts') {
        for (const f of childElements(el)) {
          if (localName(f.tag) === 'numFmt') custom.set(Number(pyInt(f.attrs.numFmtId)), f.attrs.formatCode);
        }
      } else if (ln === 'cellXfs') {
        for (const x of childElements(el)) {
          if (localName(x.tag) === 'xf') xfs.push(x.attrs.numFmtId === undefined ? 0 : Number(pyInt(x.attrs.numFmtId)));
        }
      }
    }
    if (xfs.length) {
      dateFormats = new Set();
      tdFormats = new Set();
      xfs.forEach((id, idx) => {
        const fmt = custom.has(id) ? custom.get(id) : (BUILTIN_FORMATS[id] ?? null);
        if (isDateFormat(fmt)) dateFormats.add(idx);
        if (isTimedeltaFormat(fmt)) tdFormats.add(idx);
      });
    }
  }
  let rels = null;
  const tables = [];
  for (const sh of sheets) {
    if (!sh.id) continue;
    if (rels === null) rels = readRels(zip, relsPath(wbPath));
    const rel = rels.get(sh.id);
    if (!rel) fail(`KeyError: '${sh.id}'`);
    if (!zip.has(rel.target)) continue;
    const depRels = relsPath(rel.target);
    if (rel.type.includes('chartsheet')) {                    // ExcelReader.read_chartsheet
      const deps = zip.has(depRels) ? readRels(zip, depRels) : null;
      xmlTree(decodeXmlBytes(zip.read(rel.target)));
      if (deps === null) fail("'list' object has no attribute 'find'");
      for (const d of deps.values()) {
        if (d.type.endsWith('/drawing')) xmlTree(decodeXmlBytes(zip.read(d.target)));
      }
      continue;
    }
    if (zip.has(depRels)) readRels(zip, depRels);
    tables.push({
      name: sh.name,
      rows: readXlsxSheet(zip.read(rel.target), shared, dateFormats, tdFormats, mac),
      width: MAX_COLS,
    });
  }
  return tables;
}

/** WorkSheetParser.parse + ReadOnlyWorksheet._cells_by_row(values_only, max_col=256). */
function readXlsxSheet(bytes, shared, dateFormats, tdFormats, mac) {
  const ROW = `${NS_MAIN}row`;
  const V = `${NS_MAIN}v`;
  const IS = `${NS_MAIN}is`;
  const EMPTY = [];
  const rows = [];
  let counter = 1;
  let rowCounter = 0;
  const stack = [];   // frames: { tag, attrs, kind, parent, cells?, v?, is?, sub? }

  const parseCell = (c, colState) => {
    const a = c.attrs;
    const dataType = a.t ?? 'n';
    let styleId = a.s ?? 0;
    if (styleId !== 0 && styleId !== '') styleId = pyInt(styleId);
    let value = dataType === 'inlineStr' ? null : (c.v || null);
    let column;
    if (a.r) { column = coordinateToColumn(a.r); colState.col = column; } else { colState.col += 1; column = colState.col; }
    if (value !== null) {
      if (dataType === 'n') {
        value = /[.eE]/.test(value) ? pyFloat(value) ?? fail(`could not convert string to float: '${value}'`) : pyInt(value);
        if (dateFormats.has(styleId)) {
          try {
            value = fromExcel(value, mac, tdFormats.has(styleId));
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            value = '#VALUE!';
          }
        }
      } else if (dataType === 's') {
        let k = Number(pyInt(value));
        if (k < 0) k += shared.length;
        if (!(k >= 0 && k < shared.length)) fail('list index out of range');
        value = shared[k];
      } else if (dataType === 'b') {
        value = Boolean(pyInt(value));
      } else if (dataType === 'd') {
        value = fromIso8601(value);
      }
    } else if (dataType === 'inlineStr' && c.is) {
      value = richTextContent(c.is);
    }
    return [column, value];
  };
  const finishRow = (fr) => {
    const a = fr.attrs;
    if (a.r !== undefined) {
      try {
        rowCounter = Number(pyInt(a.r));
      } catch {
        const f = pyFloat(a.r);
        if (f === null) fail(`could not convert string to float: '${a.r}'`);
        if (!Number.isInteger(f)) fail(`${a.r} is not a valid row number`);
        rowCounter = f;
      }
    } else {
      rowCounter += 1;
    }
    const colState = { col: 0 };
    const row = [];
    for (const c of fr.cells) {
      const [column, value] = parseCell(c, colState);
      if (column >= 1 && column <= MAX_COLS) row[column - 1] = value;
    }
    const idx = rowCounter;
    while (counter < idx) {
      if (rows.length >= MAX_ROWS) throw STOP;
      rows.push(EMPTY);
      counter++;
    }
    if (counter <= idx) {
      if (rows.length >= MAX_ROWS) throw STOP;
      rows.push(row.some((v) => v !== null) ? row : EMPTY);
      counter++;
    }
  };
  try {
    xmlParse(decodeXmlBytes(bytes), {
      start(tag, attrs) {
        const parent = stack[stack.length - 1] || null;
        const fr = { tag, attrs, kind: null, parent };
        if (parent && parent.textOpen) parent.textOpen = false;      // .text ends at a child
        if (tag === ROW) { fr.kind = 'row'; fr.cells = []; }
        else if (parent && parent.kind === 'row') { fr.kind = 'cell'; fr.v = undefined; fr.is = null; }
        else if (parent && parent.kind === 'cell' && tag === V && parent.v === undefined) {
          fr.kind = 'v'; fr.text = ''; fr.textOpen = true;
        } else if (parent && parent.kind === 'cell' && tag === IS && parent.is === null) {
          fr.kind = 'is'; fr.el = { tag, attrs, children: [] };
        } else if (parent && (parent.kind === 'is' || parent.kind === 'isChild')) {
          fr.kind = 'isChild'; fr.el = { tag, attrs, children: [] };
          parent.el.children.push(fr.el);
        }
        stack.push(fr);
      },
      end() {
        const fr = stack.pop();
        const p = fr.parent;
        if (fr.kind === 'row') {
          finishRow(fr);
          if (p && p.kind === 'row') p.cells.push({ attrs: {}, v: undefined, is: null });  // cleared element
        } else if (fr.kind === 'cell') {
          p.cells.push(fr);
        } else if (fr.kind === 'v') {
          p.v = fr.text;
        } else if (fr.kind === 'is') {
          p.is = fr.el;
        }
      },
      text(s) {
        const fr = stack[stack.length - 1];
        if (!fr) return;
        if (fr.kind === 'v') { if (fr.textOpen) fr.text += s; } else if (fr.kind === 'is' || fr.kind === 'isChild') fr.el.children.push(s);
      },
    });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return rows;
}

// ─────────────────────────────── xls (CFB + BIFF8, like xlrd) ───────────────────────────────
/**
 * Return the bytes of the 'Workbook' (or 'Book') stream of an OLE2 compound file.
 * Mirrors xlrd.compdoc.CompDoc, including its validation (shared sector bookkeeping,
 * strict directory names) and its quirks (sector offsets are 512 + sid * sector_size; a
 * contiguous stream is read in place, so records may run past its declared size).
 */
function cfbWorkbookStream(buf) {
  const n = buf.length;
  if (n < 512) fail('OLE2 compound document is truncated');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const i32 = (p) => dv.getInt32(p, true);
  if (dv.getUint16(28, true) !== 0xfffe) fail('Expected "little-endian" marker');
  let ssz = dv.getUint16(30, true);
  let sssz = dv.getUint16(32, true);
  if (ssz > 20) ssz = 9;
  if (sssz > ssz) sssz = 6;
  const secSize = 2 ** ssz;
  const shortSecSize = 2 ** sssz;
  const ints = secSize >> 2;
  const nSecs = Math.ceil((n - 512) / secSize);              // mem_data_secs
  const seen = new Uint8Array(nSecs);
  const mark = (s, id, what) => {
    if (s >= nSecs) fail(`${what}: array index out of range (sector ${s})`);
    if (seen[s]) fail(`${what} corruption: seen[${s}] == ${seen[s]}`);
    seen[s] = id;
  };
  const fullSector = (sid) => {                               // unpack(fmt, mem[off:off+sec_size])
    const off = 512 + sid * secSize;
    if (off + secSize > n) fail(`unpack requires a buffer of ${secSize} bytes`);
    const out = new Int32Array(ints);
    for (let k = 0; k < ints; k++) out[k] = i32(off + 4 * k);
    return out;
  };
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  };
  // MSAT: header entries plus the DIFAT chain
  const msat = [];
  for (let k = 0; k < 109; k++) msat.push(i32(76 + 4 * k));
  const msatxFirst = i32(68);
  if (!(i32(72) === 0 && (msatxFirst === -2 || msatxFirst === -1 || msatxFirst === 0))) {
    let sid = msatxFirst;
    while (sid !== -2 && sid !== -1 && sid !== -4) {
      if (sid >= nSecs) fail(`MSAT extension: accessing sector ${sid} but only ${nSecs} in file`);
      if (sid < 0) fail(`MSAT extension: invalid sector id: ${sid}`);
      mark(sid, 1, 'MSAT');
      const sec = fullSector(sid);
      for (let k = 0; k < ints; k++) msat.push(sec[k]);
      sid = msat.pop();
    }
  }
  // SAT
  const satParts = [];
  for (const msid of msat) {
    if (msid === -1 || msid === -2 || msid >= nSecs) continue;   // >= nSecs: truncated file, ignored
    if (msid < -2) fail(`MSAT: invalid sector id: ${msid}`);
    mark(msid, 2, 'MSAT extension');
    satParts.push(fullSector(msid));
  }
  const sat = new Int32Array(satParts.length * ints);
  satParts.forEach((x, k) => sat.set(x, k * ints));
  /** CompDoc._get_stream: chain of sectors (short reads allowed); size null = whole sectors. */
  const getStream = (mem, base, table, ss, start, size, what, seenId) => {
    const parts = [];
    let s = start;
    let todo = size;
    while (s >= 0) {
      if (seenId) mark(s, seenId, what);
      else if (parts.length > table.length) fail(`${what}: sector chain loops`);
      let grab = ss;
      if (size !== null) { if (grab > todo) grab = todo; todo -= grab; }
      const off = base + s * ss;
      parts.push(mem.subarray(Math.min(off, mem.length), Math.min(off + Math.max(grab, 0), mem.length)));
      if (s >= table.length) fail(`OLE2 stream '${what}': sector allocation table invalid entry (${s})`);
      s = table[s];
    }
    if (s !== -2) fail(`OLE2 stream '${what}': chain does not end with ENDOFCHAIN`);
    return concat(parts);
  };
  // directory
  const dirBytes = getStream(buf, 512, sat, secSize, i32(48), null, 'directory', 3);
  const entries = [];
  for (let p = 0; p < dirBytes.length; p += 128) {
    const d = dirBytes.subarray(p, p + 128);
    if (d.length < 124) fail('unpack requires a buffer of 8 bytes (directory entry)');
    const cbuf = d[64] | (d[65] << 8);
    let name = '';
    if (cbuf) {
      let e = cbuf - 2;
      if (e < 0) e += d.length;                               // Python negative slice index
      name = decodeUtf16(d.subarray(0, Math.min(e, d.length)), false, true, true);
    }
    entries.push({ did: entries.length, name, type: d[66], left: i32v(d, 68), right: i32v(d, 72),
      child: i32v(d, 76), start: i32v(d, 116), size: i32v(d, 120), children: [] });
  }
  if (!entries.length) fail('list index out of range (empty OLE2 directory)');
  let steps = 0;
  const buildTree = (parent, child, depth) => {               // _build_family_tree
    if (child < 0) return;
    if (depth > 950 || ++steps > 1e6) fail('maximum recursion depth exceeded (OLE2 directory)');
    if (child >= entries.length) fail('list index out of range (OLE2 directory)');
    buildTree(parent, entries[child].left, depth + 1);
    entries[parent].children.push(child);
    buildTree(parent, entries[child].right, depth + 1);
    if (entries[child].type === 1) buildTree(child, entries[child].child, depth + 1);
  };
  buildTree(0, entries[0].child, 0);
  const root = entries[0];
  if (root.type !== 5) fail('AssertionError: OLE2 root entry');
  const sscs = root.start < 0 || root.size === 0 ? new Uint8Array(0)
    : getStream(buf, 512, sat, secSize, root.start, root.size, 'SSCS', 4);
  let ssat = new Int32Array(0);
  if (root.size > 0) {
    const parts = [];
    let sid = i32(60);
    let nsecs = i32(64);
    while (sid >= 0 && nsecs > 0) {
      mark(sid, 5, 'SSAT');
      nsecs -= 1;
      parts.push(fullSector(sid));
      if (sid >= sat.length) fail('list index out of range (SAT)');
      sid = sat[sid];
    }
    if (!(nsecs === 0 && sid === -2)) fail('AssertionError: SSAT chain');
    ssat = new Int32Array(parts.length * ints);
    parts.forEach((x, k) => ssat.set(x, k * ints));
  }
  const minSizeStd = i32(56);
  const memDataLen = n - 512;
  for (const qname of ['Workbook', 'Book']) {
    let d = null;
    for (const k of root.children) {
      const e = entries[k];
      if (e.name.toLowerCase() !== qname.toLowerCase()) continue;
      if (e.type === 2) { d = e; break; }
      if (e.type === 1) fail("Requested component is a 'storage'");
      fail("Requested stream is not a 'user stream'");
    }
    if (!d) continue;
    if (d.size > memDataLen) fail(`'${qname}' stream length (${d.size} bytes) > file data size (${memDataLen} bytes)`);
    let stream;
    if (d.size >= minSizeStd) {                                // _locate_stream
      let s = d.start;
      if (s < 0) fail(`_locate_stream: start_sid (${s}) is -ve`);
      if (d.did + 6 > 255) fail('unsigned byte integer is greater than maximum');
      const limit = Math.floor((d.size + secSize - 1) / secSize);
      let prev = -99;
      let a = -9999;
      let b = -8888;
      const slices = [];
      let found = 0;
      while (s >= 0) {
        mark(s, d.did + 6, qname);
        if (++found > limit) fail(`${qname}: size exceeds expected ${limit * secSize} bytes; corrupt?`);
        if (s === prev + 1) b += secSize;
        else {
          if (prev >= 0) slices.push([a, b]);
          a = 512 + s * secSize;
          b = a + secSize;
        }
        prev = s;
        if (s >= sat.length) fail('list index out of range (SAT)');
        s = sat[s];
      }
      if (s !== -2 || found !== limit) fail(`AssertionError: '${qname}' sector chain`);
      if (!slices.length) stream = buf.subarray(Math.min(a, n));
      else {
        slices.push([a, b]);
        stream = concat(slices.map(([x, y]) => buf.subarray(Math.min(x, n), Math.min(y, n))));
      }
    } else {
      stream = getStream(sscs, 0, ssat, shortSecSize, d.start, d.size, `${qname} (from SSCS)`, 0);
    }
    if (stream.length) return stream;                          // `if self.mem: break`
  }
  return fail("Can't find workbook in OLE2 compound document");
}
const i32v = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24));

// BIFF record ids
const R_FORMULA = 0x0006; const R_EOF = 0x000a; const R_DATEMODE = 0x0022; const R_FILEPASS = 0x002f;
const R_CONTINUE = 0x003c; const R_BOUNDSHEET = 0x0085; const R_MULRK = 0x00bd; const R_RSTRING = 0x00d6;
const R_XF = 0x00e0; const R_SST = 0x00fc; const R_LABELSST = 0x00fd; const R_DIMENSION = 0x0200;
const R_NUMBER = 0x0203; const R_LABEL = 0x0204; const R_BOOLERR = 0x0205; const R_FORMULA3 = 0x0206;
const R_STRING = 0x0207; const R_STRING_B2 = 0x0007; const R_RK = 0x027e; const R_FORMULA4 = 0x0406;
const R_FORMAT = 0x041e; const R_SHRFMLA = 0x04bc; const R_ARRAY = 0x0221;
const BOF_CODES = [0x0809, 0x0409, 0x0209, 0x0009];
const SHRFMLA_ETC = [R_SHRFMLA, R_ARRAY, 0x0236, 0x0037, 0x0021, 0x0036];
// xlrd cell types
const XL_EMPTY = 0; const XL_TEXT = 1; const XL_NUMBER = 2; const XL_DATE = 3; const XL_BOOLEAN = 4; const XL_ERROR = 5;

/** std_format_code_types of xlrd: true = date */
function stdFormatIsDate(k) {
  return (k >= 14 && k <= 22) || (k >= 27 && k <= 36) || (k >= 45 && k <= 47) || (k >= 50 && k <= 58) || (k >= 71 && k <= 81);
}
const STD_FORMAT_KEYS = [];
for (const [a, b] of [[0, 0], [1, 13], [14, 22], [27, 36], [37, 44], [45, 47], [48, 48], [49, 49], [50, 58], [59, 62], [67, 70], [71, 81]]) {
  for (let k = a; k <= b; k++) STD_FORMAT_KEYS.push(k);
}
/** xlrd formatting.is_date_format_string */
function xlrdIsDateFormat(fmt) {
  let state = 0;
  let s = '';
  for (const c of fmt) {
    if (state === 0) {
      if (c === '"') state = 1;
      else if ('\\_*'.includes(c)) state = 2;
      else if (!'$-+/(): '.includes(c)) s += c;
    } else if (state === 1) {
      if (c === '"') state = 0;
    } else {
      state = 0;
    }
  }
  s = s.replace(/\[[^\]]*\]/g, '');
  if (['0.00E+00', '##0.0E+0', 'General', 'GENERAL', 'general', '@'].includes(s)) return false;
  let dateCount = 0;
  let numCount = 0;
  for (const c of s) {
    if ('ymdhsYMDHS'.includes(c)) dateCount += 5;
    else if ('0#?'.includes(c)) numCount += 5;
  }
  if (dateCount && !numCount) return true;
  if (numCount && !dateCount) return false;
  return dateCount > numCount;
}

class BiffStream {
  constructor(data) { this.d = data; this.pos = 0; }
  peekCode() { return this.pos + 4 <= this.d.length ? u16le(this.d, this.pos) : -1; }
  next() {
    const p = this.pos;
    if (p < 0 || p + 4 > this.d.length) fail('unpack requires a buffer of 4 bytes (BIFF stream truncated)');
    const code = u16le(this.d, p);
    const len = u16le(this.d, p + 2);
    this.pos = p + 4 + len;
    return { code, data: this.d.subarray(p + 4, p + 4 + len) };
  }
}
const need = (data, n) => { if (data.length < n) fail(`unpack requires a buffer of ${n} bytes`); };
const latin1Of = (b) => decodeLatin1(b);
const utf16Of = (b) => decodeUtf16(b, false, true, true);
/** xlrd biffh.unpack_unicode */
function biffUnicode(data, pos, lenlen) {
  need(data, pos + lenlen);
  const nchars = lenlen === 1 ? data[pos] : u16le(data, pos);
  if (!nchars) return '';
  pos += lenlen;
  if (pos >= data.length) fail('index out of range');
  const options = data[pos];
  pos += 1;
  if (options & 0x08) pos += 2;
  if (options & 0x04) pos += 4;
  if (options & 0x01) return utf16Of(data.subarray(pos, pos + 2 * nchars));
  return latin1Of(data.subarray(pos, pos + nchars));
}
/** xlrd biffh.unpack_unicode_update_pos (lenlen=2) */
function biffUnicodePos(data, pos) {
  need(data, pos + 2);
  const nchars = u16le(data, pos);
  pos += 2;
  if (!nchars && pos >= data.length) return ['', pos];
  if (pos >= data.length) fail('index out of range');
  const options = data[pos];
  pos += 1;
  let rt = 0;
  let sz = 0;
  if (options & 0x08) { need(data, pos + 2); rt = u16le(data, pos); pos += 2; }
  if (options & 0x04) { need(data, pos + 4); sz = i32v(data, pos); pos += 4; }
  let s;
  if (options & 0x01) { s = utf16Of(data.subarray(pos, pos + 2 * nchars)); pos += 2 * nchars; } else { s = latin1Of(data.subarray(pos, pos + nchars)); pos += nchars; }
  if (options & 0x08) pos += 4 * rt;
  if (options & 0x04) pos += sz;
  return [s, pos];
}
/** xlrd book.unpack_SST_table */
function unpackSst(parts, nstrings) {
  let inx = 0;
  let data = parts[0];
  let pos = 8;
  const strings = [];
  const maxStrings = Math.floor(parts.reduce((a, p) => a + p.length, 0) / 3) + 1;
  for (let i = 0; i < nstrings; i++) {
    if (i > maxStrings) fail('SST: string count exceeds data');
    need(data, pos + 3);
    const nchars = u16le(data, pos);
    pos += 2;
    let options = data[pos];
    pos += 1;
    let rtcount = 0;
    let phosz = 0;
    if (options & 0x08) { need(data, pos + 2); rtcount = u16le(data, pos); pos += 2; }
    if (options & 0x04) { need(data, pos + 4); phosz = i32v(data, pos); pos += 4; }
    let acc = '';
    let got = 0;
    for (;;) {
      const needChars = nchars - got;
      let avail;
      if (options & 0x01) {
        avail = Math.min((data.length - pos) >> 1, needChars);
        acc += utf16Of(data.subarray(pos, pos + 2 * avail));
        pos += 2 * avail;
      } else {
        avail = Math.min(data.length - pos, needChars);
        acc += latin1Of(data.subarray(pos, pos + avail));
        pos += avail;
      }
      got += avail;
      if (got === nchars) break;
      inx += 1;
      if (inx >= parts.length) fail('SST: list index out of range');
      data = parts[inx];
      if (!data.length) fail('SST: index out of range');
      options = data[0];
      pos = 1;
    }
    for (let r = 0; r < rtcount; r++) {
      if (pos === data.length) {
        pos = 0;
        inx += 1;
        if (inx >= parts.length) fail('SST: list index out of range');
        data = parts[inx];
      }
      need(data, pos + 4);
      pos += 4;
    }
    pos += phosz;
    if (pos < 0) fail('SST: corrupt phonetic size');
    if (pos >= data.length) {
      pos -= data.length;
      inx += 1;
      if (inx < parts.length) data = parts[inx];
      else if (i !== nstrings - 1) fail('SST: data exhausted');
    }
    strings.push(acc);
  }
  return strings;
}
/** xlrd unpack_RK */
function unpackRk(b, p) {
  const flags = b[p];
  let v;
  if (flags & 2) v = i32v(b, p) >> 2;
  else {
    const t = new Uint8Array(8);
    t[4] = flags & 0xfc; t[5] = b[p + 1]; t[6] = b[p + 2]; t[7] = b[p + 3];
    v = new DataView(t.buffer).getFloat64(0, true);
  }
  return flags & 1 ? v / 100.0 : v;
}
function getBof(st, wantType) {
  const p = st.pos;
  const d = st.d;
  if (p < 0 || p + 2 > d.length) fail('Unsupported format, or corrupt file: Expected BOF record; met end of file');
  const opcode = u16le(d, p);
  if (!BOF_CODES.includes(opcode)) fail('Unsupported format, or corrupt file: Expected BOF record');
  if (p + 4 > d.length) fail('Unsupported format, or corrupt file: Incomplete BOF record');
  const length = u16le(d, p + 2);
  if (length < 4 || length > 20) fail(`Unsupported format, or corrupt file: Invalid length (${length}) for BOF record`);
  if (p + 4 + length > d.length) fail('Unsupported format, or corrupt file: Incomplete BOF record');
  const version2 = u16le(d, p + 4);
  const streamType = u16le(d, p + 6);
  st.pos = p + 4 + length;
  const biff8 = opcode === 0x0809 && version2 === 0x0600;
  if (!biff8) fail('גרסת Excel ישנה (BIFF2-BIFF7) אינה נתמכת — יש לשמור את הקובץ מחדש כ-xlsx');
  if (streamType !== wantType) {
    if (streamType === 0x0100) fail('Unsupported format, or corrupt file: Workspace file -- no spreadsheet data');
    fail('Unsupported format, or corrupt file: BOF not workbook/worksheet');
  }
}

/** xlrd.xldate_as_datetime -> PyDateTime | null (None = Python OverflowError/ValueError). */
function xldateAsDatetime(x, datemode) {
  if (!Number.isFinite(x)) return null;
  const epoch = datemode ? ymd2ord(1904, 1, 1) : (x < 60 ? ymd2ord(1899, 12, 31) : ORD_1899_12_30);
  const days = Math.trunc(x);
  const ms = pyRoundInt((x - days) * 86400000.0);
  const secs = Math.floor(ms / 1000);
  const msr = ms - secs * 1000;
  const extraDays = Math.floor(secs / 86400);
  const ord = epoch + days + extraDays;
  if (!(ord >= 1 && ord <= MAX_ORD)) return null;
  return PyDateTime.fromOrdinal(ord, (secs - extraDays * 86400) * 1e6 + msr * 1000);
}

function readXls(data) {
  const st = new BiffStream(cfbWorkbookStream(data));
  getBof(st, 0x0005);
  const formatMap = new Map();     // fmtkey -> isDate
  const xfKeys = [];
  const sheets = [];
  let sst = [];
  let datemode = 0;
  for (;;) {
    const { code, data: d } = st.next();
    if (code === R_EOF) break;
    if (code === R_SST) {
      need(d, 8);
      const parts = [d];
      while (st.peekCode() === R_CONTINUE) parts.push(st.next().data);
      sst = unpackSst(parts, i32v(d, 4));
    } else if (code === R_FORMAT) {
      need(d, 2);
      formatMap.set(u16le(d, 0), xlrdIsDateFormat(biffUnicode(d, 2, 2)));
    } else if (code === R_XF) {
      need(d, 20);
      if (!xfKeys.length) for (const k of STD_FORMAT_KEYS) if (!formatMap.has(k)) formatMap.set(k, stdFormatIsDate(k));
      xfKeys.push(u16le(d, 2));
    } else if (code === R_BOUNDSHEET) {
      need(d, 6);
      const name = biffUnicode(d, 6, 1);
      if (d[5] === 0) sheets.push({ name, pos: i32v(d, 0) });
    } else if (code === R_DATEMODE) {
      need(d, 2);
      datemode = u16le(d, 0);
      if (datemode !== 0 && datemode !== 1) fail('assert datemode in (0, 1)');
    } else if (code === R_FILEPASS) {
      fail('Workbook is encrypted');
    }
  }
  // xf_epilogue: unknown format -> TEXT (a number cell keeps its float value either way)
  const xfType = xfKeys.map((k) => (formatMap.has(k) ? (formatMap.get(k) ? XL_DATE : XL_NUMBER) : XL_TEXT));
  return sheets.map((sh) => readXlsSheet(st, sh, sst, xfType, datemode));
}

function readXlsSheet(st, sh, sst, xfType, datemode) {
  st.pos = sh.pos;
  getBof(st, 0x0010);
  // Sheet state, mirroring xlrd's put_cell_unragged (list lengths, nrows/ncols).
  const rowLens = [];
  const values = [];        // sparse: values[r][c] = [ctype, value]
  let nrows = 0;
  let ncols = 0;
  let firstFull = -1;
  const put = (r, c, ctype, value) => {
    if (r < rowLens.length && c < rowLens[r]) { (values[r] ||= [])[c] = [ctype, value]; return; }
    const nr = r + 1;
    const nc = c + 1;
    if (!(nc >= 1 && nc <= 256) || !(nr >= 1 && nr <= 65536)) fail('AssertionError: cell outside 65536 x 256');
    if (nc > ncols) {
      ncols = nc;
      if (nr < nrows) firstFull = -2;
      else if (r > firstFull && firstFull > -2) firstFull = r;
    }
    if (nr <= nrows) {
      if (r >= rowLens.length) fail('list index out of range');
      if (rowLens[r] < ncols) rowLens[r] = ncols;
    } else {
      for (let k = nrows; k < nr; k++) rowLens.push(ncols);
      nrows = nr;
    }
    if (!(r < rowLens.length && c < rowLens[r])) fail('list assignment index out of range');
    (values[r] ||= [])[c] = [ctype, value];
  };
  const numCell = (r, c, xf, v) => {
    if (!(xf >= 0 && xf < xfType.length)) fail(`KeyError: ${xf} (unknown XF index)`);
    put(r, c, xfType[xf], v);
  };
  for (;;) {
    const { code, data: d } = st.next();
    if (code === R_EOF) break;
    switch (code) {
      case R_NUMBER:
        need(d, 14);
        numCell(u16le(d, 0), u16le(d, 2), u16le(d, 4), new DataView(d.buffer, d.byteOffset + 6, 8).getFloat64(0, true));
        break;
      case R_LABELSST: {
        if (d.length !== 10) fail('unpack requires a buffer of 10 bytes');
        let k = i32v(d, 6);
        if (k < 0) k += sst.length;
        if (!(k >= 0 && k < sst.length)) fail('list index out of range');
        put(u16le(d, 0), u16le(d, 2), XL_TEXT, sst[k]);
        break;
      }
      case R_LABEL:
        need(d, 6);
        put(u16le(d, 0), u16le(d, 2), XL_TEXT, biffUnicode(d, 6, 2));
        break;
      case R_RSTRING: {
        need(d, 6);
        let [s, pos] = biffUnicodePos(d, 6);
        need(d, pos + 2);
        const nrt = u16le(d, pos);
        pos += 2 + 4 * nrt;
        if (pos !== d.length) fail('AssertionError (RSTRING)');
        put(u16le(d, 0), u16le(d, 2), XL_TEXT, s);
        break;
      }
      case R_RK:
        need(d, 10);
        numCell(u16le(d, 0), u16le(d, 2), u16le(d, 4), unpackRk(d, 6));
        break;
      case R_MULRK: {
        need(d, 6);
        const r = u16le(d, 0);
        const first = u16le(d, 2);
        const last = u16le(d, d.length - 2);
        let pos = 4;
        for (let c = first; c <= last; c++) {
          need(d, pos + 6);
          numCell(r, c, u16le(d, pos), unpackRk(d, pos + 2));
          pos += 6;
        }
        break;
      }
      case R_FORMULA: case R_FORMULA3: case R_FORMULA4: {
        need(d, 16);
        const r = u16le(d, 0);
        const c = u16le(d, 2);
        const xf = u16le(d, 4);
        if (d[12] === 0xff && d[13] === 0xff) {
          const kind = d[6];
          if (kind === 0) {                       // string result in the following STRING record
            let rec = st.next();
            if (rec.code !== R_STRING && rec.code !== R_STRING_B2) {
              if (!SHRFMLA_ETC.includes(rec.code)) fail(`Expected SHRFMLA, ARRAY, TABLEOP* or STRING record; found 0x${rec.code.toString(16)}`);
              rec = st.next();
              if (rec.code !== R_STRING && rec.code !== R_STRING_B2) fail(`Expected STRING record; found 0x${rec.code.toString(16)}`);
            }
            put(r, c, XL_TEXT, stringRecord(st, rec.data));
          } else if (kind === 1) put(r, c, XL_BOOLEAN, d[8]);
          else if (kind === 2) put(r, c, XL_ERROR, d[8]);
          else if (kind === 3) put(r, c, XL_TEXT, '');
          else fail(`unexpected special case (0x${kind.toString(16)}) in FORMULA`);
        } else {
          numCell(r, c, xf, new DataView(d.buffer, d.byteOffset + 6, 8).getFloat64(0, true));
        }
        break;
      }
      case R_BOOLERR:
        need(d, 8);
        if (d[7] > 1) fail('tuple index out of range');
        put(u16le(d, 0), u16le(d, 2), d[7] ? XL_ERROR : XL_BOOLEAN, d[6]);
        break;
      case R_DIMENSION: case 0x0000:
        if (!d.length) break;
        need(d, 12);
        nrows = 0;
        ncols = 0;
        break;
      default:
        if (BOF_CODES.includes(code)) {           // embedded chart: skip to its EOF
          need(d, 4);
          while (st.next().code !== R_EOF) { /* skip */ }
        }
    }
  }
  // tidy_dimensions (non-ragged) and the readers.py loop
  const ubound = firstFull === -2 ? nrows : firstFull;
  for (let r = 0; r < ubound; r++) {
    if (r >= rowLens.length) fail('list index out of range');
    if (rowLens[r] < ncols) rowLens[r] = ncols;
  }
  const width = Math.min(ncols, MAX_COLS);
  const rows = [];
  for (let r = 0; r < Math.min(nrows, MAX_ROWS); r++) {
    if (r >= rowLens.length || (width > 0 && rowLens[r] < width)) fail('list index out of range');
    const src = values[r];
    const out = [];
    if (src) {
      src.forEach(([ctype, v], c) => {
        if (c >= width || ctype === XL_EMPTY) return;
        out[c] = ctype === XL_DATE ? (xldateAsDatetime(v, datemode) ?? v) : v;
      });
    }
    rows.push(out);
  }
  return { name: sh.name, rows, width };
}
/** Sheet.string_record_contents (BIFF8) */
function stringRecord(st, data) {
  need(data, 2);
  const expected = u16le(data, 0);
  let offset = 2;
  let result = '';
  let found = 0;
  for (;;) {
    if (offset >= data.length) fail('index out of range (STRING)');
    const flag = data[offset] & 1;
    offset += 1;
    const chunk = flag ? utf16Of(data.subarray(offset)) : latin1Of(data.subarray(offset));
    result += chunk;
    found += cpLen(chunk);
    if (found === expected) return result;
    if (found > expected) fail(`STRING/CONTINUE: expected ${expected} chars, found ${found}`);
    const rec = st.next();
    if (rec.code !== R_CONTINUE) fail(`Expected CONTINUE record; found record-type 0x${rec.code.toString(16)}`);
    data = rec.data;
    offset = 0;
  }
}

// ═══════════════════════════════════ leumi.py ═════════════════════════════════════
const LEUMI_SPECS = [
  fieldSpec('value_date', ['תאריך ערך', 'ת. ערך', 'ת.ערך', 'יום ערך']),
  fieldSpec('date', ['תאריך', 'תאריך התנועה', 'תאריך פעולה', 'תאריך עסקה']),
  fieldSpec('extended', ['תיאור מורחב', 'פרטים נוספים', 'הערה', 'הערות']),
  fieldSpec('description', ['תיאור', 'תאור', 'תיאור התנועה', 'תיאור פעולה', 'פרטים', 'הפעולה', 'סוג פעולה', 'סוג תנועה']),
  fieldSpec('reference', ['אסמכתא', 'אסמכתה', 'מספר אסמכתא', 'אסמ']),
  fieldSpec('debit', ['בחובה', 'חובה', 'סכום חובה', 'משיכה', '=חיוב']),
  fieldSpec('credit', ['בזכות', 'זכות', 'סכום זכות', 'הפקדה', '=זיכוי']),
  fieldSpec('amount', ['=סכום', 'סכום התנועה', '=סכום בשח', 'סכום פעולה']),
  fieldSpec('balance', ['היתרה בשח', 'יתרה בשח', '=יתרה', '=היתרה', 'יתרה לאחר פעולה', 'יתרה משוערכת']),
];
const LEUMI_REQUIRED = ['date', 'description'];
const LEUMI_ANY_OF = ['debit', 'credit', 'amount'];
const LEUMI_SKIP_DESC = new Set(['יתרת פתיחה', 'יתרת סגירה', 'יתרה', 'סהכ', 'יתרה לתחילת התקופה', 'יתרה לסוף התקופה']);

function makeTxn(f) {
  return {
    source: f.source, account: f.account, date: f.date, charge_date: f.charge_date,
    description: f.description, amount: f.amount, orig_amount: f.orig_amount ?? null,
    orig_currency: f.orig_currency ?? null, reference: f.reference ?? null, balance: f.balance ?? null,
    txn_type: f.txn_type ?? null, notes: f.notes ?? null, ext_category: f.ext_category ?? null,
    installment_no: f.installment_no ?? null, installment_total: f.installment_total ?? null,
    day_seq: 0, uid: '', soft_key: null, pending: false,
  };
}

/** Fallback for header-less Leumi HTML: rows like [date, desc, ref, debit, credit, balance]. */
function leumiPositional(tables) {
  const out = [];
  for (const t of tables) {
    const hits = { 6: 0, 7: 0 };
    for (const row of t.rows) {
      const n = rowLen(t, row);
      if ((n === 6 || n === 7) && parseDate(cellAt(row, 0)) && parseAmount(cellAt(row, n - 1)) !== null) hits[n]++;
    }
    const n = hits[6] >= hits[7] ? 6 : 7;
    if (hits[n] >= 3) {
      const mp = Object.create(null);
      const cols = n === 6 ? ['date', 'description', 'reference', 'debit', 'credit', 'balance']
        : ['date', 'value_date', 'description', 'reference', 'debit', 'credit', 'balance'];
      cols.forEach((k, i) => { mp[k] = i; });
      out.push([t, mp]);
    }
  }
  return out;
}
function leumiDetect(tables) {
  let score = 0;
  for (const t of tables) {
    const m = findHeader(t, LEUMI_SPECS, LEUMI_REQUIRED, LEUMI_ANY_OF);
    if (m) {
      const bonus = ['balance', 'reference', 'debit', 'credit'].filter((k) => k in m.mapping).length;
      score = Math.max(score, m.score + bonus);
    }
  }
  if (score === 0 && leumiPositional(tables).length) score = 5;
  return score;
}
function leumiParse(tables) {
  const warnings = [];
  let jobs = [];
  for (const t of tables) {
    const m = findHeader(t, LEUMI_SPECS, LEUMI_REQUIRED, LEUMI_ANY_OF);
    if (m) jobs.push([t, m.mapping, m.row + 1]);
  }
  if (!jobs.length) jobs = leumiPositional(tables).map(([t, mp]) => [t, mp, 0]);
  const txns = [];
  for (const [table, mp, start] of jobs) {
    const block = [];
    const cell = (row, k) => cellOf(table, row, mp, k);
    for (let r = start; r < table.rows.length; r++) {
      const row = table.rows[r];
      if (rowLen(table, row) === 0) continue;
      const d = parseDate(cell(row, 'date'));
      if (!d) continue;
      let desc = cleanText(cell(row, 'description'));
      const ext = cleanText(cell(row, 'extended'));
      if (ext && ext !== desc) desc = desc ? `${desc} | ${ext}` : ext;
      if (LEUMI_SKIP_DESC.has(normHeader(desc))) continue;
      let amount;
      if ('amount' in mp && !('debit' in mp) && !('credit' in mp)) {
        amount = parseAmount(cell(row, 'amount'));
        if (amount === null) continue;
      } else {
        const debit = or0(parseAmount(cell(row, 'debit')));
        const credit = or0(parseAmount(cell(row, 'credit')));
        amount = Math.abs(credit) - Math.abs(debit);
      }
      if (Math.abs(amount) < 0.005 && !desc) continue;
      const iso = d.isoformat();
      block.push(makeTxn({
        source: 'leumi', account: 'leumi', date: iso, charge_date: iso,
        description: desc || '(ללא תיאור)', amount: pyRound2(amount),
        reference: cleanText(cell(row, 'reference')) || null,
        balance: parseAmount(cell(row, 'balance')),
      }));
    }
    // make the block chronological (exports are often newest-first)
    if (block.length >= 2 && block[0].date > block[block.length - 1].date) block.reverse();
    for (const t of block) txns.push(t);
  }
  const perDay = new Map();
  for (const t of txns) {
    t.day_seq = perDay.get(t.date) || 0;
    perDay.set(t.date, t.day_seq + 1);
  }
  if (!txns.length) warnings.push('לא נמצאו תנועות בקובץ לאומי');
  return [txns, warnings];
}

// ══════════════════════════════════ max_card.py ═══════════════════════════════════
const MAX_SPECS = [
  fieldSpec('charge_date', ['תאריך חיוב', 'מועד חיוב', 'תאריך החיוב']),
  fieldSpec('date', ['תאריך עסקה', 'תאריך רכישה', 'תאריך העסקה', '=תאריך']),
  fieldSpec('merchant', ['שם בית העסק', 'שם בית עסק', 'בית עסק', 'שם העסק', 'בית העסק']),
  fieldSpec('category', ['קטגוריה', 'ענף']),
  fieldSpec('card', ['4 ספרות אחרונות של כרטיס האשראי', 'ספרות אחרונות', '4 ספרות', 'מספר כרטיס', '=כרטיס']),
  fieldSpec('txn_type', ['סוג עסקה', 'סוג העסקה']),
  fieldSpec('orig_amount', ['סכום עסקה מקורי', 'סכום מקורי', 'סכום העסקה', 'סכום עסקה']),
  fieldSpec('orig_currency', ['מטבע עסקה מקורי', 'מטבע מקור', 'מטבע עסקה']),
  fieldSpec('charge_amount', ['סכום חיוב', 'סכום החיוב', '=סכום', 'סכום בשח']),
  fieldSpec('charge_currency', ['מטבע חיוב', 'מטבע החיוב']),
  fieldSpec('notes', ['הערות', 'הערה']),
];
const MAX_REQUIRED = ['date', 'merchant'];
const MAX_ANY_OF = ['charge_amount', 'orig_amount'];
const PENDING_SHEETS = ['טרם נקלטו', 'בתהליך', 'ממתינות'];

function maxDetect(tables) {
  let score = 0;
  for (const t of tables) {
    const m = findHeader(t, MAX_SPECS, MAX_REQUIRED, MAX_ANY_OF);
    if (m) {
      const bonus = 2 * ['card', 'charge_amount', 'charge_date'].filter((k) => k in m.mapping).length;
      score = Math.max(score, m.score + bonus);
    }
  }
  return score;
}
/** Last 4 digits of the card (str.isdigit() semantics, zfill(4)). */
function maxCard(v) {
  const digits = Array.from(cleanText(v)).filter(isPyDigitCp);
  if (!digits.length) return '0000';
  const last = digits.slice(-4);
  while (last.length < 4) last.unshift('0');
  return last.join('');
}
function maxParse(tables) {
  const txns = [];
  const warnings = [];
  for (const t of tables) {
    if (PENDING_SHEETS.some((p) => t.name.includes(p))) {
      warnings.push(`דולג על גיליון '${t.name}' (עסקאות שטרם נקלטו)`);
      continue;
    }
    const m = findHeader(t, MAX_SPECS, MAX_REQUIRED, MAX_ANY_OF);
    if (!m) continue;
    const cell = (row, k) => cellOf(t, row, m.mapping, k);
    for (let r = m.row + 1; r < t.rows.length; r++) {
      const row = t.rows[r];
      if (rowLen(t, row) === 0) continue;
      const d = parseDate(cell(row, 'date'));
      if (!d) continue;
      const merchant = cleanText(cell(row, 'merchant'));
      if (!merchant) continue;
      const cd = parseDate(cell(row, 'charge_date')) || d;
      let charge = parseAmount(cell(row, 'charge_amount'));
      const orig = parseAmount(cell(row, 'orig_amount'));
      const origCur = cleanText(cell(row, 'orig_currency')) || null;
      const chargeCur = cleanText(cell(row, 'charge_currency'));
      if (charge === null) {
        if (orig === null || !isIls(origCur)) continue;
        charge = orig;
      }
      const notes = cleanText(cell(row, 'notes')) || null;
      const ttype = cleanText(cell(row, 'txn_type')) || null;
      const [instNo, instTotal] = parseInstallment(notes, ttype);
      // a currency has no digits: in a PDF the heading "המרה למטבע החיוב" is over the rate and its date
      if (chargeCur && !/\d/.test(chargeCur) && !isIls(chargeCur)) warnings.push(`חיוב במטבע ${chargeCur} ב-${merchant} נרשם כשקלים`);
      txns.push(makeTxn({
        source: 'max', account: maxCard(cell(row, 'card')), date: d.isoformat(), charge_date: cd.isoformat(),
        description: merchant, amount: pyRound2(-charge), orig_amount: orig, orig_currency: origCur,
        txn_type: ttype, notes, ext_category: cleanText(cell(row, 'category')) || null,
        installment_no: instNo, installment_total: instTotal,
      }));
    }
  }
  if (!txns.length) warnings.push('לא נמצאו עסקאות בקובץ MAX');
  return [txns, warnings];
}

// ══════════════════════════════ models.py (uids) ══════════════════════════════════
function utf8Encode(str) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
  const out = [];
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
const toHex = (words) => words.map((w) => (w >>> 0).toString(16).padStart(8, '0')).join('');
/** Pad a message for SHA-1/SHA-256 (big-endian 64-bit bit length). */
function shaBlocks(bytes) {
  const n = bytes.length;
  const total = ((n + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(n / 0x20000000), false);
  dv.setUint32(total - 4, (n * 8) >>> 0, false);
  return dv;
}
function sha1Hex(str) {
  const dv = shaBlocks(utf8Encode(str));
  let h0 = 0x67452301; let h1 = 0xefcdab89; let h2 = 0x98badcfe; let h3 = 0x10325476; let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getInt32(off + 4 * t, false);
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let t = 0; t < 80; t++) {
      let f; let k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return toHex([h0, h1, h2, h3, h4]);
}
const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256HexJs(bytes) {
  const dv = shaBlocks(bytes);
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getInt32(off + 4 * t, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return toHex(Array.from(h));
}
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    try {
      const buf = await subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch { /* fall back (e.g. insecure context) */ }
  }
  return sha256HexJs(bytes);
}

/** models._h: SHA-1 of "|".join(str(p)) */
const hashParts = (parts) => sha1Hex(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|'));
/** models.assign_uids — identical rows inside one file get an occurrence index. */
function assignUids(txns) {
  const seen = new Map();
  const softSeen = new Map();
  // Counter key: an injective encoding of the tuple (each position always holds the same type;
  // installment numbers are ints or '', so String() cannot collide within a position).
  const bump = (map, key) => {
    const parts = key.map(String);
    const k = parts.some((x) => x.includes('\u0001')) ? JSON.stringify(key) : parts.join('\u0001');
    const v = (map.get(k) || 0) + 1;
    map.set(k, v);
    return v;
  };
  for (const t of txns) {
    const m = merchantKey(t.description);
    let base;
    if (t.source === 'max') {
      const orig = t.orig_amount === null ? '' : pyFormat2(t.orig_amount);
      base = ['max', t.account, t.date, t.charge_date, pyFormat2(t.amount), m, orig, t.orig_currency || '',
        t.installment_no || '', t.installment_total || ''];
      const soft = ['max', t.account, t.date, m, orig, t.orig_currency || '', t.installment_no || '', t.installment_total || ''];
      t.soft_key = hashParts([...soft, bump(softSeen, soft)]);
    } else {
      base = [t.source, t.date, pyFormat2(t.amount), m, t.reference || ''];
      t.soft_key = null;
    }
    t.uid = hashParts([...base, bump(seen, base)]);
  }
}

// ═══════════════════════════════ importer.py ══════════════════════════════════════
const PARSERS = { leumi: { detect: leumiDetect, parse: leumiParse }, max: { detect: maxDetect, parse: maxParse } };
const KIND_LABELS = { leumi: 'לאומי עו״ש', max: 'MAX אשראי' };
const errMsg = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  return null;
}

/** a statement saved as PDF: its tables, read by lib/pdf.js with the column names of both readers */
async function readPdf(data, password) {
  const { pdfTables } = await import('./pdf.js');
  const fields = [...LEUMI_SPECS, ...MAX_SPECS].map((sp) => sp.norm.map(([syn]) => syn));
  return pdfTables(data, { password, fields, norm: normHeader });
}
function looksPdf(data) {
  const head = data.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * Detect which kind of export a file is and parse it (port of importer.parse_file).
 * @param {string} name  file name (used in messages and as the CSV table name)
 * @param {Uint8Array} bytes  file content
 * @param {{password?: string}} [opts]  the password of a protected PDF (used here only, never kept)
 * @returns {Promise<{name: string, kind: 'leumi'|'max'|null, txns: object[], warnings: string[],
 *                    error: string|null, sha256: string, password?: 'needed'|'wrong'}>}
 */
export async function parseFile(name, bytes, opts = {}) {
  const full = String(name ?? '');
  const base = full.slice(Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\')) + 1);
  const pf = { name: base, kind: null, txns: [], warnings: [], error: null, sha256: '' };
  const data = toBytes(bytes);
  if (!data) {
    pf.error = 'שגיאה בקריאת הקובץ: התוכן אינו בייטים (Uint8Array)';
    return pf;
  }
  try {
    pf.sha256 = await sha256Hex(data);
  } catch {
    pf.sha256 = '';
  }
  let tables;
  if (looksPdf(data)) {
    if (data.length > MAX_FILE_BYTES) { pf.error = `הקובץ גדול מדי לקובץ בנק: ${base}`; return pf; }
    try {
      const out = await readPdf(data, opts && opts.password);
      if (!out.text) { pf.error = 'בקובץ אין טקסט, רק תמונה (למשל סריקה). צריך קובץ PDF שהורד מהאתר של הבנק או של MAX.'; return pf; }
      tables = out.tables;
    } catch (e) {
      if (e && e.name === 'PdfPasswordError') {
        pf.password = e.wrong ? 'wrong' : 'needed';
        pf.error = e.wrong ? 'הסיסמה של הקובץ שגויה' : 'הקובץ מוגן בסיסמה';
        return pf;
      }
      pf.error = `שגיאה בקריאת הקובץ: ${errMsg(e)}`;
      return pf;
    }
  } else {
    try {
      tables = readTables(base, data);
    } catch (e) {
      pf.error = e instanceof UnsupportedFile ? e.message : `שגיאה בקריאת הקובץ: ${errMsg(e)}`;
      return pf;
    }
  }
  let kind = null;
  let score = -Infinity;
  try {
    for (const k of ['leumi', 'max']) {
      const s = PARSERS[k].detect(tables);
      if (s > score) { kind = k; score = s; }
    }
  } catch (e) {
    pf.error = `שגיאה בקריאת הקובץ: ${errMsg(e)}`;
    return pf;
  }
  if (!(score > 0)) return pf;          // not a Leumi/MAX file
  pf.kind = kind;
  try {
    const [txns, warnings] = PARSERS[kind].parse(tables);
    pf.txns = txns;
    pf.warnings = warnings;
    assignUids(pf.txns);
  } catch (e) {
    pf.error = `שגיאה בפענוח קובץ ${KIND_LABELS[kind]}: ${errMsg(e)}`;
    pf.txns = [];
  }
  return pf;
}

/** Internals exposed for tests and diagnostics only (not a stable API). */
export const _internal = Object.freeze({
  readTables, merchantKey, cleanText, normHeader, parseDate, parseAmount, isIls, parseInstallment,
  pyFormat2, pyRound2, pyFloatRepr, maxCard, sha1Hex, sha256HexJs, htmlUnescape, sniffDelimiter,
  csvRows, pyFromIsoformat, decodeBytes, readPdf,
  LIMITS: Object.freeze({ MAX_ROWS, MAX_COLS, MAX_FILE_BYTES, MAX_UNZIPPED_BYTES }),
});
