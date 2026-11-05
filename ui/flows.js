/* FinPal Family - flows: welcome, setting up the family, joining by invite, restoring, the lock code, importing
   files, and the small sheets (transaction, owner of a card, subscription, invite, privacy). */
import {
  S, $, $$, esc, money, abs$, fmt, dm, dmy, icon, line, toast, sheet, closeSheet, busy, unbusy, withBusy, avatar, who,
  notice, copyText, shareText, ago
} from './kit.js';
import * as C from '../lib/crypto.js';
import * as V from './views.js';
import * as D from '../lib/drive.js';

let A = {}; // app actions
export function setActions(a) { A = a; }

const screen = (html, view = '') => { const el = $('#screen'); el.innerHTML = html; el.dataset.view = view; el.classList.remove('hidden'); $('#app').classList.add('hidden'); window.scrollTo(0, 0); return el; };
export const hideScreen = () => { $('#screen').classList.add('hidden'); $('#screen').innerHTML = ''; };
const steps = (n, of) => `<div class="steps" aria-label="שלב ${n} מתוך ${of}">${Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;
const logo = '<img class="logo" src="icons/icon-192.png" alt="">';
export const inApp = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  || /^android-app:/.test(document.referrer || '') || sessionStorage.getItem('fp_app') === '1';
try { if (/^android-app:/.test(document.referrer || '')) sessionStorage.setItem('fp_app', '1'); } catch (e) { /* ignore */ }

/** on the welcome screen: the Android app (APK) from the site itself, or the browser's own install */
export function installSlot() {
  const box = $('#wInstall');
  if (!box) return;
  if (inApp()) { box.innerHTML = ''; return; }
  box.innerHTML = `<a class="btn gold" href="FinPal.apk" download="FinPal.apk" data-w="apk">${icon('download')} הורדת האפליקציה לאנדרואיד</a>
    <p class="small install-hint">אחרי ההורדה פותחים את הקובץ ומאשרים התקנה.${S.installEvent ? ' <button class="linkish" data-w="install">או התקנה מהירה דרך כרום</button>' : ''}</p>`;
  const b = $('[data-w="install"]', box);
  if (b) b.onclick = () => A.act('install');
}

// ------------------------------------------------------------------ welcome
export function welcome() {
  const el = screen(`<div class="top">${logo}
    <h1>הכסף של המשפחה, ביחד</h1>
    <p>FinPal מסדר את התנועות מהבנק ומכרטיסי האשראי, מראה לאן הולך הכסף ואיפה אפשר לחסוך. שניכם רואים את אותם נתונים, כל אחד בטלפון שלו.</p>
    <div class="feature"><span class="ic">${icon('upload')}</span><div><b>בלי לחבר את הבנק</b><span>מורידים קובץ מהאתר של הבנק או של האשראי ומשתפים אותו לאפליקציה.</span></div></div>
    <div class="feature"><span class="ic">${icon('shield')}</span><div><b>רק לשניכם</b><span>בדרייב נשמר רק קובץ מוצפן, שרק שני הטלפונים שלכם יכולים לפתוח. אין חיבור לבנק ואין שרת באמצע.</span></div></div>
    <div class="feature"><span class="ic">${icon('seed')}</span><div><b>איך לחסוך</b><span>טיפים לפי ההוצאות שלכם, מנויים שהתייקרו וכמה עוד אפשר להוציא החודש.</span></div></div>
  </div>
  <div class="actions">
    <div id="wInstall"></div>
    <button class="btn primary" data-w="new">מתחילים</button>
    <button class="btn" data-w="joined">קיבלתי הזמנה מבן/בת הזוג</button>
    <button class="btn ghost" data-w="restore">יש לי קוד שחזור</button>
  </div>`, 'welcome');
  $('[data-w="new"]', el).onclick = () => setupNames();
  $('[data-w="joined"]', el).onclick = () => pasteInvite();
  $('[data-w="restore"]', el).onclick = () => restoreScreen();
  installSlot();
}

function pasteInvite() {
  const el = screen(`<div class="top">${logo}<h1>קיבלתי הזמנה</h1>
    <p>הדרך הכי פשוטה: לפתוח את הקישור שקיבלת בוואטסאפ. אם הוא נפתח בדפדפן אחר, אפשר להדביק אותו כאן.</p>
    <label class="field" for="invLink">הקישור מההזמנה</label><textarea id="invLink" rows="3" dir="ltr" placeholder="https://…#join=…"></textarea>
    <div class="error" id="invErr" role="alert"></div></div>
    <div class="actions"><button class="btn primary" id="invGo">המשך</button><button class="btn ghost" id="invBack">חזרה</button></div>`);
  $('#invBack', el).onclick = welcome;
  $('#invGo', el).onclick = () => {
    const m = /#join=([A-Za-z0-9_-]+)/.exec($('#invLink').value);
    if (!m) { $('#invErr').textContent = 'זה לא נראה כמו קישור הזמנה של FinPal.'; return; }
    joinScreen(m[1]);
  };
}

// ------------------------------------------------------------------ the lock code
/** a keypad; resolves with the 4 digits typed */
export function pinPad({ host, heading, sub, onPin, cancel, forgot }) {
  host.innerHTML = `<img src="icons/icon-192.png" alt=""><h1 id="lockTitle">${heading}</h1><p id="pinSub">${sub || ''}</p>
    <div class="pins" id="pins" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="keypad" role="group" aria-label="מקלדת מספרים">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}
      <button class="fn" data-k="cancel">${cancel ? 'ביטול' : ''}</button><button data-k="0">0</button><button class="fn" data-k="del" aria-label="מחיקה">מחיקה</button></div>
    ${forgot ? '<button class="forgot" data-k="forgot">שכחתי את הקוד</button>' : ''}`;
  let code = '', locked = false;
  const dots = () => $$('#pins i', host).forEach((d, i) => d.classList.toggle('on', i < code.length));
  const say = t => { $('#pinSub', host).textContent = t; };
  const press = async k => {
    if (locked) return;
    if (k === 'del') { code = code.slice(0, -1); dots(); return; }
    if (k === 'cancel') { if (cancel) cancel(); return; }
    if (k === 'forgot') { if (forgot) forgot(); return; }
    if (code.length >= 4) return;
    code += k; dots();
    if (code.length === 4) {
      locked = true;
      const r = await onPin(code, say);
      locked = false;
      if (r !== true) {
        const p = $('#pins', host); p.classList.remove('shake'); void p.offsetWidth; p.classList.add('shake');
        code = ''; dots();
      }
    }
  };
  $$('[data-k]', host).forEach(b => b.onclick = () => press(b.dataset.k));
  host.onkeydown = e => { if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); };
  host.tabIndex = -1; setTimeout(() => host.focus(), 30);
  return { say };
}

/** create a new code: type it, then again */
export function newPin(host, heading, done, cancel) {
  let first = null;
  pinPad({
    host, heading, sub: 'ארבע ספרות שקל לזכור וקשה לנחש. צריך אותן בכל פתיחה של האפליקציה.', cancel,
    onPin: async (pin, say) => {
      if (!first) {
        if (/^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0123', '9876'].includes(pin)) { say('קוד קל מדי לניחוש. בחרו קוד אחר.'); return false; }
        first = pin; say('הקלידו שוב את אותו קוד, לאישור'); return false;
      }
      if (pin !== first) { first = null; say('הקודים לא זהים. מתחילים מחדש: הקלידו קוד חדש'); return false; }
      await done(pin);
      return true;
    }
  });
}

const LOCKOUT = [0, 0, 0, 0, 0, 30, 60, 300, 900];
const waitText = sec => (sec < 90 ? `${sec} שניות` : `${Math.ceil(sec / 60)} דקות`);

/** every screen that asks for the lock code shares one count of wrong tries: guessing on another screen
    (the recovery code, changing the code) gets no fresh tries */
export async function verifyPin(pin) {
  const lo = (await A.store.get('lockout')) || { fails: 0, until: 0 };
  if (lo.until > Date.now()) return { ok: false, msg: `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ${waitText(Math.ceil((lo.until - Date.now()) / 1000))}.` };
  if (await C.checkPin(pin, await A.store.get('pin'))) {
    if (lo.fails || lo.until) await A.store.set('lockout', { fails: 0, until: 0 });
    return { ok: true };
  }
  lo.fails = (lo.fails || 0) + 1;
  const wait = LOCKOUT[Math.min(lo.fails, LOCKOUT.length - 1)];
  lo.until = wait ? Date.now() + wait * 1000 : 0;
  await A.store.set('lockout', lo);
  const left = 5 - lo.fails;
  return { ok: false, msg: wait ? `קוד שגוי. אפשר לנסות שוב בעוד ${waitText(wait)}.` : left === 1 ? 'קוד שגוי. נשאר ניסיון אחד לפני השהיה.' : `קוד שגוי. נשארו ${left} ניסיונות לפני השהיה.` };
}

export async function lockScreen({ onUnlock }) {
  const host = $('#lock');
  host.classList.remove('hidden');
  const myName = S.names[S.fam.role] || '';
  pinPad({
    host, heading: myName ? `שלום ${esc(myName)}` : 'FinPal', sub: 'הקלידו את קוד הנעילה',
    forgot: () => forgotPin(),
    onPin: async (pin, say) => {
      const r = await verifyPin(pin);
      if (!r.ok) { say(r.msg); return false; }
      host.classList.add('hidden'); host.innerHTML = '';
      await onUnlock();
      return true;
    }
  });
}

function forgotPin() {
  const partner = S.names[S.fam.other] || 'בן/בת הזוג';
  sheet(`<h3>שכחת את קוד הנעילה?</h3>
    <p>את הקוד אי אפשר לשחזר, אבל אפשר להתחיל מחדש בטלפון הזה בלי לאבד נתונים: מה שנשמר בדרייב נשאר שם.</p>
    <ol class="how"><li>מוחקים את הנתונים מהטלפון הזה.</li><li>נכנסים שוב עם <b>קוד השחזור</b> של המשפחה${S.fam.role === 'B' ? `, או עם הזמנה חדשה מ${esc(partner)}` : ''}.</li></ol>
    ${S.fam.mine.dirty ? notice('יש בטלפון הזה שינויים שעוד לא נשמרו בדרייב. הם יימחקו.') : ''}
    <button class="btn danger" id="fpWipe">מחיקת הנתונים מהטלפון הזה</button><button class="btn" id="fpBack">ביטול</button>`);
  $('#fpBack').onclick = closeSheet;
  $('#fpWipe').onclick = () => A.wipe();
}

// ------------------------------------------------------------------ setting up (the first partner)
const SETUP = 4;
function setupNames() {
  const el = screen(`<div class="top">${steps(1, SETUP)}<h1>מי במשפחה?</h1>
    <p>השמות יופיעו באפליקציה, למשל ליד כרטיסי האשראי של כל אחד.</p>
    <label class="field" for="nMe">השם שלך</label><input id="nMe" maxlength="30" autocomplete="given-name" placeholder="למשל יניב">
    <label class="field" for="nPartner">השם של בן/בת הזוג</label><input id="nPartner" maxlength="30" placeholder="למשל מיכל">
    <div class="error" id="nErr" role="alert"></div></div>
    <div class="actions"><button class="btn primary" id="nGo">המשך</button><button class="btn ghost" id="nBack">חזרה</button></div>`);
  $('#nBack', el).onclick = welcome;
  $('#nGo', el).onclick = () => {
    const me = $('#nMe').value.trim(), partner = $('#nPartner').value.trim();
    if (!me) { $('#nErr').textContent = 'מה השם שלך?'; return; }
    if (me === partner) { $('#nErr').textContent = 'צריך שני שמות שונים.'; return; }
    createHousehold({ me, partner });
  };
}

async function createHousehold(names) {
  await withBusy('יוצר את המפתח של המשפחה…', async () => {
    const cfg = A.config();
    await A.store.del('pin'); // a lock code is set later, only if wanted (עוד ← אבטחה)
    const code = await S.fam.create({ myName: names.me, partnerName: names.partner, clientId: cfg.clientId, apiKey: cfg.apiKey });
    A.markUnlocked();
    setupRecovery(code);
  });
}

function setupRecovery(code) {
  const el = screen(`<div class="top">${steps(2, SETUP)}<h1>קוד השחזור של המשפחה</h1>
    <p>זה המפתח לכל הנתונים. אם שני הטלפונים יאבדו, רק איתו אפשר לפתוח את מה שנשמר בדרייב. שמרו אותו במקום בטוח: צילום מסך לתיקייה פרטית, או על דף בבית.</p>
    <div class="code-box long" id="rcCode">${esc(code)}</div>
    <button class="btn" id="rcCopy">${icon('copy2')} העתקה</button>
    ${notice('לא שולחים את הקוד הזה לאף אחד. גם לא בוואטסאפ.')}
    <label class="check"><input type="checkbox" id="rcOk"> שמרתי את הקוד במקום בטוח</label></div>
    <div class="actions"><button class="btn primary" id="rcGo" disabled>המשך</button></div>`);
  $('#rcCopy', el).onclick = () => copyText(code);
  $('#rcOk', el).onchange = e => { $('#rcGo').disabled = !e.target.checked; };
  $('#rcGo', el).onclick = () => setupDrive();
}

export function googleFields(cfg) {
  const base = D.appBase();
  return `<label class="field" for="gCid">מזהה הלקוח (Client ID)</label>
    <input id="gCid" dir="ltr" spellcheck="false" autocomplete="off" value="${esc(cfg.clientId || '')}" placeholder="123456789-abc.apps.googleusercontent.com">
    <label class="field" for="gKey">מפתח ה-API</label>
    <input id="gKey" dir="ltr" spellcheck="false" autocomplete="off" value="${esc(cfg.apiKey || '')}" placeholder="AIza…">
    <details class="more"><summary>הכתובות שצריך לרשום בגוגל</summary>
      <p class="small" style="margin:6px 0">Authorized JavaScript origins:</p><div class="copy-row"><code>${esc(location.origin)}</code><button class="btn small" data-copy="${esc(location.origin)}">העתקה</button></div>
      <p class="small" style="margin:10px 0 6px">Authorized redirect URIs:</p><div class="copy-row"><code>${esc(base)}</code><button class="btn small" data-copy="${esc(base)}">העתקה</button></div>
    </details>
    <div class="error" id="gErr" role="alert"></div>`;
}

export function readGoogleFields() {
  const clientId = $('#gCid').value.trim(), apiKey = $('#gKey').value.trim();
  if (!D.validClientId(clientId)) { $('#gErr').textContent = 'מזהה הלקוח לא נראה תקין. הוא נגמר ב-apps.googleusercontent.com'; return null; }
  if (!D.validApiKey(apiKey)) { $('#gErr').textContent = 'מפתח ה-API לא נראה תקין. הוא מתחיל ב-AIza ויש בו 39 תווים'; return null; }
  return { clientId, apiKey };
}

function bindCopies(root) { $$('[data-copy]', root).forEach(b => b.onclick = () => copyText(b.dataset.copy)); }

function setupDrive() {
  const cfg = S.fam.cfg;
  // the site may come with its Google connection already filled in (config.js): then nothing to paste
  const ready = D.validClientId(cfg.clientId) && D.validApiKey(cfg.apiKey);
  const el = screen(`<div class="top">${steps(3, SETUP)}<h1>שמירה ב-Google Drive</h1>
    <p>כדי שהנתונים יופיעו גם בטלפון של ${esc(cfg.partnerName || 'בן/בת הזוג')}, האפליקציה שומרת קובץ מוצפן ב-Google Drive שלך. היא רואה רק את הקובץ הזה, לא שום דבר אחר בדרייב.</p>
    ${ready ? notice('בלחיצה על הכפתור ייפתח מסך של גוגל. בוחרים את החשבון שלך, ומסמנים את התיבה שמאשרת גישה לקבצים של FinPal.', 'green')
      : `${notice('צריך להקים פעם אחת חיבור בחשבון הגוגל שלך (כ-10 דקות). המדריך מסביר כל לחיצה. אחרי שתקבלו שני ערכים, מדביקים אותם כאן.')}
    <a class="btn" href="guide.html#google" target="_blank" rel="noopener">${icon('info')} המדריך להקמת החיבור</a>`}
    ${ready ? `<details class="more"><summary>פרטי החיבור (כבר מוגדרים)</summary>${googleFields(cfg)}</details>` : googleFields(cfg)}</div>
    <div class="actions"><button class="btn primary" id="gGo">${icon('google')} התחברות לגוגל</button>
      <button class="btn ghost" id="gLater">אחר כך. בינתיים אפשר לייבא ולראות נתונים רק בטלפון הזה</button></div>`);
  bindCopies(el);
  $('#gLater', el).onclick = () => A.enterApp();
  $('#gGo', el).onclick = async () => {
    const g = readGoogleFields();
    if (!g) return;
    await S.fam.setConfig(g);
    A.signIn('setup');
  };
}

/** the last step: after the first save to Drive */
export async function setupInvite() {
  const partner = S.names.B || S.fam.cfg.partnerName || 'בן/בת הזוג';
  const el = screen(`<div class="top">${steps(4, SETUP)}<h1>הזמנת ${esc(partner)}</h1>
    <p>שולחים ל${esc(partner)} קישור בוואטסאפ, ואומרים את הקוד בעל פה: בשיחה, או פנים מול פנים. בלי הקוד הקישור לא פותח כלום.</p>
    <div id="invBox"><div class="spinner" style="margin:20px auto"></div></div></div>
    <div class="actions"><button class="btn ghost" id="invDone">סיום</button></div>`);
  $('#invDone', el).onclick = () => A.enterApp();
  await inviteBox($('#invBox', el));
}

async function inviteBox(box) {
  const partner = S.names.B || 'בן/בת הזוג';
  try {
    const { code, link } = await S.fam.invite(D.appBase());
    const me = S.names.A || '';
    const text = `הזמנה${me ? ' מ' + me : ''} ל-FinPal משפחה, לראות ביחד את הכסף של הבית 💚\nפותחים את הקישור בטלפון, בכרום, ומקלידים את הקוד שאמרתי לך בעל פה:\n${link}`;
    box.innerHTML = `<p class="small" style="margin:0">הקוד ל${esc(partner)}:</p><div class="code-box">${esc(code)}</div>
      <button class="btn primary" id="invShare">${icon('share')} שליחת הקישור בוואטסאפ</button>
      <button class="btn" id="invCopy">${icon('copy2')} העתקת הקישור</button>
      <p class="small" style="margin:10px 0 0">את הקוד לא שולחים באותה הודעה. אפשר ליצור הזמנה חדשה בכל רגע, בלשונית "עוד".</p>`;
    $('#invShare', box).onclick = () => shareText(text, 'הזמנה ל-FinPal');
    $('#invCopy', box).onclick = () => copyText(link);
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(A.errorText(e))}</p><button class="btn" id="invRetry">ניסיון נוסף</button>`;
    $('#invRetry', box).onclick = () => inviteBox(box);
  }
}

