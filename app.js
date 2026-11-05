/* FinPal Family - the app: start, lock, sync with Google Drive, import, and wiring the screens together. */
import { S, $, $$, esc, toast, sheet, closeSheet, busy, unbusy, withBusy, icon, localDate, greeting, avatar, ago, fmt } from './ui/kit.js';
import * as V from './ui/views.js';
import * as F from './ui/flows.js';
import { store, inbox, persist } from './lib/store.js';
import * as D from './lib/drive.js';
import * as C from './lib/crypto.js';
import { Family } from './lib/family.js';

const APP_VERSION = '1.2.1';
const DEFAULTS = Object.assign({ clientId: '', apiKey: '' }, globalThis.FINPAL_FAMILY || {});
const UNLOCK_KEY = 'fp_unlocked';

if (window.top !== window.self) { document.body.innerHTML = ''; throw new Error('framed'); }

// the data was deleted, or another family set up, in another window of the app (a Chrome tab next to the
// installed app): this window starts over instead of writing its old copy back
const gone = e => { if (e && e.name === 'HouseholdGone') { location.replace(D.appBase()); return true; } return false; };
window.addEventListener('unhandledrejection', ev => { if (gone(ev.reason)) ev.preventDefault(); });

// ------------------------------------------------------------------ the worker (parsing and replay off the screen thread)
let worker = null, seq = 0;
const pending = new Map();
let local = null; // fallback: the same modules on this thread
const LIMIT = { parse: 60 * 1000, replay: 3 * 60 * 1000 };
function startWorker() {
  try {
    const w = new Worker('worker.js', { type: 'module' });
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.ok) p.resolve(data.out); else p.reject(new Error(data.err));
    };
    w.onerror = () => {
      if (worker !== w) return;
      worker = null;
      for (const p of pending.values()) p.reject(new Error('worker failed'));
      pending.clear();
    };
    worker = w;
  } catch (e) { worker = null; }
}
function restartWorker() {
  const w = worker;
  worker = null;
  try { if (w) w.terminate(); } catch (e) { /* ignore */ }
  for (const p of pending.values()) p.reject(new Error('timeout'));
  pending.clear();
  startWorker();
}
async function work(cmd, payload, transfer) {
  if (worker) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      // a job that never ends (a damaged file, or one made to hang the app) must not freeze imports for good
      const timer = setTimeout(() => { if (pending.has(id)) restartWorker(); }, LIMIT[cmd] || 60 * 1000);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      worker.postMessage(Object.assign({ id, cmd }, payload), transfer || []);
    });
  }
  if (!local) {
    const [P, E, R] = await Promise.all([import('./lib/parsers.js'), import('./lib/engine.js'), import('./lib/replay.js')]);
    local = { P, E, R };
  }
  if (cmd === 'parse') return local.P.parseFile(payload.name, new Uint8Array(payload.bytes), { password: payload.password || '' });
  if (cmd === 'replay') return local.R.replay(local.E, payload.events, payload.today, payload.names);
  throw new Error('unknown ' + cmd);
}

// ------------------------------------------------------------------ data
const fam = new Family({ store });
S.fam = fam;

function latestGoal(events) {
  let g = 0;
  for (const e of events) if (e.t === 'goal') g = Math.max(0, +e.amount || 0);
  return g;
}

function apply(out) {
  S.data = out.payload || null;
  S.cards = out.cards || [];
  S.imports = out.imports || [];
  S.problems = out.problems || [];
}

let rebuilding = null;
async function rebuild() {
  if (rebuilding) { rebuilding.again = true; return rebuilding.p; }
  const job = { again: false };
  rebuilding = job;
  job.p = (async () => {
    try {
      do {
        job.again = false;
        const events = fam.events();
        S.names = fam.names();
        S.goal = latestGoal(events);
        const today = localDate();
        const key = `${APP_VERSION}|${await fam.eventsKey()}|${today}|${S.names.A}|${S.names.B}`;
        if (!events.some(e => e.t === 'import')) { apply({}); continue; }
        const cache = await store.get('cache');
        if (cache && cache.key === key) { apply(cache); continue; }
        const out = await work('replay', { events, today, names: S.names });
        apply(out);
        S.engineError = null;
        await store.set('cache', Object.assign({ key }, out));
      } while (job.again);
    } finally { rebuilding = null; }
  })();
  return job.p;
}

/** rebuild, and if the engine fails, say so on screen instead of a blank page */
async function safeRebuild() {
  try { await rebuild(); S.engineError = null; } catch (e) {
    S.engineError = e;
    console.error('rebuild failed', e);
  }
}

