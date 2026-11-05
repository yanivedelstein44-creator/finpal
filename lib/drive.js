/* FinPal Family - Google sign-in (OAuth 2.0 for client-side apps, full-page redirect, no Google script on the
   page) and the few Google Drive REST calls the app needs. Scope: drive.file, so the app sees only the files
   it created itself, never anything else in the person's Drive. */
import { b64u, randomBytes } from './crypto.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
let API = 'https://www.googleapis.com';
export function setApiBase(u) { API = u; } // tests only
// localStorage, not sessionStorage: on Android the return from Google can land in a Chrome tab instead of the
// installed app window, and both share this storage. The token lasts an hour and opens only the app's own files.
const TOKEN_KEY = 'fp_token', STATE_KEY = 'fp_oauth_state';

export class DriveError extends Error {
  constructor(kind, status, msg) { super(msg || kind); this.kind = kind; this.status = status || 0; }
}

export function appBase() {
  return location.origin + location.pathname.replace(/[^/]*\.html?$/, '');
}

export function validClientId(s) { return /^[0-9]{6,}-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(s || '').trim()); }
export function validApiKey(s) { return /^AIza[0-9A-Za-z_-]{35}$/.test(String(s || '').trim()); }

// ------------------------------------------------------------------ sign-in
/** leaves the page: Google's sign-in, then back to the app with a token in the address fragment */
export function signIn({ clientId, loginHint, prompt, after }) {
  const state = b64u(randomBytes(16));
  localStorage.setItem(STATE_KEY, JSON.stringify({ state, after: after || '', at: Date.now() }));
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: appBase(), response_type: 'token', scope: SCOPE,
    include_granted_scopes: 'true', state
  });
  if (loginHint) q.set('login_hint', loginHint);
  if (prompt) q.set('prompt', prompt);
  location.assign(`${AUTH_URL}?${q}`);
}

/** on start: a sign-in that just came back? returns null, {ok, after} or {error, after} */
export function takeSignIn() {
  const h = location.hash || '';
  if (!/(^#|&)(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { saved = null; }
  localStorage.removeItem(STATE_KEY);
  const after = (saved && saved.after) || '';
  if (!saved || !p.get('state') || p.get('state') !== saved.state || Date.now() - saved.at > 15 * 60 * 1000) return { error: 'state', after };
  if (p.get('error')) return { error: p.get('error'), after };
  const granted = (p.get('scope') || '').split(/[ +]/);
  if (!granted.includes(SCOPE)) return { error: 'scope', after };
  const tok = p.get('access_token');
  if (!tok) return { error: 'token', after };
  const secs = Math.max(60, parseInt(p.get('expires_in') || '3599', 10) || 3599);
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ t: tok, exp: Date.now() + (secs - 90) * 1000 }));
  return { ok: true, after };
}

export function token() {
  try {
    const v = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (v && v.t && v.exp > Date.now()) return v.t;
  } catch (e) { /* ignore */ }
  return null;
}

export function dropToken() { localStorage.removeItem(TOKEN_KEY); }

// ------------------------------------------------------------------ REST
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new DriveError('offline', 0, 'timeout')), ms);
  p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});

async function call(method, url, { tok, body, headers, timeout } = {}) {
  const h = Object.assign({}, headers || {});
  if (tok) h.Authorization = `Bearer ${tok}`;
  let r;
  try {
    r = await withTimeout(fetch(url, { method, headers: h, body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' }), timeout || 30000);
  } catch (e) {
    if (e instanceof DriveError) throw e;
    throw new DriveError('offline', 0, String(e && e.message || e));
  }
  if (r.ok) return r;
  let reason = '', message = '';
  try {
    const j = await r.json();
    const err = j && j.error;
    reason = (err && err.errors && err.errors[0] && err.errors[0].reason) || (err && err.status) || '';
    message = (err && err.message) || '';
  } catch (e) { /* not json */ }
  if (r.status === 401) { if (tok) dropToken(); throw new DriveError('auth', 401, message); }
  if (r.status === 404) throw new DriveError('missing', 404, message);
  // a full Drive also says "quota": it is not "busy", waiting does not help
  if ((r.status === 403 || r.status === 413) && /storageQuotaExceeded|storage quota/i.test(`${reason} ${message}`)) throw new DriveError('full', r.status, message);
  if (r.status === 403 && /rate|quota|limit/i.test(reason + message)) throw new DriveError('busy', 403, message);
  if (r.status === 403) throw new DriveError('denied', 403, `${reason} ${message}`.trim());
  if (r.status === 400 && /key/i.test(reason + message)) throw new DriveError('apikey', 400, message);
  if (r.status === 429 || r.status >= 500) throw new DriveError('busy', r.status, message);
  throw new DriveError('http', r.status, `${reason} ${message}`.trim());
}

export async function whoAmI(tok) {
  const r = await call('GET', `${API}/drive/v3/about?fields=${encodeURIComponent('user(displayName,emailAddress)')}`, { tok });
  const j = await r.json();
  return { email: (j.user && j.user.emailAddress) || '', name: (j.user && j.user.displayName) || '' };
}

/** our own files of this household (after reinstalling the app, the file is found again) */
export async function findFiles(tok, hid) {
  const q = `appProperties has { key='finpal_hid' and value='${hid.replace(/[^A-Za-z0-9_-]/g, '')}' } and trashed = false`;
  const url = `${API}/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=20&orderBy=modifiedTime desc`
    + `&fields=${encodeURIComponent('files(id,name,modifiedTime,appProperties)')}`;
  const r = await call('GET', url, { tok });
  return ((await r.json()).files || []);
}

export async function createFile(tok, { name, appProperties, text }) {
  const boundary = 'finpal' + b64u(randomBytes(12));
  const meta = JSON.stringify({ name, mimeType: 'application/octet-stream', appProperties, description: 'FinPal: הנתונים המוצפנים של המשפחה. לא למחוק.' });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
    + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${text}\r\n--${boundary}--`;
  const r = await call('POST', `${API}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
    tok, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, timeout: 60000
  });
  const j = await r.json();
  if (!j.id) throw new DriveError('http', r.status, 'no file id');
  return j.id;
}

/** anyone holding the file id may download it: the content is encrypted, only the two phones hold the key */
export async function shareByLink(tok, id) {
  await call('POST', `${API}/drive/v3/files/${encodeURIComponent(id)}/permissions?fields=id`, {
    tok, body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }),
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function updateFile(tok, id, text) {
  await call('PATCH', `${API}/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id`, {
    tok, body: text, headers: { 'Content-Type': 'application/octet-stream' }, timeout: 60000
  });
}

/** download a file shared by link, with the API key only (no sign-in needed) */
export async function readShared(id, apiKey) {
  const r = await call('GET', `${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(apiKey)}`);
  return r.text();
}

export async function readOwn(tok, id) {
  const r = await call('GET', `${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { tok });
  return r.text();
}