export function inviteSheet() {
  const f = S.fam;
  if (!f.cfg.myFileId) {
    sheet(`<h3>הזמנת ${esc(S.names.B || 'בן/בת הזוג')}</h3><p>קודם צריך לשמור את הנתונים ב-Google Drive, כדי שיהיה מאיפה לקרוא אותם.</p>
      <button class="btn primary" id="isGo">${icon('google')} התחברות לגוגל ושמירה</button><button class="btn" id="isBack">ביטול</button>`);
    $('#isBack').onclick = closeSheet;
    $('#isGo').onclick = () => { closeSheet(); if (!f.cfg.clientId) A.act('google-setup'); else A.signIn('invite'); };
    return;
  }
  const body = sheet(`<h3>הזמנת ${esc(S.names.B || 'בן/בת הזוג')}</h3>
    <p>שולחים קישור בוואטסאפ, ואומרים את הקוד בעל פה. בלי הקוד הקישור לא פותח כלום.</p><div id="invBox"><div class="spinner" style="margin:20px auto"></div></div>
    <button class="btn ghost" id="isClose" style="margin-top:8px">סגירה</button>`);
  $('#isClose').onclick = closeSheet;
  inviteBox($('#invBox', body));
}

// ------------------------------------------------------------------ joining (the second partner)
export function joinScreen(payload) {
  let inv;
  try { inv = C.readInvite(payload); } catch (e) {
    screen(`<div class="top">${logo}<h1>הקישור לא שלם</h1><p>נראה שחלק מהקישור נחתך. בקשו קישור חדש, או העתיקו אותו שוב במלואו מההודעה.</p></div>
      <div class="actions"><button class="btn" id="jBack">חזרה</button></div>`);
    $('#jBack').onclick = welcome;
    return;
  }
  const el = screen(`<div class="top"><div class="pair" style="margin-bottom:6px">${avatar(inv.n || '?', 'a')}${avatar(inv.p || '?', 'b')}</div>
    <h1>הזמנה${inv.n ? ` מ${esc(inv.n)}` : ''} ל-FinPal משפחה</h1>
    <p>כאן רואים ביחד לאן הולך הכסף של הבית ואיפה אפשר לחסוך. מקלידים את קוד ההזמנה, שנאמר בעל פה.</p>
    <label class="field" for="jCode">קוד ההזמנה</label>
    <input id="jCode" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="20">
    <div class="error" id="jErr" role="alert"></div></div>
    <div class="actions"><button class="btn primary" id="jGo">הצטרפות</button><button class="btn ghost" id="jBack">ביטול</button></div>`);
  const input = $('#jCode', el);
  input.oninput = () => { input.value = C.groupCode(C.normCode(input.value).slice(0, C.INVITE_LEN), 4); };
  $('#jBack', el).onclick = welcome;
  $('#jGo', el).onclick = async () => {
    const code = C.normCode(input.value);
    if (code.length !== C.INVITE_LEN) { $('#jErr').textContent = 'הקוד בנוי משלוש קבוצות של ארבעה תווים.'; return; }
    let recovery;
    try { recovery = await withBusy('בודק את הקוד…', () => C.openInvite(inv, code)); } catch (e) {
      $('#jErr').textContent = 'הקוד לא מתאים לקישור הזה. בדקו אותו שוב, אותיות ומספרים.'; return;
    }
    joinName(inv, recovery);
  };
}