async function refreshScreen() {
  renderTop();
  renderBanners();
  if (!$('#app').classList.contains('hidden')) V.render();
}

// ------------------------------------------------------------------ Google Drive
export function errorText(e) {
  const partner = S.names[fam.other] || 'בן/בת הזוג';
  if (e instanceof C.CryptoError) {
    if (e.kind === 'household') return 'הקובץ שייך למשפחה אחרת.';
    if (e.kind === 'auth') return 'הקובץ בדרייב שונה או נפגע, ולכן לא נפתח. הנתונים בטלפון לא השתנו.';
    return 'הקובץ בדרייב לא נראה כמו קובץ של FinPal.';
  }
  if (e instanceof D.DriveError) {
    switch (e.kind) {
      case 'offline': return 'אין חיבור לאינטרנט כרגע. ננסה שוב אחר כך.';
      case 'auth': return 'צריך להתחבר שוב לגוגל.';
      case 'missing': return `הקובץ של ${partner} לא נמצא בדרייב. אם הוא נוצר מחדש, צריך קישור חיבור חדש מהטלפון של ${partner}.`;
      case 'apikey': return 'מפתח ה-API לא תקין. בדקו אותו בפרטי החיבור לגוגל.';
      case 'denied': return `גוגל סירבה לבקשה. בדקו בהקמה ש-Google Drive API מופעל ושמפתח ה-API מוגבל לכתובת של האפליקציה. (${e.message})`;
      case 'busy': return 'גוגל עמוסה כרגע. ננסה שוב בעוד כמה דקות.';
      case 'full': return 'ה-Google Drive שלך מלא. צריך לפנות מקום כדי לשמור.';
      case 'nofile': return 'קודם צריך לשמור בדרייב.';
      default: return `שגיאה בדרייב (${e.status || ''} ${e.message || ''})`.trim();
    }
  }
  if (e && e.name === 'HouseholdGone') return 'הנתונים בטלפון השתנו בחלון אחר של האפליקציה. פותחים אותה מחדש.';
  return String((e && e.message) || e || 'שגיאה');
}

function signIn(after) {
  if (!fam.cfg || !fam.cfg.clientId) { F.googleSetupSheet(); return; }
  D.signIn({ clientId: fam.cfg.clientId, loginHint: fam.cfg.email || '', after });
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { if (D.token()) sync({ quiet: true }); else renderBanners(); }, 1500);
}

let syncing = null;
/** one sync at a time. (The promise is stored before it can finish: a sync with nothing to do completes
    without waiting, and must not leave the "in progress" mark behind.) */
async function sync(opts = {}) {
  if (!fam.ready) return;
  if (syncing) {
    if (!opts.manual) return syncing;
    // a tap on the sync button always gets its own run, after the one in the background
    try { await syncing; } catch (e) { /* the next run reports */ }
    if (syncing) return syncing;
  }
  const p = doSync(opts);
  syncing = p;
  try { return await p; } finally {
    if (syncing === p) syncing = null;
    // a change made while this sync was running is saved by the next one
    if (fam.ready && fam.mine.dirty && D.token() && !S.syncError) schedulePush();
  }
}

async function doSync({ manual = false, quiet = false } = {}) {
  {
    const btn = $('#syncBtn');
    btn.classList.add('spin');
    let changed = false, err = null;
    try {
      if (fam.cfg.partnerFileId && fam.cfg.apiKey) {
        try { changed = await fam.pull(); } catch (e) { if (gone(e)) return; err = e; }
      }
      if (fam.mine.dirty) {
        const tok = D.token();
        if (tok) {
          try { await fam.push(tok); } catch (e) { if (gone(e)) return; if (!(e instanceof D.DriveError && e.kind === 'auth')) err = err || e; }
        } else if (manual) { signIn('push'); return; }
      } else if (manual && !fam.cfg.myFileId && fam.role === 'A') { signIn('push'); return; }
      S.lastSync = new Date().toISOString();
      S.syncError = err;
      if (changed) await safeRebuild();
      if (manual) toast(err ? errorText(err) : changed ? 'הנתונים עודכנו' : fam.mine.dirty ? 'צריך להתחבר לגוגל כדי לשמור' : 'הכול מעודכן');
      else if (changed && !quiet) toast(`יש נתונים חדשים מ${S.names[fam.other] || 'בן/בת הזוג'}`);
    } finally {
      btn.classList.remove('spin');
      refreshScreen();
      announce();
    }
  }
}

/** after Google sent us back: finish what the person was in the middle of.
    returns 'screen' when a full screen took over, or a function to run once the app is showing */
