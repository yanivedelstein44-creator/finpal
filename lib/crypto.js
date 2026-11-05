/* FinPal Family - keys, codes and encrypted envelopes. Runs in the browser and in Node 22 (WebCrypto).

   Household secret R (recovery code, 100 bits, 20 characters) -> PBKDF2 -> household AES-GCM key K + household id.
   Each partner's Drive file is sealed with K (AES-GCM, header authenticated as AAD).
   An invite carries R wrapped with a 12-character code (60 bits) that is told by voice, never sent with the link.
   On the phone itself the cached data is sealed with a non-extractable device key kept in IndexedDB. */

const te = new TextEncoder(), td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

// 32 symbols, no 0/O/1/I: easy to read aloud and to type
export const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const RECOVERY_LEN = 20;
export const INVITE_LEN = 12;
export const FILE_FMT = 'finpal-family';
const HOUSEHOLD_ITER = 200000;
const INVITE_ITER = 600000;
const PIN_ITER = 150000;

export class CryptoError extends Error {
  constructor(kind, msg) { super(msg || kind); this.kind = kind; }
}

export function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }

export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new CryptoError('format', 'bad base64');
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomCode(n) {
  // 256 is a multiple of 32, so masking keeps every symbol equally likely
  return Array.from(randomBytes(n), x => ALPHA[x & 31]).join('');
}

// letters typed while the Hebrew keyboard is active come out as Hebrew: map them back (standard Israeli layout)
const HEB = { 'ש': 'A', 'נ': 'B', 'ב': 'C', 'ג': 'D', 'ק': 'E', 'כ': 'F', 'ע': 'G', 'י': 'H', 'ן': 'I', 'ח': 'J', 'ל': 'K', 'ך': 'L',
  'צ': 'M', 'מ': 'N', 'ם': 'O', 'פ': 'P', '/': 'Q', 'ר': 'R', 'ד': 'S', 'א': 'T', 'ו': 'U', 'ה': 'V', "'": 'W', 'ס': 'X', 'ט': 'Y', 'ז': 'Z' };

export function normCode(s) {
  // dashes, spaces and characters that never appear in a code (0, O, 1, I) are dropped: a wrong length
  // then tells the person to check the code instead of silently guessing what was meant
  let out = '';
  for (const ch of String(s || '').toUpperCase()) {
    const c = HEB[ch] || ch;
    if (ALPHA.includes(c)) out += c;
  }
  return out;
}

export function groupCode(s, size) {
  const n = normCode(s), g = size || (n.length === RECOVERY_LEN ? 5 : 4);
  return (n.match(new RegExp(`.{1,${g}}`, 'g')) || []).join('-');
}

async function pbkdf2(secret, salt, iter, bits) {
  const base = await subtle().importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, bits));
}

const aesKey = (raw, usages = ['encrypt', 'decrypt']) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages);

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? te.encode(data) : data;
  return Array.from(new Uint8Array(await subtle().digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ household
export function newRecoveryCode() { return randomCode(RECOVERY_LEN); }

export function validRecovery(r) { return normCode(r).length === RECOVERY_LEN; }

/** R -> { key (AES-GCM, not extractable), hmac (for link tags), hid } */
export async function household(recovery) {
  const r = normCode(recovery);
  if (r.length !== RECOVERY_LEN) throw new CryptoError('code', 'recovery code must have 20 characters');
  const bits = await pbkdf2(r, te.encode('finpal-family/household/v1'), HOUSEHOLD_ITER, 768);
  const key = await aesKey(bits.slice(0, 32));
  const hmac = await subtle().importKey('raw', bits.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { key, hmac, hid: b64u(bits.slice(64, 76)) };
}

const headAad = h => te.encode(JSON.stringify({ fmt: h.fmt, v: h.v, hid: h.hid, by: h.by }));

/** seal bytes (already compressed) into the Drive file text */
export async function sealFile(hh, by, bytes) {
  const head = { fmt: FILE_FMT, v: 1, hid: hh.hid, by };
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: headAad(head) }, hh.key, bytes);
  return JSON.stringify(Object.assign({}, head, { iv: b64u(iv), ct: b64u(ct) }));
}

/** open a Drive file text; throws CryptoError('format' | 'household' | 'auth') */
export async function openFile(hh, text) {
  let env;
  try { env = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw new CryptoError('format', 'not json'); }
  if (!env || env.fmt !== FILE_FMT || env.v !== 1 || typeof env.ct !== 'string' || typeof env.iv !== 'string'
    || (env.by !== 'A' && env.by !== 'B')) throw new CryptoError('format', 'not a FinPal Family file');
  if (env.hid !== hh.hid) throw new CryptoError('household', 'file of another household');
  let iv, ct;
  try { iv = unb64u(env.iv); ct = unb64u(env.ct); } catch (e) { throw new CryptoError('format', 'bad encoding'); }
  if (iv.length !== 12 || ct.length < 16) throw new CryptoError('format', 'bad sizes');
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: headAad(env) }, hh.key, ct);
    return { by: env.by, bytes: new Uint8Array(pt) };
  } catch (e) { throw new CryptoError('auth', 'file was altered or the key is wrong'); }
}