function joinName(inv, recovery) {
  const el = screen(`<div class="top">${steps(1, 2)}<h1>נעים מאוד</h1>
    <label class="field" for="jName">איך קוראים לך?</label><input id="jName" maxlength="30" value="${esc(inv.p || '')}">
    <div class="error" id="jnErr" role="alert"></div></div><div class="actions"><button class="btn primary" id="jnGo">המשך</button></div>`);
  $('#jnGo', el).onclick = async () => {
    const name = $('#jName').value.trim();
    if (!name) { $('#jnErr').textContent = 'מה השם שלך?'; return; }
    if (name === inv.n) { $('#jnErr').textContent = `זה השם של ${inv.n}. מה השם שלך?`; return; }
    await withBusy('מתחבר למשפחה…', async () => {
      await A.store.del('pin');
      await S.fam.joinWith(recovery, inv, name);
      A.markUnlocked();
      await A.afterJoin();
    });
    joinDrive();
  };
}

export function joinDrive() {
  const partner = S.names.A || S.fam.cfg.partnerName || '';
  const el = screen(`<div class="top">${steps(2, 2)}<h1>לייבא קבצים גם מהטלפון הזה?</h1>
    <p>כבר עכשיו רואים כאן את כל הקבצים שיובאו בטלפון של ${esc(partner)}. כדי לייבא קבצים גם מהטלפון הזה, מתחברים לגוגל פעם אחת, והם נשמרים בדרייב שלך.</p>
    ${notice('האפליקציה רואה רק את הקובץ שהיא עצמה יוצרת בדרייב שלך, לא שום דבר אחר.', 'green')}</div>
    <div class="actions"><button class="btn primary" id="jdGo">${icon('google')} התחברות לגוגל</button><button class="btn ghost" id="jdLater">לא עכשיו</button></div>`);
  $('#jdGo', el).onclick = () => A.signIn('join');
  $('#jdLater', el).onclick = () => A.enterApp();
}