async function afterSignIn(res) {
  if (res.error) {
    if (res.error === 'scope') {
      return () => {
        sheet(`<h3>צריך לסמן את האישור</h3><p>במסך של גוגל יש תיבת סימון לגישה לקבצים של FinPal בדרייב. בלי הסימון האפליקציה לא יכולה לשמור. מתחברים שוב ומסמנים את התיבה.</p>
          <button class="btn primary" id="scAgain">התחברות שוב</button><button class="btn" id="scNo">לא עכשיו</button>`);
        $('#scAgain').onclick = () => { closeSheet(); D.signIn({ clientId: fam.cfg.clientId, after: res.after, prompt: 'consent' }); };
        $('#scNo').onclick = closeSheet;
      };
    }
    const msg = res.error === 'access_denied' ? 'ההתחברות לגוגל בוטלה.' : res.error === 'state' ? 'ההתחברות לא הושלמה. נסו שוב.' : `ההתחברות לגוגל נכשלה (${res.error}).`;
    return () => toast(msg, 5000);
  }
  const tok = D.token();
  try {
    const me = await D.whoAmI(tok);
    if (me.email && me.email !== fam.cfg.email) await fam.setConfig({ email: me.email });
  } catch (e) { /* the address is only a convenience */ }
  try {
    await withBusy('שומר בדרייב…', () => fam.push(tok));
  } catch (e) {
    return () => toast(errorText(e), 6000);
  }
  if (res.after === 'setup') { await safeRebuild(); F.setupInvite(); return 'screen'; }
  if (res.after === 'join') { await safeRebuild(); F.connectScreen(false); return 'screen'; }
  if (res.after === 'invite') return () => F.inviteSheet();
  return () => toast('נשמר בדרייב');
}

// ------------------------------------------------------------------ importing
async function importFiles(files) {
  if (!fam.ready || !files.length) return;
  busyWork++;
  try { await importNow(files); } finally { busyWork--; }
  announce();
}

const DAMAGED = 'הקובץ פגום או שההורדה לא הושלמה. הורידו אותו שוב מהאתר.';
const isPdfBytes = buf => {
  const u = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  for (let i = 0; i + 4 < u.length; i++) if (u[i] === 0x25 && u[i + 1] === 0x50 && u[i + 2] === 0x44 && u[i + 3] === 0x46 && u[i + 4] === 0x2d) return true;
  return false;
};

/** a PDF protected with a password: ask for it. It only opens the file here, on the phone, and is not kept
    (with several files at once, it is tried on the next protected files of the same import, and then forgotten). */
function askPassword(name, wrong, more) {
  return new Promise(resolve => {
    sheet(`<h3>${wrong ? 'הסיסמה לא נכונה' : 'הקובץ מוגן בסיסמה'}</h3>
      <p class="ellip" dir="auto">${esc(name)}</p>
      <p class="small">${wrong ? 'בדקו את הסיסמה ונסו שוב.' : 'לפעמים זו תעודת הזהות של בעל החשבון או הכרטיס.'} הסיסמה משמשת רק לפתיחת הקובץ בטלפון, ולא נשמרת.${more ? ' ננסה אותה גם בשאר הקבצים המוגנים שבחרתם עכשיו.' : ''}</p>
      <label class="field" for="pdfPw">הסיסמה של הקובץ</label><input id="pdfPw" type="password" autocomplete="off" spellcheck="false">
      <button class="btn primary" id="pwGo" style="margin-top:12px">פתיחת הקובץ</button><button class="btn" id="pwSkip">דילוג על הקובץ</button>`,
    { onClose: () => resolve(null) });
    const done = v => { sheet.onClose = null; closeSheet(); resolve(v); };
    $('#pwGo').onclick = () => done($('#pdfPw').value || null);
    $('#pdfPw').onkeydown = e => { if (e.key === 'Enter') done($('#pdfPw').value || null); };
    $('#pwSkip').onclick = () => done(null);
  });
}

/** read one file in the worker; a protected PDF asks for its password (up to five tries). Statements from the
    same bank often share a password, so the one that opened the previous file is tried first, without asking.
    Gives the result and the password that opened the file. */
async function parseOne(name, buf, busyText, { tryFirst = '', more = false } = {}) {
  let password = '', guessed = false, typed = false;
  for (let attempt = 0; ; attempt++) {
    const pdf = isPdfBytes(buf);
    const bytes = pdf ? buf.slice(0) : buf; // a PDF may have to be opened again, with its password
    const out = await work('parse', { name, bytes, password }, [bytes]);
    if (!out.password) return [out, password];
    if (tryFirst && !guessed) { guessed = true; password = tryFirst; continue; }
    if (attempt >= 5) return [out, ''];
    unbusy();
    try { password = await askPassword(name, typed && out.password === 'wrong', more); } finally { busy(busyText); }
    if (password === null) return [out, ''];
    typed = true;
  }
}