// ------------------------------------------------------------------ links between the two phones
async function tag(hh, text) {
  return b64u(new Uint8Array(await subtle().sign('HMAC', hh.hmac, te.encode(text))).slice(0, 12));
}

/** "read my file here": sent by the second partner after the first save, or by either one after a file is made anew */
export async function connectPayload(hh, fileId, name, by) {
  const body = { v: 1, f: fileId, n: name || '', b: by === 'A' || by === 'B' ? by : '' };
  body.t = await tag(hh, `connect|${body.f}|${body.n}|${body.b}`);
  return b64u(te.encode(JSON.stringify(body)));
}

/** the link names who sent it, so a phone never takes its own file as the partner's */
export async function readConnect(hh, payload) {
  let body;
  try { body = JSON.parse(td.decode(unb64u(payload))); } catch (e) { throw new CryptoError('format', 'bad link'); }
  if (!body || body.v !== 1 || typeof body.f !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(body.f)) throw new CryptoError('format', 'bad link');
  const b = body.b === 'A' || body.b === 'B' ? body.b : '';
  if (typeof body.t !== 'string' || body.t !== await tag(hh, `connect|${body.f}|${body.n || ''}|${b}`)) throw new CryptoError('auth', 'link of another household');
  return { fileId: body.f, name: String(body.n || '').slice(0, 40), by: b };
}

const INVITE_FIELDS = ['v', 'n', 'p', 'cid', 'ak', 'f'];

/** invite: R wrapped with a short code; the code is shown to the inviter and must reach the partner by voice */
export async function makeInvite(recovery, info) {
  const code = randomCode(INVITE_LEN);
  const body = { v: 1, n: info.fromName || '', p: info.toName || '', cid: info.clientId || '', ak: info.apiKey || '', f: info.fileId || '' };
  const salt = randomBytes(16), iv = randomBytes(12);
  const wk = await aesKey(await pbkdf2(code, salt, INVITE_ITER, 256));
  const aad = te.encode(JSON.stringify(INVITE_FIELDS.map(k => body[k])));
  const w = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, wk, te.encode(normCode(recovery)));
  const payload = b64u(te.encode(JSON.stringify(Object.assign({}, body, { s: b64u(salt), i: b64u(iv), w: b64u(w) }))));
  return { code: groupCode(code, 4), payload };
}

/** read the visible part of an invite (names), without the code */
export function readInvite(payload) {
  let inv;
  try { inv = JSON.parse(td.decode(unb64u(payload))); } catch (e) { throw new CryptoError('format', 'bad invite'); }
  const str = v => typeof v === 'string';
  if (!inv || inv.v !== 1 || !INVITE_FIELDS.every(k => k === 'v' || str(inv[k])) || !str(inv.s) || !str(inv.i) || !str(inv.w))
    throw new CryptoError('format', 'bad invite');
  return inv;
}

export async function openInvite(inv, code) {
  const c = normCode(code);
  if (c.length !== INVITE_LEN) throw new CryptoError('code', 'invite code has 12 characters');
  let salt, iv, w;
  try { salt = unb64u(inv.s); iv = unb64u(inv.i); w = unb64u(inv.w); } catch (e) { throw new CryptoError('format', 'bad invite'); }
  const wk = await aesKey(await pbkdf2(c, salt, INVITE_ITER, 256));
  const aad = te.encode(JSON.stringify(INVITE_FIELDS.map(k => inv[k])));
  try {
    const r = td.decode(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad }, wk, w));
    if (!validRecovery(r)) throw new Error('bad');
    return normCode(r);
  } catch (e) { throw new CryptoError('code', 'wrong code'); }
}

// ------------------------------------------------------------------ this phone
export async function hashPin(pin, saltB64) {
  const salt = saltB64 ? unb64u(saltB64) : randomBytes(16);
  const h = await pbkdf2(String(pin), salt, PIN_ITER, 256);
  return { salt: b64u(salt), hash: b64u(h), iter: PIN_ITER };
}

export async function checkPin(pin, rec) {
  if (!rec || !rec.salt) return false;
  const h = await hashPin(pin, rec.salt);
  let diff = h.hash.length ^ rec.hash.length;
  for (let i = 0; i < Math.min(h.hash.length, rec.hash.length); i++) diff |= h.hash.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

export function newDeviceKey() {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealLocal(key, obj) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return { iv, ct: new Uint8Array(ct) };
}

export async function openLocal(key, rec) {
  if (!rec || !rec.iv || !rec.ct) return null;
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct);
  return JSON.parse(td.decode(pt));
}