/** "read my file here": after the second partner's first save, or after a file was made anew */
export function connectScreen(inApp) {
  const partner = S.names[S.fam.other] || 'בן/בת הזוג';
  const html = `<h${inApp ? 3 : 1}>שליחת קישור חיבור ל${esc(partner)}</h${inApp ? 3 : 1}>
    <p>פותחים את הקישור פעם אחת בטלפון של ${esc(partner)}, ומאז רואים שם גם את הקבצים שמיובאים בטלפון הזה.</p>
    ${S.fam.role === 'A' && !S.fam.cfg.partnerFileId ? `<p class="small">אם בטלפון של ${esc(partner)} עוד לא הצטרפו לאפליקציה, שולחים במקום זה הזמנה חדשה (עוד ← הזמנה).</p>` : ''}
    <button class="btn primary" id="ccShare">${icon('share')} שליחה בוואטסאפ</button><button class="btn" id="ccCopy">${icon('copy2')} העתקת הקישור</button>`;
  let root;
  if (inApp) root = sheet(html + '<button class="btn ghost" id="ccDone">סגירה</button>');
  else root = screen(`<div class="top">${logo}${html}</div><div class="actions"><button class="btn ghost" id="ccDone">סיום</button></div>`);
  $('#ccDone', root).onclick = () => { if (inApp) closeSheet(); else A.enterApp(); };
  const get = async () => S.fam.connectLink(D.appBase());
  const sent = async () => { await S.fam.connectSent(); A.refresh(); };
  $('#ccShare', root).onclick = async () => {
    try {
      const r = await shareText(`קישור חיבור ל-FinPal: פותחים אותו פעם אחת בטלפון, כדי לראות גם את הקבצים שייבאתי:\n${await get()}`, 'FinPal');
      if (r !== 'cancel') await sent();
    } catch (e) { toast(A.errorText(e)); }
  };
  $('#ccCopy', root).onclick = async () => { try { await copyText(await get()); await sent(); } catch (e) { toast(A.errorText(e)); } };
}