async function importNow(files) {
  const results = [];
  const known = new Set((S.imports || []).filter(i => i.status !== 'removed').map(i => i.sha));
  const added = [];
  let opened = ''; // the password of the last protected file: only in memory, only for this import
  await withBusy(files.length > 1 ? `קורא ${files.length} קבצים…` : 'קורא את הקובץ…', async () => {
    for (const [k, f] of files.entries()) {
      const name = f.name || 'file';
      const busyText = files.length > 1 ? `קורא קובץ ${k + 1} מתוך ${files.length}…` : 'קורא את הקובץ…';
      busy(busyText);
      try {
        // a File from the picker, or {name, bytes: ArrayBuffer} from the share sheet (File.bytes is a method in new browsers)
        const buf = typeof Blob !== 'undefined' && f instanceof Blob ? await f.arrayBuffer() : f.bytes;
        if (!buf || typeof buf.byteLength !== 'number') { results.push({ name, error: 'לא הצלחתי לקרוא את הקובץ.' }); continue; }
        if (buf.byteLength > 50 * 1024 * 1024) { results.push({ name, error: 'הקובץ גדול מדי (מעל 50MB).' }); continue; }
        if (!buf.byteLength) { results.push({ name, error: 'הקובץ ריק.' }); continue; }
        let out;
        try {
          let pw;
          [out, pw] = await parseOne(name, buf, busyText, { tryFirst: opened, more: k < files.length - 1 });
          if (pw) opened = pw;
        } catch (e) {
          results.push({ name, error: /timeout/.test(String(e && e.message)) ? 'קריאת הקובץ נמשכה יותר מדי זמן. ייתכן שהוא פגום. הורידו אותו שוב.' : DAMAGED });
          continue;
        }
        if (out.password) { results.push({ name, error: out.password === 'wrong' ? 'הסיסמה של הקובץ לא נכונה, והוא לא נפתח.' : 'הקובץ מוגן בסיסמה, והוא לא נפתח.' }); continue; }
        if (out.error || !out.kind) {
          if (out.error) console.warn('parse', name, out.error);
          // a reading failure is reported in technical words: the person only needs to know what to do
          const firstPdf = /dynamically imported module|Failed to fetch|Importing a module/i.test(out.error || '');
          results.push({ name, error: !out.error ? 'זה לא נראה כמו קובץ תנועות של לאומי או של MAX.'
            : firstPdf ? 'כדי לקרוא קובץ PDF בפעם הראשונה צריך חיבור לאינטרנט. נסו שוב כשיש חיבור.'
              : /^שגיאה/.test(out.error) ? DAMAGED : out.error });
          continue;
        }
        if (!(out.txns || []).length) { results.push({ name, error: 'אין בקובץ תנועות.' }); continue; }
        if (known.has(out.sha256)) { results.push({ name, kind: out.kind, status: 'same' }); continue; }
        known.add(out.sha256);
        const ev = await fam.add({ t: 'import', name: name.slice(0, 200), kind: out.kind, sha: out.sha256, txns: out.txns, warnings: (out.warnings || []).slice(0, 20) });
        added.push(ev.id);
        results.push({ name, kind: out.kind, ev: ev.id });
      } catch (e) {
        if (e && e.name === 'HouseholdGone') throw e;
        results.push({ name, error: `שגיאה בקריאת הקובץ: ${errorText(e)}` });
      }
    }
    if (added.length) await safeRebuild();
  });
  for (const r of results) {
    if (!r.ev) continue;
    const im = (S.imports || []).find(i => i.id === r.ev) || {};
    Object.assign(r, { status: im.status, added: im.added || 0, dup: im.dup || 0, updated: im.updated || 0 });
  }
  const newCards = (S.cards || []).filter(c => c.card && !c.owner && (c.source || 'max') !== 'leumi').map(c => c.card);
  refreshScreen();
  F.importResults(results, newCards);
  if (added.length) schedulePush();
}

async function takeInbox() {
  const items = await inbox.take();
  if (!items.length) return;
  // anything can send files to the share sheet, also a web page: nothing is added without saying yes
  const list = items.slice(0, 5).map(i => `<li class="ellip">${esc(i.name || 'קובץ')}</li>`).join('') + (items.length > 5 ? `<li>ועוד ${items.length - 5}</li>` : '');
  const yes = await F.confirmSheet({
    title: items.length === 1 ? 'לייבא את הקובץ ששותף?' : `לייבא ${items.length} קבצים ששותפו?`,
    body: `<ul class="plain">${list}</ul><p>מייבאים רק קבצים שהורדתם בעצמכם מהבנק או מהאשראי.</p>`, yes: 'ייבוא'
  });
  if (yes) await importFiles(items.map(i => ({ name: i.name, bytes: i.bytes })));
}