// ------------------------------------------------------------------ restoring
export function restoreScreen(prefill) {
  const cfg = Object.assign({}, A.config(), prefill || {});
  const el = screen(`<div class="top">${logo}<h1>שחזור עם קוד השחזור</h1>
    <p>הנתונים נשמרו מוצפנים בדרייב. עם קוד השחזור וההתחברות לאותו חשבון גוגל, הכול חוזר לטלפון הזה.</p>
    <label class="field" for="rCode">קוד השחזור (20 תווים)</label>
    <input id="rCode" class="code-input" style="font-size:18px" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX">
    ${D.validClientId(cfg.clientId) && D.validApiKey(cfg.apiKey) ? `<details class="more"><summary>פרטי החיבור לגוגל (כבר מוגדרים)</summary>${googleFields(cfg)}</details>` : googleFields(cfg)}</div>
    <div class="actions"><button class="btn primary" id="rGo">${icon('google')} התחברות לגוגל ושחזור</button><button class="btn ghost" id="rBack">חזרה</button></div>`);
  bindCopies(el);
  const rc = $('#rCode', el);
  rc.oninput = () => { rc.value = C.groupCode(C.normCode(rc.value).slice(0, C.RECOVERY_LEN), 5); };
  $('#rBack', el).onclick = welcome;
  $('#rGo', el).onclick = async () => {
    const r = $('#rCode').value;
    if (!C.validRecovery(r)) { $('#gErr').textContent = 'קוד השחזור בנוי מארבע קבוצות של חמישה תווים.'; return; }
    const g = readGoogleFields();
    if (!g) return;
    await A.store.set('pending_restore', { recovery: C.normCode(r), clientId: g.clientId, apiKey: g.apiKey, at: Date.now() });
    D.signIn({ clientId: g.clientId, after: 'restore' });
  };
}

export async function finishRestore() {
  const p = await A.store.get('pending_restore');
  await A.store.del('pending_restore');
  const tok = D.token();
  if (!p || Date.now() - p.at > 30 * 60 * 1000 || !tok) { restoreScreen(p || {}); toast('השחזור לא הושלם. נסו שוב.'); return; }
  await restoreAs(p, tok, '');
}

async function restoreAs(p, tok, role) {
  let res = null;
  try { res = await withBusy('מחפש את הנתונים בדרייב…', () => S.fam.restore(p.recovery, { clientId: p.clientId, apiKey: p.apiKey }, tok, role)); } catch (e) {
    restoreScreen(p); $('#gErr').textContent = A.errorText(e); return;
  }
  if (!res) {
    restoreScreen(p);
    $('#gErr').textContent = 'לא נמצאו נתונים של המשפחה הזו בחשבון הגוגל הזה. בדקו שהתחברתם לאותו חשבון ושהקוד נכון. אם בטלפון הזה לא שמרו בדרייב, בקשו הזמנה חדשה מהטלפון השני.';
    return;
  }
  if (res.ask) {
    // both partners saved with this Google account: the file to continue is the one of whoever uses this phone
    const el = screen(`<div class="top">${logo}<h1>מי משתמש בטלפון הזה?</h1>
      <p>בחשבון הגוגל הזה שמורים הקבצים של שניכם. בוחרים את השם של מי שהטלפון הזה שלו, כדי להמשיך מהקובץ הנכון.</p>
      ${res.ask.map(x => `<button class="btn" data-role="${x.role}">${esc(x.name || (x.role === 'A' ? 'שותף א' : 'שותף ב'))}</button>`).join('')}</div>
      <div class="actions"><button class="btn ghost" id="raBack">ביטול</button></div>`);
    $$('[data-role]', el).forEach(b => b.onclick = () => restoreAs(p, tok, b.dataset.role));
    $('#raBack', el).onclick = () => restoreScreen(p);
    return;
  }
  await A.store.del('pin');
  await A.store.del('lockout');
  A.markUnlocked();
  toast('הנתונים שוחזרו');
  A.enterApp();
}

// ------------------------------------------------------------------ importing
export function importSheet() {
  sheet(`<h3>ייבוא קובץ</h3>
    <p>קבצים מבנק לאומי ומכרטיסי MAX: Excel, CSV, XML או PDF. אפשר כמה קבצים בבת אחת, וקובץ שכבר יובא לא ייספר פעמיים.</p>
    <button class="btn primary" id="imPick">${icon('upload')} בחירת קבצים מהטלפון</button>
    <button class="btn" id="imHow">איך מורידים את הקובץ?</button>
    ${notice('טיפ: אחרי שמורידים קובץ, אפשר גם ללחוץ עליו לחיצה ארוכה בתיקיית ההורדות, לבחור "שיתוף" ואז את FinPal.')}`);
  $('#imPick').onclick = () => { closeSheet(); $('#fileInput').click(); };
  $('#imHow').onclick = howtoSheet;
}

export function howtoSheet() {
  sheet(`<h3>איך מורידים קובץ תנועות</h3>
    <p><b>בנק לאומי</b>: באתר או באפליקציה נכנסים לתנועות בחשבון העו״ש, בוחרים תקופה (למשל שלושה חודשים), ולוחצים על הייצוא לאקסל או ל-PDF.</p>
    <p><b>כרטיסי MAX</b>: באתר MAX נכנסים לפירוט העסקאות, בוחרים חודש, ולוחצים על הייצוא לאקסל. אפשר גם את דף הפירוט ב-PDF. כדאי להוריד כל חודש בנפרד.</p>
    <p class="small">אקסל מדויק יותר מ-PDF. קובץ PDF שהוא תמונה סרוקה לא ייקרא.</p>
    <p><b>ואז</b>: בטלפון, הקובץ נשמר בתיקיית ההורדות. לוחצים כאן על "ייבוא" ובוחרים אותו, או משתפים אותו ישירות ל-FinPal.</p>
    ${notice('בפעם הראשונה כדאי לייבא כמה חודשים אחורה: ככה האפליקציה לומדת מה רגיל אצלכם, ויכולה להציע איפה לחסוך.')}
    <button class="btn" id="htClose">הבנתי</button>`);
  $('#htClose').onclick = closeSheet;
}

const KIND = { leumi: 'לאומי', max: 'MAX' };
export function importResults(results, newCards) {
  const rows = results.map(r => {
    let ic = 'checkCircle', cls = 'ok', head = r.name, text = '';
    if (r.error) { ic = 'xCircle'; cls = 'bad'; text = r.error; }
    else if (r.status === 'same') { ic = 'same'; cls = 'same'; text = 'הקובץ הזה כבר יובא קודם'; }
    else if (r.status === 'duplicate' || (!r.added && !r.updated)) { ic = 'same'; cls = 'same'; text = `${KIND[r.kind] || ''}: כל התנועות כבר היו${r.dup ? ` (${fmt(r.dup)})` : ''}`; }
    else text = `${KIND[r.kind] || ''}: ${fmt(r.added)} תנועות חדשות${r.dup ? `, ${fmt(r.dup)} כבר היו` : ''}${r.updated ? `, ${fmt(r.updated)} עודכנו` : ''}`;
    return `<div class="result">${icon(ic, cls)}<div><b class="ellip">${esc(head)}</b><span class="small">${esc(text)}</span></div></div>`;
  }).join('');
  const added = results.reduce((a, r) => a + (r.added || 0), 0);
  const ex = (S.data && S.data.expected) || {};
  const late = (ex.items || []).filter(i => i.status === 'late');
  const lateHtml = late.length ? `<p style="margin:14px 0 4px;color:var(--ink)">לא הופיעו בדף הבנק בזמן:</p>${late.map(i => V.expectedLine(i, ex.as_of)).join('')}` : '';
  sheet(`<h3>${added ? `נוספו ${fmt(added)} תנועות` : 'הייבוא הסתיים'}</h3>${rows}${lateHtml}
    ${newCards.length ? `<p style="margin:14px 0 6px;color:var(--ink)">יש ${newCards.length === 1 ? 'כרטיס חדש' : `${newCards.length} כרטיסים חדשים`}. של מי?</p><div id="ownerBox"></div>` : ''}
    <button class="btn primary" id="irDone" style="margin-top:14px">${newCards.length ? 'אחר כך' : 'סגירה'}</button>`);
  $('#irDone').onclick = closeSheet;
  if (newCards.length) ownerRows($('#ownerBox'), newCards, true);
}

function ownerRows(box, cards, inResults) {
  const n = S.names;
  box.innerHTML = cards.map(c => `<div style="margin:10px 0"><b>כרטיס <span class="num">${esc(c)}</span></b>
    <div class="owner-pick" data-card="${esc(c)}"><button data-o="A">${esc(n.A || 'שותף א')}</button><button data-o="B">${esc(n.B || 'שותף ב')}</button><button data-o="shared">משותף</button></div></div>`).join('');
  $$('.owner-pick', box).forEach(row => $$('button', row).forEach(b => b.onclick = async () => {
    $$('button', row).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    await A.setOwner(row.dataset.card, b.dataset.o);
    const left = $$('.owner-pick', box).filter(r => !$('[aria-pressed="true"]', r));
    if (!left.length) { if (inResults) $('#irDone').textContent = 'סיום'; toast('נשמר'); }
  }));
}

export function ownerSheet(cards) {
  sheet(`<h3>של מי ${cards.length === 1 ? 'הכרטיס' : 'הכרטיסים'}?</h3><p>ההוצאות בכרטיס ייספרו אצל מי שבחרתם, בשני הטלפונים.</p><div id="ownerBox"></div>
    <button class="btn" id="osDone" style="margin-top:12px">סגירה</button>`);
  $('#osDone').onclick = closeSheet;
  ownerRows($('#ownerBox'), cards, false);
}

// ------------------------------------------------------------------ how the forecast was made
export function forecastSheet() {
  const d = S.data || {}, f = d.forecast || {}, rows = d.forecast_rows || [];
  if (f.net_forecast == null) return;
  const z = v => (Math.abs(v || 0) < 0.5 ? 0 : v);
  const part = (list, total, verb) => {
    const shown = list.filter(r => z(r.forecast) || z(r.actual)).slice(0, 8);
    const rest = total - shown.reduce((a, r) => a + r.forecast, 0);
    return shown.map(r => {
      const more = z(r.forecast - r.actual);
      return line(esc(r.category), money(r.forecast),
        more > 0 ? `${verb} עד עכשיו ${money(z(r.actual))}, בדרך כלל ${money(r.avg)}: צפויים עוד ${money(more)}` : `${verb} עד עכשיו ${money(z(r.actual))}, יותר מהרגיל`);
    }).join('') + (z(rest) > 0 ? line('<span class="muted">שאר הקטגוריות</span>', money(rest)) : '');
  };
  const inc = rows.filter(r => r.kind === 'income'), exp = rows.filter(r => r.kind === 'expense'), sav = rows.filter(r => r.kind === 'saving');
  const n = f.net_forecast;
  sheet(`<div class="fc"><h3>איך חישבנו את הצפי</h3>
    <p class="small" style="margin:0">לכל קטגוריה לוקחים את הגבוה מבין שניים: מה שכבר נכנס או יצא בה החודש, או הממוצע שלה בשלושת החודשים הקודמים. כך הצפי מניח שמה שבדרך כלל קורה בחודש עוד יקרה, למשל משכורת שעוד לא נכנסה. חיוב אשראי נספר בחודש שבו הוא יורד מהבנק.</p>
    <h4><span>הכנסות צפויות</span>${money(f.income_forecast)}</h4>${part(inc, f.income_forecast || 0, 'נכנסו')}
    <h4><span>הוצאות צפויות</span>${money(f.expense_forecast)}</h4>${part(exp, f.expense_forecast || 0, 'יצאו')}
    ${z(f.saving_forecast) ? `<h4><span>חיסכון צפוי</span>${money(f.saving_forecast)}</h4>${part(sav, f.saving_forecast, 'הועברו')}` : ''}
    ${line(`<b>${n >= 0 ? 'צפוי להישאר' : 'צפוי לחסור'}</b>`, `<b class="${n >= 0 ? 'pos' : 'neg'}">${money(n, true)}</b>`, `הכנסות פחות הוצאות${z(f.saving_forecast) ? ' וחיסכון' : ''}`, '', 'style="border-top:2px solid var(--hair);margin-top:8px"')}
    <p class="small">המספר לא מבוסס על חלוקה של מה שיצא עד היום במספר הימים, ולכן הוא לא קופץ בתחילת החודש. כשמייבאים קבצים חדשים, הוא מתעדכן.</p>
    <button class="btn primary" id="fcDone">הבנתי</button></div>`);
  $('#fcDone').onclick = closeSheet;
}