// ------------------------------------------------------------------ changes from the screens
async function change(ev) {
  busyWork++;
  try {
    await fam.add(ev);
    await safeRebuild();
  } finally { busyWork--; }
  refreshScreen();
  announce();
  schedulePush();
}

const actions = {
  store,
  config: () => Object.assign({}, DEFAULTS, fam.cfg ? { clientId: fam.cfg.clientId, apiKey: fam.cfg.apiKey } : {}),
  markUnlocked: () => { try { sessionStorage.setItem(UNLOCK_KEY, String(Date.now())); } catch (e) { /* ignore */ } },
  signIn, errorText,
  refresh: () => refreshScreen(),
  signedIn: () => !!D.token(),
  inApp: () => F.inApp(),
  hasPin: () => !!S.hasPin,
  pinChanged: on => { S.hasPin = !!on; actions.markUnlocked(); refreshScreen(); },
  version: () => APP_VERSION,
  enterApp: () => enterApp(),
  afterJoin: async () => { try { await fam.pull(); } catch (e) { S.syncError = e; } await safeRebuild(); },
  wipe: async () => {
    if (!(await F.confirmSheet({ title: 'למחוק את הנתונים מהטלפון?', text: 'מה שנשמר בדרייב נשאר שם, ואפשר לחזור עם קוד השחזור או עם הזמנה. שינויים שלא נשמרו בדרייב יימחקו.', yes: 'מחיקה', danger: true }))) return;
    await store.wipe();
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
    announce(); // another open window of the app starts over too
    location.replace(D.appBase());
  },
  setOwner: (card, owner) => change({ t: 'owner', card, owner }),
  setCategory: (uids, category, learn) => change({ t: 'category', uids, category, learn: !!learn }),
  setRecurringNote: (key, note) => change({ t: 'recnote', key, note }),
  openTx: uid => F.txSheet(uid),
  openRecurring: id => F.recurringSheet(id),
  pickOwner: cards => F.ownerSheet(cards),
  removeImport: async sha => {
    const im = (S.imports || []).find(i => i.sha === sha);
    if (!(await F.confirmSheet({ title: 'להסיר את הקובץ?', text: `התנועות מהקובץ "${esc(im ? im.name : '')}" יוסרו בשני הטלפונים. אפשר לייבא אותו שוב אחר כך.`, yes: 'הסרה', danger: true }))) return;
    await change({ t: 'import_del', sha });
    toast('הקובץ הוסר');
  },
  setLockMin: async m => { await fam.setConfig({ lockMin: m }); toast('נשמר'); },
  act: async (name, el) => {
    switch (name) {
      case 'import': F.importSheet(); break;
      case 'howto': F.howtoSheet(); break;
      case 'forecast': F.forecastSheet(); break;
      case 'invite': F.inviteSheet(); break;
      case 'connect': F.connectScreen(true); break;
      case 'sync': sync({ manual: true }); break;
      case 'google-setup': F.googleSetupSheet(); break;
      case 'pin-change': F.changePinSheet(); break;
      case 'pin-on': F.pinOnSheet(); break;
      case 'pin-off': F.pinOffSheet(); break;
      case 'recovery': F.recoverySheet(); break;
      case 'lock-now': if (S.hasPin) { sessionStorage.removeItem(UNLOCK_KEY); lock(); } break;
      case 'privacy': F.privacySheet(); break;
      case 'wipe': actions.wipe(); break;
      case 'install': install(); break;
      case 'goal': {
        const v = Math.round(+($('#goalInput') || {}).value || 0);
        if (!(v > 0)) { toast('כמה תרצו לחסוך בחודש?'); return; }
        await change({ t: 'goal', amount: v });
        toast('היעד נשמר');
        break;
      }
      case 'goal-edit': {
        sheet(`<h3>יעד החיסכון החודשי</h3><p>כמה תרצו לחסוך בכל חודש? 0 מבטל את היעד.</p>
          <input id="goalEdit" type="number" inputmode="numeric" min="0" step="100" value="${S.goal || ''}"><button class="btn primary" id="geSave" style="margin-top:12px">שמירה</button>`);
        $('#geSave').onclick = async () => { const v = Math.max(0, Math.round(+$('#goalEdit').value || 0)); closeSheet(); await change({ t: 'goal', amount: v }); toast('נשמר'); };
        break;
      }
      default: break;
    }
  }
};
V.setActions(actions);
F.setActions(actions);

// ------------------------------------------------------------------ top bar and banners
/** changes worth a reminder: not just the names and links written when joining */
function unsaved() {
  if (!fam.mine.dirty || !fam.cfg.clientId) return false;
  const since = fam.mine.pushedAt || '';
  return fam.mine.events.some(e => e.ts > since && e.t !== 'name' && e.t !== 'partner_file');
}

function renderTop() {
  if (!fam.ready) return;
  const n = S.names, me = n[fam.role] || '', partner = n[fam.other] || '';
  $('#who').innerHTML = `<span class="pair">${avatar(n.A || '?', 'a')}${avatar(n.B || '?', n.B ? 'b' : 'ghost')}</span>
    <span class="hello"><small>${greeting()}${me ? `, ${esc(me)}` : ''}</small><b>${partner ? `הבית של ${esc(n.A)} ו${esc(n.B)}` : 'הבית שלנו'}</b></span>`;
  const badge = $('#syncBadge');
  badge.classList.toggle('hidden', !unsaved());
  badge.textContent = unsaved() ? '!' : '';
}

function renderBanners() {
  const box = $('#banners');
  if (!fam.ready) { box.innerHTML = ''; return; }
  const cfg = fam.cfg, n = S.names, partner = n[fam.other] || 'בן/בת הזוג';
  const items = [];
  if (S.swWaiting) items.push({ id: 'update', gold: true, t: 'גרסה חדשה של האפליקציה מוכנה', s: 'הנתונים נשמרים', b: 'רענון' });
  if (unsaved() && !D.token() && cfg.clientId) {
    items.push({ id: 'save', gold: true, t: 'יש שינויים שעוד לא נשמרו בדרייב', s: `כדי שיופיעו גם בטלפון של ${partner}`, b: 'שמירה' });
  }
  if (fam.role === 'A' && !cfg.clientId) items.push({ id: 'drive', t: 'חיבור ל-Google Drive', s: `כדי לשמור גיבוי ולהזמין את ${partner}`, b: 'חיבור' });
  else if (fam.role === 'A' && cfg.myFileId && !cfg.partnerFileId && !cfg.invitedAt) items.push({ id: 'invite', t: `הזמנת ${partner}`, s: 'כדי שתראו את הנתונים ביחד', b: 'הזמנה' });
  if (fam.role === 'B' && cfg.myFileId && cfg.shared && !cfg.partnerKnowsMine) items.push({ id: 'connect', t: `הקבצים מהטלפון הזה עוד לא מופיעים אצל ${partner}`, s: 'שולחים קישור חיבור פעם אחת', b: 'שליחה' });
  if (fam.role === 'A' && cfg.myFileId && cfg.shared && cfg.needsRelink) items.push({ id: 'connect', gold: true, t: 'הקובץ שלך בדרייב נוצר מחדש', s: `שולחים ל${partner} קישור חיבור, כדי שימשיכו להתעדכן שם`, b: 'שליחה' });
  if (S.engineError) items.push({ id: 'engine', t: 'לא הצלחתי לחשב את הנתונים', s: String(S.engineError.message || S.engineError).slice(0, 120), b: 'ניסיון נוסף' });
  if (S.syncError && !(S.syncError instanceof D.DriveError && S.syncError.kind === 'offline')) items.push({ id: 'err', t: 'הסנכרון לא הצליח', s: errorText(S.syncError), b: 'ניסיון נוסף' });
  if (S.installEvent && !standalone()) items.push({ id: 'install', t: 'הוספת FinPal למסך הבית', s: 'נפתח כמו אפליקציה, גם בלי אינטרנט', b: 'הוספה' });
  box.innerHTML = items.slice(0, 2).map(i => `<div class="banner ${i.gold ? 'gold' : ''}" role="status"><div><b>${esc(i.t)}</b><span class="small">${esc(i.s)}</span></div>
    <button class="btn small ${i.gold ? 'navy' : 'primary'}" data-banner="${i.id}">${esc(i.b)}</button></div>`).join('');
  $$('[data-banner]', box).forEach(b => b.onclick = () => {
    const id = b.dataset.banner;
    if (id === 'update') { S.reloadOnController = true; S.swWaiting.postMessage('skip-waiting'); setTimeout(() => location.reload(), 3000); }
    else if (id === 'save') signIn('push');
    else if (id === 'drive') F.googleSetupSheet();
    else if (id === 'invite') F.inviteSheet();
    else if (id === 'connect') F.connectScreen(true);
    else if (id === 'err') sync({ manual: true });
    else if (id === 'engine') { safeRebuild().then(refreshScreen); }
    else if (id === 'install') install();
  });
}