// ------------------------------------------------------------------ reminders to import fresh files
/** a monthly reminder on the day after salaries and charges usually come: added to Google Calendar, on each phone */
export function remindersSheet() {
  const e = (S.data && S.data.expected) || {};
  const list = e.reminders || [];
  if (!list.length) return;
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const app = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  const link = r => {
    // the next one: this month if its day (at 20:00) is still ahead, or else next month
    let y = now.getFullYear(), m = now.getMonth() + 1;
    if (now.getDate() > r.day || (now.getDate() === r.day && now.getHours() >= 20)) { m += 1; if (m > 12) { m = 1; y += 1; } }
    const d = `${y}${pad(m)}${pad(r.day)}`;
    const what = r.what.map(w => `${V.payName(w)} (בדרך כלל ב-${w.day})`).join('\n');
    const q = new URLSearchParams({
      action: 'TEMPLATE', text: 'FinPal: לייבא דף חשבון ודפי אשראי', dates: `${d}T200000/${d}T201500`, ctz: 'Asia/Jerusalem',
      details: `עד היום בדרך כלל כבר נכנסו או ירדו:\n${what}\n\nמורידים את הקבצים באפליקציה של הבנק או של MAX, לוחצים "שתף" ובוחרים FinPal.\n${app}`,
      recur: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${r.day}`,
    });
    return `https://calendar.google.com/calendar/render?${q}`;
  };
  sheet(`<h3>תזכורות לייבוא קבצים</h3>
    <p class="small">האפליקציה זיהתה מתי המשכורות והחיובים שלכם בדרך כלל נכנסים. ביום שאחרי כדאי לייבא דף חשבון ודפי אשראי: ככה המספרים עדכניים, ורואים מיד אם משכורת לא נכנסה או חיוב לא ירד.</p>
    ${list.map(r => `<div class="line"><span class="lbl"><b>ב-${r.day} בכל חודש, 20:00</b><span class="sub">אחרי: ${r.what.map(w => esc(V.payName(w))).join(' · ')}</span></span>
      <a class="btn small" href="${esc(link(r))}" target="_blank" rel="noopener" data-cal="${r.day}">הוספה ליומן</a></div>`).join('')}
    <p class="small">כל אחד מכם מוסיף את התזכורות ביומן Google שלו. אם המשכורות יתחילו להגיע בימים אחרים, הימים כאן יתעדכנו מעצמם.</p>
    <button class="btn" id="rmDone">סגירה</button>`);
  $('#rmDone').onclick = closeSheet;
}

// ------------------------------------------------------------------ a transaction
const WHY = {
  settle: 'לא נספר: זה חיוב האשראי בבנק, והקניות שמאחוריו מפורטות בנפרד מדף האשראי. כך שום הוצאה לא נספרת פעמיים.',
  undetailed: 'חיוב אשראי בלי פירוט: דף האשראי של החודש הזה לא יובא, ולכן הוא נספר כהוצאה אחת. אחרי ייבוא הדף יופיעו הקניות עצמן.',
  internal: 'לא נספר כהכנסה או כהוצאה: הלוואה, או כסף שעבר בין החשבונות שלכם.',
  salary: 'סווג כמשכורת כי סכום דומה נכנס מאותו מקום כמעט כל חודש.',
  moved: 'סווג כחיסכון: זו העברה של כסף שנמשך מחיסכון או מקופת גמל ימים ספורים לפני כן, ולא הוצאה.',
};
export function txSheet(uid) {
  const t = ((S.data && S.data.transactions) || []).find(x => x.u === uid);
  if (!t) return;
  // expenses get the expense categories (and savings), income the income ones; the current one always stays
  const all = (S.data && S.data.categories) || {};
  const fits = k => (t.a < 0 ? k === 'expense' || k === 'saving' : k === 'income') || k === 'internal';
  const cats = Object.keys(all).filter(c => c === t.c || fits(all[c].k)).sort((a, b) => a.localeCompare(b, 'he'));
  // a transfer ("העברה דיגיטל", BIT) names no shop: what one of them is says nothing about the others
  const transfer = /^העברות|^העברה בין/.test(t.c || '') || /העברה|הע\. |bit|ביט|paybox|פייבוקס/i.test(t.s || '');
  sheet(`<h3>${esc(t.s)}</h3>
    ${line('סכום', `<span class="${t.a > 0 ? 'pos' : ''}">${money(t.a, true)}</span>`)}
    ${line('תאריך', esc(dmy(t.d)), t.cd && t.cd !== t.d ? `חיוב ב-${dmy(t.cd)}` : '')}
    ${line('של מי', `<span class="tag ${who(t.o)}">${esc(t.o || '')}</span>`, t.card ? `כרטיס ${esc(t.card)}` : (t.src === 'leumi' ? 'חשבון הבנק' : ''))}
    ${t.i ? line('תשלומים', esc(String(t.i).replace('/', ' מתוך '))) : ''}
    ${t.p ? notice('עסקה בקליטה: הסכום הסופי יתעדכן כשהיא תיכנס לחיוב.') : ''}
    ${t.w && WHY[t.w] ? notice(WHY[t.w]) : ''}
    ${transfer && Math.abs(t.a) >= 2000 && !t.x ? notice('העברה גדולה לחשבון אחר שלכם, או לחיסכון או להשקעות? בחרו "העברה בין החשבונות שלנו" או "השקעות וחיסכון", והיא לא תיספר כהוצאה.') : ''}
    <label class="field" for="txCatSel">קטגוריה</label>
    <select id="txCatSel">${cats.map(c => `<option ${c === t.c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" id="txLearn"${transfer ? '' : ' checked'}> לסווג כך גם עסקאות אחרות מאותו בית עסק</label>
    <button class="btn primary" id="txSave">שמירה</button><button class="btn" id="txClose">ביטול</button>`);
  $('#txClose').onclick = closeSheet;
  $('#txSave').onclick = async () => {
    const cat = $('#txCatSel').value, learn = $('#txLearn').checked;
    if (cat === t.c && !learn) { closeSheet(); return; }
    closeSheet();
    await A.setCategory([uid], cat, learn);
    toast(learn ? `נשמר. גם עסקאות אחרות מ"${t.s}" יסווגו כ"${cat}"` : 'נשמר');
  };
}

// ------------------------------------------------------------------ a subscription or standing order
export function recurringSheet(id) {
  const i = ((S.data && S.data.recurring && S.data.recurring.items) || []).find(x => x.id === id);
  if (!i) return;
  sheet(`<h3>${esc(i.n)}</h3>
    ${line('מחיר', money(i.p), i.k === 2 ? 'כל חודשיים' : 'בכל חודש', `${money(i.y)} בשנה`)}
    ${i.s === 'up' ? notice(`המחיר עלה ב-${money(i.d)}. כדאי להתקשר ולבקש את המחיר הקודם, או לבדוק הצעה של מתחרה.`) : ''}
    ${i.s === 'double' ? notice('החודש היו שני חיובים. כדאי לבדוק שלא חויבתם פעמיים.') : ''}
    <label class="field" for="peDate">מתי נגמר המבצע? (לא חובה)</label><input id="peDate" type="date" value="${esc(i.pe || '')}">
    <label class="field" for="pePrice">המחיר אחרי המבצע (לא חובה)</label><input id="pePrice" type="number" inputmode="decimal" min="0" step="1" placeholder="₪">
    <p class="hint">חודש לפני סוף המבצע תופיע תזכורת, כדי שתספיקו להתמקח או לעבור.</p>
    <label class="check"><input type="checkbox" id="peMute"> לא להתריע יותר על החיוב הזה</label>
    <button class="btn primary" id="peSave">שמירה</button><button class="btn" id="peClose">ביטול</button>`);
  $('#peClose').onclick = closeSheet;
  $('#peSave').onclick = async () => {
    // an empty date clears the promotion; an empty price keeps the one saved before
    const price = $('#pePrice').value.trim();
    const note = { promo_end: $('#peDate').value, muted: $('#peMute').checked };
    if (price) note.promo_price = Math.max(0, +price || 0);
    closeSheet();
    await A.setRecurringNote(i.id, note);
    toast('נשמר');
  };
}

// ------------------------------------------------------------------ about the data
export function privacySheet() {
  const partner = S.names[S.fam.other] || 'בן/בת הזוג';
  sheet(`<h3>איפה הנתונים שלנו נשמרים</h3>
    <div class="result">${icon('phone', 'ok')}<div><b>בטלפון</b><span class="small">שמורים בטלפון בלבד. אפשר לנעול את האפליקציה בקוד (עוד ← אבטחה).</span></div></div>
    <div class="result">${icon('cloud', 'ok')}<div><b>ב-Google Drive</b><span class="small">לכל אחד מכם קובץ מוצפן בדרייב שלו. גוגל, ומי שיקבל את הקובץ, יראו רק רצף תווים חסר משמעות. המפתח נמצא רק בשני הטלפונים.</span></div></div>
    <div class="result">${icon('bank', 'ok')}<div><b>אין חיבור לבנק</b><span class="small">האפליקציה לא יודעת את הסיסמאות שלכם לבנק או לאשראי, ולא מתחברת אליהם. היא קוראת רק קבצים שהורדתם.</span></div></div>
    <div class="result">${icon('shield', 'ok')}<div><b>אין שרתים</b><span class="small">אין לנו שרת, ואף אחד מלבדך ומלבד ${esc(partner)} לא רואה את הנתונים.</span></div></div>
    <div class="result">${icon('key', 'ok')}<div><b>קוד השחזור</b><span class="small">אם שני הטלפונים יאבדו, רק איתו אפשר לפתוח את מה שבדרייב. שמרו אותו במקום בטוח.</span></div></div>
    <a class="btn ghost" href="privacy.html" target="_blank" rel="noopener" style="margin-top:10px">מדיניות הפרטיות המלאה</a>
    <button class="btn" id="pvClose">סגירה</button>`);
  $('#pvClose').onclick = closeSheet;
}

function showRecovery() {
  const code = C.groupCode(S.fam.cfg.recovery);
  sheet(`<h3>קוד השחזור של המשפחה</h3><p>רק איתו אפשר לפתוח את הנתונים שבדרייב אם שני הטלפונים יאבדו. לא שולחים אותו לאף אחד.</p>
    <div class="code-box long">${esc(code)}</div><button class="btn" id="rsCopy">${icon('copy2')} העתקה</button><button class="btn ghost" id="rsClose">סגירה</button>`);
  $('#rsCopy').onclick = () => copyText(code);
  $('#rsClose').onclick = closeSheet;
}

export async function recoverySheet() {
  if (!(await A.store.get('pin'))) { showRecovery(); return; }
  sheet('<div id="rcHost" class="lock" style="position:static;min-height:60vh"></div>');
  pinPad({
    host: $('#rcHost'), heading: 'קוד השחזור', sub: 'לאישור, הקלידו את קוד הנעילה', cancel: closeSheet,
    onPin: async (pin, say) => {
      const r = await verifyPin(pin);
      if (!r.ok) { say(r.msg); return false; }
      showRecovery();
      return true;
    }
  });
}

/** turning the lock code on: four digits, twice */
export function pinOnSheet() {
  sheet('<div id="poHost" class="lock" style="position:static;min-height:60vh"></div>');
  newPin($('#poHost'), 'קוד נעילה', async pin => {
    await A.store.set('pin', await C.hashPin(pin));
    await A.store.set('lockout', { fails: 0, until: 0 });
    closeSheet();
    A.pinChanged(true);
    toast('קוד הנעילה הופעל');
  }, closeSheet);
}

/** turning it off asks for the code first */
export function pinOffSheet() {
  sheet('<div id="pfHost" class="lock" style="position:static;min-height:60vh"></div>');
  pinPad({
    host: $('#pfHost'), heading: 'כיבוי קוד הנעילה', sub: 'לאישור, הקלידו את קוד הנעילה', cancel: closeSheet,
    onPin: async (pin, say) => {
      const r = await verifyPin(pin);
      if (!r.ok) { say(r.msg); return false; }
      await A.store.del('pin');
      await A.store.del('lockout');
      closeSheet();
      A.pinChanged(false);
      toast('קוד הנעילה כובה');
      return true;
    }
  });
}

export function changePinSheet() {
  sheet('<div id="cpHost" class="lock" style="position:static;min-height:60vh"></div>');
  pinPad({
    host: $('#cpHost'), heading: 'שינוי קוד הנעילה', sub: 'קודם, הקוד הנוכחי', cancel: closeSheet,
    onPin: async (pin, say) => {
      const r = await verifyPin(pin);
      if (!r.ok) { say(r.msg); return false; }
      newPin($('#cpHost'), 'קוד חדש', async p2 => {
        await A.store.set('pin', await C.hashPin(p2));
        closeSheet(); toast('קוד הנעילה הוחלף');
      }, closeSheet);
      return true;
    }
  });
}

export function googleSetupSheet() {
  const cfg = S.fam.cfg;
  const body = sheet(`<h3>פרטי החיבור לגוגל</h3><p>הערכים מההקמה ב-Google Cloud. משנים רק אם יצרתם חדשים.</p>
    <a class="btn" href="guide.html#google" target="_blank" rel="noopener">${icon('info')} המדריך</a>${googleFields(cfg)}
    <button class="btn primary" id="gsSave">שמירה והתחברות</button><button class="btn" id="gsClose">ביטול</button>`);
  bindCopies(body);
  $('#gsClose').onclick = closeSheet;
  $('#gsSave').onclick = async () => {
    const g = readGoogleFields();
    if (!g) return;
    const changed = g.clientId !== cfg.clientId;
    await S.fam.setConfig(g);
    if (changed) D.dropToken();
    closeSheet();
    A.signIn('push');
  };
}

export function confirmSheet({ title, text, body, yes, no, danger }) {
  return new Promise(resolve => {
    sheet(`<h3>${title}</h3>${body || `<p>${text}</p>`}<button class="btn ${danger ? 'danger' : 'primary'}" id="cfYes">${yes}</button><button class="btn" id="cfNo">${no || 'ביטול'}</button>`,
      { onClose: () => resolve(false) });
    $('#cfYes').onclick = () => { sheet.onClose = null; closeSheet(); resolve(true); };
    $('#cfNo').onclick = () => { sheet.onClose = null; closeSheet(); resolve(false); };
  });
}

export { busy, unbusy };