// ------------------------------------------------------------------ install, updates
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvent = e; renderBanners(); F.installSlot(); });
window.addEventListener('appinstalled', () => { S.installEvent = null; renderBanners(); F.installSlot(); toast('FinPal הותקנה. אפשר לפתוח אותה מהמסך הבית'); });
async function install() {
  const ev = S.installEvent;
  if (!ev) {
    sheet(`<h3>הוספה למסך הבית</h3><p>בכרום: לוחצים על שלוש הנקודות למעלה, ובוחרים "הוספה למסך הבית" או "התקנת אפליקציה".</p><button class="btn" id="inClose">הבנתי</button>`);
    $('#inClose').onclick = closeSheet;
    return;
  }
  S.installEvent = null;
  ev.prompt();
  try { await ev.userChoice; } catch (e) { /* ignore */ }
  renderBanners();
  F.installSlot();
}

const startedAt = Date.now();
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    const apply = w => { S.reloadOnController = true; w.postMessage('skip-waiting'); setTimeout(() => location.reload(), 3000); };
    // a new version found as the app opens is put in place at once, before anything is typed or open;
    // later in the session it waits for the "רענון" banner, so nothing on the screen is lost
    const quiet = () => Date.now() - startedAt < 20000 && !busyWork && ['#sheet', '#busy'].every(q => $(q).classList.contains('hidden'))
      && ($('#screen').classList.contains('hidden') || $('#screen').dataset.view === 'welcome');
    const ready = w => {
      if (!navigator.serviceWorker.controller) return; // the very first install: nothing to replace
      if (quiet()) apply(w);
      else { S.swWaiting = w; renderBanners(); }
    };
    const watch = w => w && w.addEventListener('statechange', () => { if (w.state === 'installed') ready(w); });
    if (reg.waiting) ready(reg.waiting);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.reloadOnController) location.reload(); });
    reg.update().catch(() => {}); // look for a new version now, not only in an hour
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  } catch (e) { /* the app still works, only without offline start */ }
}

// ------------------------------------------------------------------ lock
let hiddenAt = 0;
function lock() {
  $('#app').classList.add('hidden');
  closeSheet();
  F.lockScreen({ onUnlock: async () => { actions.markUnlocked(); await enterApp(); } });
}

/** the app may also be open in a Chrome tab (a link from WhatsApp opens there): when coming back to this
    window, take what the other one saved, so nothing it wrote is overwritten from an old copy in memory */
let busyWork = 0;
async function reloadFromPhone() {
  if (!fam.ready || syncing || busyWork) return;
  const before = fam.events().length, cfgBefore = JSON.stringify(fam.cfg), household = fam.cfg.recovery;
  try { await fam.load(); S.hasPin = !!(await store.get('pin')); } catch (e) { return; }
  if (!fam.ready || fam.cfg.recovery !== household) { location.replace(D.appBase()); return; }
  if (fam.events().length !== before || JSON.stringify(fam.cfg) !== cfgBefore) {
    S.names = fam.names();
    await safeRebuild();
    refreshScreen();
  }
}
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('finpal-family') : null;
const announce = () => { try { if (channel) channel.postMessage('changed'); } catch (e) { /* ignore */ } };
if (channel) channel.onmessage = () => { if (!document.hidden) reloadFromPhone(); else S.staleFromOther = true; };

window.addEventListener('pagehide', () => {
  if (fam.ready && $('#lock').classList.contains('hidden') && !$('#app').classList.contains('hidden')) actions.markUnlocked();
});
document.addEventListener('visibilitychange', async () => {
  if (!fam.ready) return;
  if (document.hidden) {
    hiddenAt = Date.now();
    if ($('#lock').classList.contains('hidden') && !$('#app').classList.contains('hidden')) actions.markUnlocked();
    return;
  }
  // deleted from the phone in another window meanwhile: start over (the lock code is gone with it)
  try { if (!(await store.get('cfg'))) { location.replace(D.appBase()); return; } } catch (e) { /* storage busy: carry on */ }
  const mins = (fam.cfg && fam.cfg.lockMin) || 3;
  if (S.hasPin && hiddenAt && Date.now() - hiddenAt > mins * 60 * 1000 && $('#lock').classList.contains('hidden')) {
    sessionStorage.removeItem(UNLOCK_KEY);
    lock();
    return;
  }
  if ($('#app').classList.contains('hidden')) return;
  await reloadFromPhone();
  if (!S.lastSync || Date.now() - Date.parse(S.lastSync) > 2 * 60 * 1000) sync({ quiet: false });
});

// ------------------------------------------------------------------ entering the app
let entered = false;
async function enterApp() {
  F.hideScreen();
  $('#app').classList.remove('hidden');
  if (entered) await reloadFromPhone();
  S.names = fam.names();
  if (!S.data) await safeRebuild();
  refreshScreen();
  if (!entered) {
    entered = true;
    setInterval(() => { if (!document.hidden && !$('#app').classList.contains('hidden')) sync({ quiet: false }); }, 5 * 60 * 1000);
  }
  await takeInbox();
  if (S.pendingConnect) {
    const p = S.pendingConnect; S.pendingConnect = null;
    await acceptConnect(p);
  }
  sync({ quiet: true });
}

async function acceptConnect(payload) {
  const partner = S.names[fam.other] || 'בן/בת הזוג';
  try {
    const changed = await fam.acceptConnect(payload);
    toast(changed ? `מעכשיו רואים כאן גם את הקבצים של ${partner}` : 'החיבור כבר קיים');
    await sync({ quiet: true });
    schedulePush();
  } catch (e) {
    const kind = e instanceof C.CryptoError ? e.kind : '';
    toast(kind === 'own' ? 'זה קישור החיבור של הטלפון הזה. שולחים אותו לטלפון השני.'
      : kind === 'auth' ? 'הקישור שייך למשפחה אחרת.' : 'הקישור לא תקין. בקשו קישור חדש.', 5000);
  }
}

/** a link that arrives while the app is already open (WhatsApp into the running app) changes only the
    part after '#', and the page does not reload */
window.addEventListener('hashchange', () => {
  const h = location.hash || '';
  const c = /#connect=([A-Za-z0-9_-]+)/.exec(h), j = /#join=([A-Za-z0-9_-]+)/.exec(h);
  if (!c && !j) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!fam.ready) { if (j) F.joinScreen(j[1]); return; }
  if (j) { toast('הטלפון הזה כבר מחובר למשפחה.', 5000); return; }
  if ($('#app').classList.contains('hidden')) { S.pendingConnect = c[1]; return; } // locked: right after unlocking
  acceptConnect(c[1]);
});

// ------------------------------------------------------------------ start
$$('#tabbar button').forEach(b => b.onclick = () => V.go(b.dataset.tab));
$('#importBtn').onclick = () => F.importSheet();
$('#syncBtn').onclick = () => sync({ manual: true });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').classList.contains('hidden')) closeSheet(); });
$('#fileInput').onchange = e => { const files = Array.from(e.target.files || []); e.target.value = ''; importFiles(files); };
window.addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });

(async function start() {
  registerSW();
  startWorker();
  persist();
  const auth = D.takeSignIn();
  const hash = location.hash || '';
  const join = /#join=([A-Za-z0-9_-]+)/.exec(hash);
  const connect = /#connect=([A-Za-z0-9_-]+)/.exec(hash);
  if (join || connect) history.replaceState(null, '', location.pathname + location.search);
  const shared = new URLSearchParams(location.search).has('share');
  if (shared) history.replaceState(null, '', location.pathname);
  let has = false;
  try { has = await fam.load(); } catch (e) { has = false; }
  if (!has) {
    if (auth && auth.after === 'restore' && auth.ok) { await F.finishRestore(); return; }
    if (auth && auth.after === 'restore') { F.restoreScreen((await store.get('pending_restore')) || {}); toast('ההתחברות לגוגל לא הושלמה.'); return; }
    if (join) { F.joinScreen(join[1]); return; }
    F.welcome();
    return;
  }
  S.names = fam.names();
  if (join) toast('הטלפון הזה כבר מחובר למשפחה. כדי להצטרף למשפחה אחרת, מוחקים קודם את הנתונים (עוד ← מחיקה).', 7000);
  if (connect) S.pendingConnect = connect[1];
  const go = async () => {
    const next = auth ? await afterSignIn(auth) : null;
    if (next === 'screen') return;
    await enterApp();
    if (typeof next === 'function') next();
  };
  try { S.hasPin = !!(await store.get('pin')); } catch (e) { S.hasPin = false; }
  if (!S.hasPin) { actions.markUnlocked(); await go(); return; }
  let last = 0;
  try { last = +(sessionStorage.getItem(UNLOCK_KEY) || 0); } catch (e) { last = 0; }
  const mins = (fam.cfg && fam.cfg.lockMin) || 3;
  if (last && Date.now() - last >= 0 && Date.now() - last < mins * 60 * 1000) { actions.markUnlocked(); await go(); return; }
  F.lockScreen({ onUnlock: async () => { actions.markUnlocked(); await go(); } });
})();
