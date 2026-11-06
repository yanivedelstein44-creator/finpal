/* FinPal Family - the screens: home, savings, transactions, months, more, and the pages behind them. */
import {
  S, $, $$, esc, money, abs$, pct, fmt, monthLabel, monthName, shortMonth, dmy, dm, dayLabel, line, barRows, icon,
  who, colorOf, avatar, daysLeftInMonth, ago, COLORS, notice, localDate, catIcon, countUp, themePref
} from './kit.js';

let A = {}; // actions, set by app.js
export function setActions(a) { A = a; }

const people = () => (S.data && S.data.owners) || [];
const spenders = () => people().filter(o => !o.bank && o.profile && o.profile.data_points);
const hasData = () => !!(S.data && (S.data.transactions || []).length);
const meName = () => S.names[S.fam.role] || '';
const partnerName = () => S.names[S.fam.other] || '';

function title(text, sub, back) {
  return `<h1 class="title">${back ? `<button class="btn ghost small" data-back style="padding:4px 0;margin-bottom:2px">${icon('back')} חזרה</button>` : ''}${text}${sub ? `<small>${sub}</small>` : ''}</h1>`;
}

// ------------------------------------------------------------------ empty
function emptyHome() {
  const b = S.fam.role === 'B';
  const partnerHasFile = !!(S.fam.cfg && S.fam.cfg.partnerFileId);
  return `${title(`${monthLabel(new Date().toISOString().slice(0, 7))}`, 'הכסף של המשפחה')}
  <section class="card empty-card">${icon('upload')}
    <h2>${b && partnerHasFile ? `עוד אין נתונים מ${esc(partnerName())}` : 'מתחילים מקובץ אחד'}</h2>
    <p class="small" style="margin:0 0 14px">${b && partnerHasFile
      ? `כשיובא קובץ מהבנק או מהאשראי בטלפון של ${esc(partnerName())}, הכול יופיע כאן אוטומטית. אפשר גם לייבא קובץ מהטלפון הזה.`
      : 'מורידים קובץ תנועות מאתר הבנק (לאומי) או של כרטיס האשראי (MAX), ומייבאים אותו לכאן. אפשר כמה קבצים בבת אחת.'}</p>
    <button class="btn primary" data-act="import">${icon('upload')} ייבוא קובץ</button>
    <button class="btn ghost" data-act="howto">איך מורידים את הקובץ?</button>
  </section>`;
}

// ------------------------------------------------------------------ home
function sentence(f) {
  let s = `החודש נכנסו ${abs$(f.income_actual)} ויצאו ${abs$(f.expense_actual)}.`;
  const n = f.net_forecast;
  if (n != null) s += n >= 0 ? ` בקצב הזה יישארו לכם ${abs$(n)} בסוף החודש.` : ` בקצב הזה יחסרו לכם ${abs$(n)} בסוף החודש.`;
  return s;
}

/** "‹ אוקטובר": the month before, opened in the months tab */
function prevMonthLink(d) {
  const p = addMonths(d.month, -1);
  if (!(d.months || []).some(m => m.m === p)) return '';
  return ` <button class="hero-prev" data-open-month="${esc(p)}" aria-label="פירוט ${esc(monthName(p))}">${esc(monthName(p))} ‹</button>`;
}

function heroCard(d) {
  const f = d.forecast || {}, b = d.budget, n = f.net_forecast;
  const meter = b && b.pct != null ? (() => {
    const col = b.pct >= 100 ? 'var(--rose)' : b.pct >= 85 ? 'var(--gold)' : 'var(--green-light)';
    return `<div class="meter"><span style="width:${Math.min(100, Math.max(0, +b.pct))}%;background:${col}"></span></div>
      <div class="meter-note">יצאו ${pct(b.pct)} מההכנסות שצפויות להיכנס החודש</div>`;
  })() : '';
  return `<section class="hero${n == null ? '' : ' tap'}" aria-label="החודש במבט אחד"${n == null ? '' : ' data-act="forecast" role="button" tabindex="0"'}>
    <div class="k">${esc(monthLabel(d.month))} · צפי לסוף החודש${prevMonthLink(d)}</div>
    <div class="big ${n < 0 ? 'neg' : ''}"${n == null ? '' : ` data-count="${Math.round(n)}" data-signed="1"`}>${n == null ? '—' : money(n, true)}</div>
    <div class="say">${n == null ? '' : `${n >= 0 ? 'זה מה שצפוי להישאר בסוף החודש' : 'זה מה שצפוי לחסור בסוף החודש'}, לפי מה שכבר עבר החודש והממוצע שלכם. <u>איך חישבנו?</u>`}</div>
    <div class="stats">
      <div class="stat"><span>נכנסו</span><b>${abs$(f.income_actual)}</b></div>
      <div class="stat"><span>יצאו</span><b>${abs$(f.expense_actual)}</b></div>
      <div class="stat"><span>בעו״ש</span><b>${d.balance && d.balance.amount != null ? money(d.balance.amount) : '—'}</b></div>
    </div>${meter}</section>`;
}

/** a salary or a card charge by name: "משכורת: עיריית ראשל"צ", "חיוב לאומי ויזה, כרטיס 8149" (not escaped) */
/** the payer or the card company as the bank writes it, without the bank's additions */
function payerOf(i) {
  // "משכורת - בית חולים" under the title "משכורת": the payer only; the bank's "-י" at the end goes
  return String(i.name || '').replace(/[-\s]י$/, '').replace(/^מקס איט.*$/, 'MAX').replace(/^משכורת\s*-\s*(?=\S)/, '');
}
const incomeWord = i => (i.category === 'קצבאות וביטוח לאומי' ? 'קצבה' : 'משכורת');
export function payName(i) {
  const name = payerOf(i);
  if (i.kind === 'income') return `${incomeWord(i)}: ${name}`;
  return `חיוב ${name}${i.card ? `, כרטיס ${i.card}` : ''}`;
}
/** in a sentence: "משכורת מעיריית…", "קצבה מביטוח לאומי", "חיוב לאומי ויזה של כרטיס 8843" (not escaped) */
function payPhrase(i) {
  const name = payerOf(i);
  if (i.kind !== 'income') return `חיוב ${name}${i.card ? ` של כרטיס ${i.card}` : ''}`;
  // the prefix letter before a name in Latin letters or digits takes a hyphen: מ-MAX
  return `${incomeWord(i)} ${/^[\u0590-\u05FF]/.test(name) ? 'מ' : 'מ-'}${name}`;
}

/** the salaries and card charges that come every month: has each come this month, by the bank's file */
export function expectedLine(i, asOf) {
  const income = i.kind === 'income';
  const title = esc(payName(i));
  const usual = `בדרך כלל ב-${i.day} לחודש, כ-${money(i.amount)}`;
  let ic, cls, sub;
  if (i.status === 'done') {
    ic = 'checkCircle'; cls = 'ok';
    sub = `${income ? 'נכנסה' : 'ירד'} ${money(i.actual)} ב-${dm(i.date)}${!income && i.detail === false ? '. אין פירוט: כדאי לייבא את דף האשראי' : ''}`;
  } else if (i.status === 'late') {
    ic = 'alert'; cls = 'bad';
    sub = `${income ? 'לא נכנסה' : 'לא ירד'} עד ${dm(asOf)}. ${usual}`;
  } else if (i.status === 'expected') {
    ic = 'clock'; cls = 'wait';
    sub = `${income ? 'עוד לא נכנסה' : 'עוד לא ירד'}. ${usual}`;
  } else {
    ic = 'clock'; cls = 'same';
    sub = usual;
  }
  return `<div class="result">${icon(ic, cls)}<div><b class="ellip">${title}</b><span class="small">${sub}</span></div></div>`;
}

/** a budget at 80% or more of its sum this month, on the home screen */
function budgetAlerts() {
  const b = S.budgets || {}, m = curMonth();
  const near = Object.keys(b).map(c => [c, Math.max(0, spentIn(c, m)), b[c]]).filter(([, s, cap]) => cap && s >= 0.8 * cap);
  if (!near.length) return '';
  return `<section class="card tap" data-go-tab="save"><h2>${icon('target')} תקציב <small>${near.some(([, s, cap]) => s >= cap) ? 'יש חריגה' : 'מתקרבים לגבול'}</small></h2>
    ${near.map(([c, s, cap]) => line(esc(c), `<span class="${s >= cap ? 'neg' : ''}">${money(s)}</span>`, `${fmt(s / cap * 100)}% מהתקציב`, `מתוך ${money(cap)}`, '', catIcon(c))).join('')}</section>`;
}

function expectedCard(d) {
  const e = d.expected || {};
  const items = e.items || [];
  if (!items.length || !e.as_of) return '';
  const today = localDate();
  const days = Math.round((Date.parse(today) - Date.parse(e.as_of)) / 864e5);
  // the bank's file ends some days ago: what came after it cannot show yet
  const old = days >= 3 && items.some(i => i.status === 'expected' && i.day < +today.slice(8, 10));
  const late = items.filter(i => i.status === 'late').length;
  return `<section class="card"><h2>מה נכנס ומה עוד צפוי <small>לפי דף הבנק עד ${dm(e.as_of)}</small></h2>
    ${late ? notice(`${late === 1 ? 'משהו שמגיע כל חודש לא הופיע' : `${late} דברים שמגיעים כל חודש לא הופיעו`} בדף הבנק בזמן. כדאי לבדוק.`) : ''}
    ${items.map(i => expectedLine(i, e.as_of)).join('')}
    ${old ? `<p class="small" style="margin:8px 0 0">דף הבנק שיובא מסתיים ב-${dm(e.as_of)}. כדי לראות מה נכנס וירד מאז, ייבאו דף חשבון עדכני.</p>` : ''}
    ${(e.reminders || []).length ? `<div class="line tap" data-act="reminders" style="margin-top:6px"><span class="lbl">${icon('calendar', 'inl')}תזכורות לייבוא קבצים<span class="sub">${(e.reminders || []).map(r => `ב-${r.day}`).join(', ')} לחודש, אחרי שהמשכורות והחיובים נכנסים</span></span><span class="amt" style="color:var(--green)">הוספה ליומן</span></div>` : ''}</section>`;
}

/** one sentence for today, the most useful one: something that did not come, what comes in the next days,
    a budget, a goal. Nothing when there is nothing worth saying. */
export function todayLine(d, now = new Date()) {
  const e = d.expected || {}, items = e.items || [];
  const say = (ic, html, warn) => `<p class="today-line${warn ? ' warn' : ''}">${icon(ic)}<span>${html}</span></p>`;
  const late = items.filter(i => i.status === 'late');
  if (late.length === 1) {
    const i = late[0], inc = i.kind === 'income';
    return say('alert', `${esc(payName(i))} · ${inc ? 'לא נכנסה' : 'לא ירד'} עד ${dm(e.as_of)}, ובדרך כלל ${inc ? 'נכנסת' : 'יורד'} ב-${i.day} לחודש. כדאי לבדוק.`, true);
  }
  if (late.length > 1) return say('alert', `${late.length} דברים שמגיעים כל חודש לא הופיעו בדף הבנק בזמן. הפרטים למטה.`, true);
  const day = now.getDate();
  const soon = items.filter(i => (i.status === 'expected' || i.status === 'unknown') && i.day >= day && i.day <= day + 3)
    .sort((a, b) => a.day - b.day);
  if (soon.length) {
    const when = i => { const k = i.day - day; return k === 0 ? 'היום' : k === 1 ? 'מחר' : k === 2 ? 'מחרתיים' : `ב-${i.day}.${now.getMonth() + 1}`; };
    if (soon.length === 1) {
      const i = soon[0];
      return say('calendar', `${when(i)} ${i.kind === 'income' ? 'צפויה להיכנס' : 'צפוי לרדת'} ${esc(payPhrase(i))}, בערך ${money(i.amount)}.`);
    }
    return say('calendar', `בימים הקרובים: ${soon.slice(0, 3).map(i => `${when(i)} ${esc(payPhrase(i))} (כ-${money(i.amount)})`).join(' · ')}.`);
  }
  // the budget nearest its sum (from half of it on)
  const m = localDate(now).slice(0, 7), b = S.budgets || {};
  const bud = Object.keys(b).map(c => ({ c, s: Math.max(0, spentIn(c, m)), cap: b[c] })).filter(x => x.cap > 0 && x.s >= 0.5 * x.cap)
    .sort((x, y) => y.s / y.cap - x.s / x.cap)[0];
  if (bud) {
    return bud.s >= bud.cap
      ? say('target', `${esc(bud.c)} · יצאו ${money(bud.s)} החודש, ${money(bud.s - bud.cap)} מעל התקציב.`, true)
      : say('target', `${esc(bud.c)} · נשארו ${money(bud.cap - bud.s)} מתוך ${money(bud.cap)} לחודש הזה.`);
  }
  // the goal with the nearest date
  const g = (S.goals || []).map(x => ({ x, n: goalMonths(x.by, m) })).filter(o => o.n > 0 && (o.x.saved || 0) < o.x.amount)
    .sort((p, q) => p.n - q.n)[0];
  if (g) {
    const left = g.x.amount - (g.x.saved || 0);
    return say('flag', `${esc(g.x.name)} · חסרים ${money(left)}. ${money(Math.ceil(left / g.n))} בחודש יביאו אתכם לשם עד ${esc(monthLabel(g.x.by))}.`);
  }
  return '';
}

/** in the first ten days of a month: the month that was, in one card */
const RECAP_KEY = 'finpal.recap';
function recapHidden() { try { return localStorage.getItem(RECAP_KEY) || ''; } catch (e) { return ''; } }
export function hideRecap(m) { try { localStorage.setItem(RECAP_KEY, m); } catch (e) { /* private mode */ } }
export function recapCard(d, now = new Date()) {
  if (now.getDate() > 10) return '';
  const prev = addMonths(d.month, -1);
  const m = (d.months || []).find(x => x.m === prev);
  if (!m || !(m.inc > 0 || m.exp > 0) || recapHidden() === prev) return '';
  const before = (d.months || []).find(x => x.m === addMonths(prev, -1));
  const all = ((d.month_cats || {})[prev] || []).filter(c => c.t > 0);
  const top = all.filter(c => c.c !== UND).slice(0, 3);
  const und = all.find(c => c.c === UND), gen = all.find(c => c.c === 'כללי');
  const net = m.net;
  let cmp = '';
  if (before && before.exp > 0) {
    const dlt = m.exp - before.exp;
    cmp = Math.abs(dlt) < 0.02 * before.exp ? `כמו ב${esc(monthName(before.m))}.`
      : `<span class="${dlt > 0 ? 'neg' : 'pos'}">${money(Math.abs(dlt))} ${dlt > 0 ? 'יותר' : 'פחות'}</span> מאשר ב${esc(monthName(before.m))}.`;
  }
  return `<section class="card recap tap" data-open-month="${esc(prev)}" aria-label="סיכום ${esc(monthName(prev))}">
    <h2>${icon('calendar')} החודש שהיה: ${esc(monthLabel(prev))} <button class="btn ghost small" data-act="recap-hide" data-m="${esc(prev)}" style="padding:0">הסתרה</button></h2>
    <div class="big ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? `נשארו ${abs$(net)}` : `יצאו ${abs$(net)} יותר ממה שנכנס`}</div>
    <div class="trio"><div><span>נכנסו</span><b>${abs$(m.inc)}</b></div><div><span>יצאו</span><b>${abs$(m.exp)}</b></div><div><span>נחסכו</span><b>${abs$(m.sav)}</b></div></div>
    ${cmp ? `<p class="small" style="margin:2px 0 6px">יצאו ${cmp}</p>` : ''}
    ${top.length ? `<p class="small" style="margin:8px 0 0;color:var(--ink)">על מה יצא הכי הרבה</p>${top.map(c => line(esc(c.c), money(c.t), '', '', '', catIcon(c.c, true))).join('')}` : ''}
    ${und && m.exp && und.t >= 0.2 * m.exp ? `<p class="small" style="margin:6px 0 0">${money(und.t)} יצאו בחיובי אשראי בלי פירוט. כדי לראות על מה, ייבאו את דף האשראי של ${esc(monthName(prev))}.</p>` : ''}
    ${gen && m.exp && gen.t >= 0.1 * m.exp ? `<p class="small" style="margin:6px 0 0">${money(gen.t)} עוד בלי קטגוריה (כללי). בלשונית תנועות אפשר לסווג בית עסק פעם אחת, והאפליקציה תזכור.</p>` : ''}
    <p class="small" style="margin:8px 0 0;color:var(--navy2)">הקישו לכל הפרטים של ${esc(monthName(prev))}</p></section>`;
}

function splitCard() {
  const sp = spenders();
  if (!sp.length) return '';
  const total = sp.reduce((a, o) => a + Math.max(0, o.profile.current || 0), 0) || 1;
  return `<section class="card tap" data-go="people"><h2>מי הוציא כמה החודש <small>לפי כרטיס</small></h2>
    <div class="split">${sp.map(o => `<i style="width:${Math.max(0, o.profile.current) / total * 100}%;background:${colorOf(o.name)}"></i>`).join('')}</div>
    ${sp.map(o => line(`${avatar(o.name)} <span style="vertical-align:middle">${esc(o.name)}</span>`, money(o.profile.current), '',
      o.profile.avg3 ? `בדרך כלל ${money(o.profile.avg3)}` : '')).join('')}</section>`;
}

function flowCard(d) {
  const fl = d.flow;
  if (!fl || !(fl.fixed || fl.variable)) return '';
  return `<section class="card"><h2>החודש במבט אחד</h2>
    ${fl.left_to_spend != null ? line('נשאר להוציא על הוצאות משתנות', `<span class="${fl.left_to_spend > 0 ? 'pos' : 'neg'}">${money(fl.left_to_spend)}</span>`,
      'לפי הממוצע של 3 החודשים האחרונים', fl.over >= 1 ? `חריגה של ${money(fl.over)} ${fl.left_to_spend >= 1 ? 'בקטגוריות אחרות' : 'מהממוצע'}` : '') : ''}
    ${line('הוצאות קבועות', money(fl.fixed), 'תשלומים, הוראות קבע ומנויים', fl.fixed_left ? `עוד צפוי ${money(fl.fixed_left)}` : '')}
    ${line('הוצאות משתנות', money(fl.variable), '', fl.variable_avg ? `בדרך כלל ${money(fl.variable_avg)}` : '')}
    ${fl.next_card ? line('חיוב האשראי הבא', money(fl.next_card.amount), `ב-${dm(fl.next_card.date)}`) : ''}</section>`;
}

function catsCard(d) {
  const cats = (d.month_cats && d.month_cats[d.month]) || [];
  if (!cats.length) return '';
  const top = cats.slice(0, 7), rest = cats.slice(7).reduce((a, c) => a + c.t, 0);
  const items = top.map(c => ({ label: c.c, ic: c.c, value: c.t, color: c.col, attrs: `data-cat="${esc(c.c)}" style="cursor:pointer"` }));
  if (rest > 0) items.push({ label: 'שאר הקטגוריות', ic: 'שאר הקטגוריות', value: rest, color: 'var(--ink3)' });
  return `<section class="card"><h2>לאן הלך הכסף <small>הקישו על קטגוריה לפירוט</small></h2>${barRows(items)}</section>`;
}

function tipPreview(d) {
  const tips = d.insights || [];
  if (!tips.length) return '';
  const t = tips[0];
  const more = tips.length > 2 ? `ועוד ${tips.length - 1} בלשונית חיסכון` : tips.length === 2 ? 'ועוד טיפ אחד בלשונית חיסכון' : 'פרטים בלשונית חיסכון';
  return `<section class="card tint-a tap" data-go-tab="save"><h2>${icon('bulb')} טיפ לחיסכון <small>${more}</small></h2>
    <p style="margin:0">${esc(t.title)}${t.text ? `. <span class="muted">${esc(t.text)}</span>` : ''}</p></section>`;
}

function alertsCard() {
  const alerts = [], seen = new Set();
  people().forEach(o => ((o.profile && o.profile.anomalies) || []).forEach(a => {
    const k = [a.description, a.date, a.amount, a.text].join('|');  // the two charges of a double charge are one alert
    if (seen.has(k)) return;
    seen.add(k);
    alerts.push(Object.assign({ who: o.name }, a));
  }));
  alerts.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!alerts.length) return '';
  return `<section class="card"><h2>כדאי לבדוק <small>${alerts.length}</small></h2>${alerts.slice(0, 4).map(a => `
    <div class="line"><span class="lbl"><span class="ellip">${esc(a.description)}</span><span class="sub">${esc(a.text)}. ${esc(a.who)}, ${dm(a.date)}</span></span>
    <span class="amt">${money(a.amount)}</span></div>`).join('')}</section>`;
}

export function viewHome() {
  if (!hasData()) return emptyHome();
  const d = S.data;
  return `${todayLine(d)}${heroCard(d)}${recapCard(d)}${budgetAlerts()}${expectedCard(d)}${tipPreview(d)}${splitCard()}${flowCard(d)}${catsCard(d)}${alertsCard()}`;
}

// ------------------------------------------------------------------ savings
// the engine's tip kinds: double_charge | subscription_up | category_up | dining | cut20
const TIP = {
  double_charge: { ic: 'alert', cls: 'warn', chip: a => `${money(Math.abs(a))} לבדוק` },
  subscription_up: { ic: 'repeat', cls: 'gold', chip: a => `${money(Math.abs(a))} בשנה` },
  category_up: { ic: 'trendUp', cls: '', chip: a => `${money(Math.abs(a))} מעל הרגיל` },
  dining: { ic: 'coffee', cls: '', chip: (a, t) => (/כמו בממוצע/.test(t.text || '') ? '' : a > 0 ? `${money(a)} מעל הממוצע` : `${money(-a)} פחות מהממוצע`) },
  cut20: { ic: 'seed', cls: '', chip: a => `${money(Math.abs(a))} בשנה` }
};

function goalCard(d) {
  const f = d.forecast || {}, fl = d.flow || {}, goal = S.goal || 0;
  const projected = (f.net_forecast || 0) + (f.saving_forecast || 0);
  const left = daysLeftInMonth();
  if (!goal) {
    return `<section class="card"><h2>${icon('seed')} יעד החיסכון של המשפחה</h2>
      <p class="small" style="margin:0">כמה תרצו לחסוך בכל חודש? עם יעד, האפליקציה תגיד לכם כמה עוד אפשר להוציא כל יום.</p>
      <div class="goal-row"><input id="goalInput" type="number" inputmode="numeric" min="0" step="100" placeholder="למשל 2000" aria-label="יעד חיסכון חודשי">
      <button class="btn primary small" data-act="goal">שמירה</button></div>
      ${projected ? `<p class="small" style="margin:10px 0 0">בקצב הנוכחי תחסכו החודש בערך ${abs$(Math.max(0, projected))}.</p>` : ''}</section>`;
  }
  const ratio = Math.max(0, Math.min(1, projected / goal));
  const C = 2 * Math.PI * 40;
  const avail = (f.income_forecast || 0) - (f.expense_actual || 0) - (fl.fixed_left || 0) - goal;
  const daily = avail > 0 ? avail / left : 0;
  const ok = projected >= goal;
  return `<section class="card"><h2>${icon('seed')} יעד החיסכון: ${abs$(goal)} בחודש <button class="btn ghost small" data-act="goal-edit" style="padding:0">שינוי</button></h2>
    <div class="ring"><svg viewBox="0 0 92 92" aria-hidden="true"><circle class="bg" cx="46" cy="46" r="40"/>
      <circle class="fg" cx="46" cy="46" r="40" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - ratio)).toFixed(1)}" style="stroke:${ok ? 'var(--green)' : 'var(--gold)'};--full:${C.toFixed(1)}"/></svg>
      <div class="txt"><b>${projected > 0 ? abs$(projected) : '₪0'}</b><span class="small">${ok ? 'בקצב הזה תעמדו ביעד, כל הכבוד!' : `בקצב הזה יחסרו ${abs$(goal - Math.max(0, projected))} ליעד`}</span></div></div>
    <div class="line" style="margin-top:8px"><span class="lbl">אפשר להוציא עוד החודש<span class="sub">ועדיין לעמוד ביעד, אחרי ההוצאות הקבועות שעוד יגיעו</span></span>
      <span class="amt ${avail > 0 ? 'pos' : 'neg'}">${money(Math.max(0, avail))}<span class="sub">${avail > 0 ? `כ-${money(daily)} ליום` : 'כדאי לעצור הוצאות לא הכרחיות'}</span></span></div></section>`;
}

/** months left to save for a goal by `by` (YYYY-MM), this month included; 0 when it has passed */
export function goalMonths(by, cur) {
  if (!by) return 0;
  const [y, m] = by.split('-').map(Number), [cy, cm] = cur.split('-').map(Number);
  return Math.max(0, (y * 12 + m) - (cy * 12 + cm) + 1);
}

/** the family's goals: what each is for, how much is put aside, how much a month gets there in time */
export function goalsCard(d, now = new Date()) {
  const goals = S.goals || [];
  const cur = localDate(now).slice(0, 7);
  if (!goals.length) {
    return `<section class="card"><h2>${icon('flag')} יעדים לחיסכון</h2>
      <p class="small" style="margin:0 0 10px">חופשה, רכב, קרן לימודים: לכל יעד שם, סכום ותאריך. האפליקציה תגיד כמה צריך לשים בצד בכל חודש כדי להגיע בזמן.</p>
      <button class="btn" data-act="goal-new">${icon('flag')} יעד חדש</button></section>`;
  }
  let need = 0;
  const rows = goals.map((g, k) => {
    const saved = g.saved || 0, left = Math.max(0, g.amount - saved), n = goalMonths(g.by, cur);
    const done = left <= 0, pc = Math.min(100, saved / g.amount * 100);
    let sub;
    if (done) sub = 'הגעתם ליעד. כל הכבוד!';
    else if (g.by && n > 0) { need += left / n; sub = `עד ${esc(monthLabel(g.by))} · כ-${money(Math.ceil(left / n))} בחודש`; }
    else if (g.by) sub = `התאריך (${esc(monthLabel(g.by))}) עבר. חסרים ${money(left)}`;
    else sub = `חסרים ${money(left)}`;
    return `<div class="goal tap${done ? ' done' : ''}" data-goal="${k}"><div class="line" style="padding:0"><span class="lbl"><b>${esc(g.name)}</b><span class="sub">${sub}</span></span>
      <span class="amt">${money(saved)} <span class="muted small">מתוך ${money(g.amount)}</span></span></div>
      <div class="meter"><span style="width:${pc}%"></span></div></div>`;
  }).join('');
  const f = d.forecast || {}, nf = f.net_forecast;
  const sumLine = need >= 1 ? `<p class="small" style="margin:8px 0 0">כדי להגיע לכל היעדים בזמן צריך לשים בצד כ-<b>${money(Math.ceil(need))}</b> בחודש.${nf == null ? ''
    : nf >= need ? ' בקצב של החודש הזה, זה אפשרי.' : nf >= 0 ? ` בקצב של החודש הזה צפויים להישאר ${money(nf)}.`
      : ` בקצב של החודש הזה צפוי לחסור ${money(-nf)} עוד לפני החיסכון.`}</p>` : '';
  return `<section class="card"><h2>${icon('flag')} יעדים לחיסכון <small>הקישו על יעד לעדכון</small></h2>${rows}${sumLine}
    ${goals.length < 12 ? `<button class="btn ghost small" data-act="goal-new" style="margin-top:8px;padding:6px 0">+ עוד יעד</button>` : ''}</section>`;
}

function tipsList(d) {
  const tips = d.insights || [];
  if (!tips.length) return `<section class="card"><h2>${icon('bulb')} טיפים לחיסכון</h2><p class="small" style="margin:0">כשיהיו נתונים של כמה חודשים, יופיעו כאן טיפים לפי ההוצאות שלכם.</p></section>`;
  return `<h2 class="title" style="font-size:18px;margin:18px 0 10px">איפה אפשר לחסוך</h2><div class="tips">${tips.map(t => {
    const k = TIP[t.kind] || { ic: 'bulb', cls: '', chip: () => '' };
    const chip = t.amount ? k.chip(t.amount, t) : '';
    const good = t.kind === 'dining' && t.amount < 0;
    return `<div class="tip ${k.cls}"><span class="ic">${icon(k.ic)}</span>
      <div><h3>${esc(t.title)}</h3>${t.text ? `<p>${esc(t.text)}</p>` : ''}${chip ? `<span class="gain${t.kind === 'double_charge' ? ' warn' : ''}${good ? ' good' : ''}">${chip}</span>` : ''}</div></div>`;
  }).join('')}</div>`;
}

function recurringCard(d) {
  const rc = d.recurring;
  if (!rc || !rc.count) return '';
  const flagged = (rc.items || []).filter(i => ['up', 'double', 'new'].includes(i.s)).length;
  return `<section class="card tap" data-go="recurring" style="margin-top:12px"><h2>${icon('repeat')} מנויים והוראות קבע <small>${flagged ? `${flagged} לבדיקה` : 'הכול תקין'}</small></h2>
    ${line(`${rc.count} חיובים קבועים`, money(rc.monthly), 'בחודש', `${money(rc.yearly)} בשנה`)}
    <p class="small" style="margin:6px 0 0">עברו על הרשימה פעם בחודש: מנוי שלא משתמשים בו הוא הכסף הכי קל לחסוך.</p></section>`;
}

function annualCard(d) {
  const pl = d.planner;
  if (!pl || !(pl.provision || (pl.next || []).length)) return '';
  return `<section class="card tap" data-go="planner"><h2>${icon('calendar')} הוצאות שנתיות</h2>
    ${pl.provision ? `<p style="margin:0 0 6px">כדי שהוצאות גדולות לא יפתיעו, כדאי להפריש ${abs$(pl.provision)} בכל חודש.</p>` : ''}
    ${(pl.next || []).slice(0, 3).map(i => line(`<span class="ellip">${esc(i.n)}</span>`, money(i.a), esc(i.l))).join('')}</section>`;
}

// ------------------------------------------------------------------ habits: where the money goes
const UND = 'כרטיס אשראי - ללא פירוט';
/** spending of a category in a month (as the months are counted: a card purchase in its billing month) */
function spentIn(cat, month) {
  return ((S.data && S.data.transactions) || []).filter(t => !t.x && t.c === cat && (t.src === 'max' ? t.cd || t.d : t.d).slice(0, 7) === month)
    .reduce((a, t) => a - t.a, 0);
}
const curMonth = () => localDate().slice(0, 7);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };

function installmentsCard(d) {
  const i = d.habits && d.habits.installments;
  if (!i) return '';
  const pts = i.timeline.slice(0, 5);
  const mx = Math.max(1, ...pts.map(p => p.total));
  // the first month the load falls by a fifth or more
  let drop = null;
  for (let k = 1; k < i.timeline.length && !drop; k++) if (i.timeline[k].total <= i.timeline[k - 1].total * 0.8) drop = [i.timeline[k - 1], i.timeline[k]];
  return `<section class="card tap" data-go="installments"><h2>${icon('card')} תשלומים פעילים <small>לפי דפי האשראי של ${esc(monthName(i.month))}</small></h2>
    ${line(i.count === 1 ? 'עסקה אחת בתשלומים' : `${fmt(i.count)} עסקאות בתשלומים`, money(i.monthly), 'כל חודש, מקניות קודמות', `נשאר לשלם ${money(i.remaining)}`)}
    <div class="minibars">${pts.map(p => `<div><i style="height:${Math.max(4, p.total / mx * 56)}px"></i><b>${fmt(p.total)}</b><span>${esc(shortMonth(p.m))}</span></div>`).join('')}</div>
    ${drop ? `<p class="small" style="margin:8px 0 0">ב${esc(monthName(drop[1].m))} ההחזר יורד ל-${money(drop[1].total)}, כלומר ${money(drop[0].total - drop[1].total)} פחות בחודש. התשלום האחרון: ${esc(monthLabel(i.last))}.</p>` : ''}
    <p class="small" style="margin:6px 0 0">לפני קנייה חדשה בתשלומים, כדאי לבדוק כמה כבר יוצא כל חודש על תשלומים קודמים. הקישו לרשימה המלאה.</p></section>`;
}

export function viewInstallments() {
  const i = S.data && S.data.habits && S.data.habits.installments;
  if (!i) return `${title('תשלומים פעילים', '', true)}<p class="empty">אין עסקאות בתשלומים בדפי האשראי שיובאו.</p>`;
  const rows = i.items.map(x => line(`<span class="ellip">${esc(x.name)}</span>`, money(x.pay),
    esc(`כרטיס ${x.card} · תשלום ${x.no} מתוך ${x.total}${x.left ? ` · נגמר ב${monthName(x.ends)} ${x.ends.slice(0, 4)}` : ' · האחרון'}`),
    x.left ? `נשאר ${money(x.remaining)}` : 'האחרון')).join('');
  return `${title('תשלומים פעילים', `${fmt(i.count)} עסקאות, ${fmt(i.monthly)} ₪ בחודש`, true)}
    <section class="card"><h2>כמה ייצא על תשלומים בחודשים הקרובים</h2>${barRows(i.timeline.slice(0, 9).map(p => ({ label: monthLabel(p.m), value: p.total, color: 'var(--navy2)' })))}</section>
    <section class="card"><h2>כל העסקאות <small>הגדולות למעלה</small></h2><div class="tx" style="border:0;padding:0">${rows}</div></section>`;
}

function smallCard(d) {
  const s = d.habits && d.habits.small;
  if (!s) return '';
  return `<section class="card"><h2>${icon('coffee')} קניות קטנות שמצטברות <small>${esc(monthName(s.month))}</small></h2>
    <p style="margin:0 0 6px">${fmt(s.count)} קניות של פחות מ-50 ₪, ביחד ${money(s.total)}. בשנה זה בערך <b>${money(s.yearly)}</b>.</p>
    ${s.top.map(g => line(`<span class="ellip">${esc(g.name)}</span>`, money(g.total), `${fmt(g.count)} פעמים`)).join('')}
    <p class="small" style="margin:6px 0 0">קפה, חטיף ומאפה כמעט כל יום הם החיסכון הכי קל: חצי מזה הוא ${money(s.yearly / 2)} בשנה.</p></section>`;
}

function transfersCard(d) {
  const t = d.habits && d.habits.transfers;
  if (!t || !t.months.some(m => m.total)) return '';
  const notes = S.notes || {};
  const shown = t.months.filter(m => m.total || m.m === curMonth());
  const items = t.items.slice(0, 8);
  return `<section class="card"><h2>${icon('share')} כסף שעבר לאנשים <small>BIT, Paybox והעברות</small></h2>
    ${barRows(shown.map(m => ({ label: monthName(m.m), value: m.total, color: 'var(--gold)', text: `${money(m.total)} <span class="muted small">(${fmt(m.count)})</span>` })))}
    ${items.length ? `<p class="small" style="margin:10px 0 2px;color:var(--ink)">על מה? <span class="muted">הקישו על העברה כדי לכתוב למי ועל מה</span></p>
    <div class="tx" style="border:0;padding:0">${items.map(x => line(`<span class="ellip">${esc(notes[x.u] || x.s)}</span>`, money(x.a, true),
      esc([dm(x.d), notes[x.u] ? x.s : '', x.card ? `כרטיס ${x.card}` : 'מהבנק'].filter(Boolean).join(' · ')), '', x.u ? `data-tx="${esc(x.u)}"` : '')).join('')}</div>` : ''}</section>`;
}

function debtCard(d) {
  const b = d.habits && d.habits.debt;
  if (!b) return '';
  return `<section class="card tap" data-go="loans"><h2>${icon('bank')} הלוואות, משכנתא ופריסות <small>${esc(monthName(b.month))}</small></h2>
    ${line('החזר חודשי', money(b.total), 'משכנתא, הלוואות ופריסת חיובים')}
    ${b.mortgage ? line('<span class="muted">משכנתא</span>', money(b.mortgage)) : ''}${b.loan ? line('<span class="muted">הלוואות</span>', money(b.loan)) : ''}
    ${b.spread ? line('<span class="muted">פריסת חיוב אשראי</span>', money(b.spread)) : ''}
    ${b.spread ? notice('חיוב אשראי שנפרס לתשלומים עולה ריבית. אם אפשר, כדאי לסגור את הפריסה ולא לפרוס שוב.') : ''}
    ${b.taken.length ? line('הלוואות שנלקחו בשנה האחרונה', money(b.taken_total), `${fmt(b.taken.length)} פעמים · הקישו לפרטים`) : ''}
    ${b.interest3 > 0.5 ? line('ריבית שמופיעה בדפים', money(b.interest3), '3 החודשים האחרונים') : ''}</section>`;
}

export function viewLoans() {
  const b = S.data && S.data.habits && S.data.habits.debt;
  if (!b) return `${title('הלוואות ומשכנתא', '', true)}<p class="empty">לא נמצאו הלוואות או משכנתא בדף הבנק.</p>`;
  const part = (r, m) => `<section class="card"><h2>${esc(monthLabel(m))}</h2>
    ${line('משכנתא', money(r.mortgage))}${line('הלוואות', money(r.loan))}${line('פריסת חיוב אשראי', money(r.spread))}
    ${line('<b>סה״כ</b>', `<b>${money(r.total)}</b>`)}
    ${r.big.length ? `<p class="small" style="margin:6px 0 0">פרעונות גדולים (כנראה סגירה מוקדמת של הלוואה): ${r.big.map(x => `${money(x.a)} ב-${dm(x.d)}`).join(', ')}</p>` : ''}</section>`;
  return `${title('הלוואות ומשכנתא', 'לפי דף הבנק', true)}
    ${part(b, b.month)}${b.now && b.now.total ? part(b.now, curMonth()) : ''}
    <section class="card"><h2>הלוואות שנלקחו בשנה האחרונה <small>${money(b.taken_total)}</small></h2>
      ${b.taken.length ? b.taken.map(t => line(esc(t.s.replace(/[-\s]י$/, '')), money(t.a), esc(dmy(t.d)))).join('') : '<p class="small" style="margin:0">לא נלקחו הלוואות בשנה האחרונה.</p>'}
      <p class="small" style="margin:8px 0 0">הלוואה חדשה שסוגרת הלוואה קודמת עלולה לעלות יותר ריבית לאורך זמן. לפני שלוקחים, כדאי להשוות את הריבית ואת סך ההחזר.</p></section>`;
}

function budgetsCard() {
  const b = S.budgets || {};
  const cats = Object.keys(b);
  const m = curMonth();
  if (!cats.length) {
    return `<section class="card"><h2>${icon('target')} תקציב לחודש</h2>
      <p class="small" style="margin:0 0 10px">קבעו כמה מותר להוציא בחודש על סופר, מסעדות או קניות. האפליקציה תראה כמה כבר יצא, ותזהיר כשמגיעים ל-80%.</p>
      <button class="btn primary" data-act="budget-new">${icon('target')} קביעת תקציב</button></section>`;
  }
  const rows = cats.map(c => {
    const spent = Math.max(0, spentIn(c, m)), cap = b[c], pc = cap ? spent / cap * 100 : 0;
    const col = pc >= 100 ? 'var(--rose)' : pc >= 80 ? 'var(--gold)' : 'var(--green-light)';
    return `<div class="budget tap" data-budget="${esc(c)}"><div class="line withic" style="padding:6px 0 4px">${catIcon(c)}<span class="lbl">${esc(c)}<span class="sub">${pc >= 100 ? `חריגה של ${money(spent - cap)}` : `נשארו ${money(cap - spent)}`}</span></span>
      <span class="amt">${money(spent)} <span class="muted small">מתוך ${money(cap)}</span></span></div>
      <div class="meter"><span style="width:${Math.min(100, pc)}%;background:${col}"></span></div></div>`;
  }).join('');
  return `<section class="card"><h2>${icon('target')} תקציב לחודש <small>${esc(monthName(m))}, לפי מה שיובא</small></h2>${rows}
    <button class="btn ghost small" data-act="budget-new" style="margin-top:8px;padding:6px 0">+ עוד תקציב</button></section>`;
}

export function viewSave() {
  if (!hasData()) return `${title('חיסכון')}${emptyHome()}`;
  const d = S.data;
  return `${title('איך לחסוך', 'מבוסס על ההוצאות של המשפחה')}${goalCard(d)}${goalsCard(d)}${budgetsCard()}${installmentsCard(d)}${smallCard(d)}${transfersCard(d)}${debtCard(d)}${tipsList(d)}${recurringCard(d)}${annualCard(d)}`;
}

// ------------------------------------------------------------------ transactions
export function viewTx() {
  if (!hasData()) return `${title('תנועות')}${emptyHome()}`;
  const all = S.data.transactions || [];
  const q = S.txQuery.trim().toLowerCase();
  const list = all.filter(t => (!q || (t.s || '').toLowerCase().includes(q) || (t.c || '').includes(q))
    && (!S.txOwner || t.o === S.txOwner) && (!S.txCat || t.c === S.txCat));
  const owners = [...new Set(all.map(t => t.o).filter(Boolean))];
  const cats = [...new Set(all.map(t => t.c).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  let html = `<input class="search" id="txSearch" type="search" placeholder="חיפוש לפי בית עסק או קטגוריה" value="${esc(S.txQuery)}" aria-label="חיפוש">
    <div class="filters"><select id="txOwner" aria-label="של מי"><option value="">כולם</option>${owners.map(o => `<option ${o === S.txOwner ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
    <select id="txCat" aria-label="קטגוריה"><option value="">כל הקטגוריות</option>${cats.map(c => `<option ${c === S.txCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;
  const sum = list.reduce((a, t) => a + (t.x ? 0 : t.a), 0);
  html += `<p class="small" style="margin:6px 2px 0">${fmt(list.length)} תנועות, סה״כ ${money(sum, true)}. הקישו על תנועה כדי לשנות קטגוריה. תנועות באפור לא נספרות.</p>`;
  const byDay = new Map();
  list.slice(0, S.txLimit).forEach((t, i) => { if (!byDay.has(t.d)) byDay.set(t.d, []); byDay.get(t.d).push(t); });
  const totals = new Map();
  list.forEach(t => totals.set(t.d, (totals.get(t.d) || 0) + (t.x ? 0 : t.a)));
  byDay.forEach((rows, d) => {
    html += `<div class="day"><span>${dayLabel(d)}</span>${money(totals.get(d), true)}</div><div class="tx">${rows.map(t => {
      const sub = [t.x ? 'לא נספר' : '', t.p ? 'בקליטה' : '', (S.notes || {})[t.u] ? `"${(S.notes || {})[t.u]}"` : '', t.c, t.o, t.card ? `כרטיס ${t.card}` : '', t.i ? `תשלום ${String(t.i).replace('/', ' מתוך ')}` : '',
        t.src === 'max' && t.cd && t.cd !== t.d ? `חיוב ב-${dm(t.cd)}` : ''].filter(Boolean).join(', ');
      return line(`<span class="ellip${t.p ? ' pend' : ''}">${esc(t.s)}</span>`,
        `<span class="${t.a > 0 && !t.x ? 'pos' : ''}${t.p ? ' pend' : ''}">${money(t.a, true)}</span>`, esc(sub), '', `${t.u ? `data-tx="${esc(t.u)}"` : ''}${t.x ? ' data-off="1"' : ''}`,
        catIcon(t.c, false, colorOf(t.o)));
    }).join('')}</div>`;
  });
  if (list.length > S.txLimit) html += `<button class="btn" id="txMore" style="margin-top:12px">עוד תנועות</button>`;
  if (!list.length) html += '<p class="empty">אין תנועות שמתאימות לחיפוש.</p>';
  return html;
}

// ------------------------------------------------------------------ months
export function viewMonths() {
  if (!hasData()) return `${title('חודשים')}${emptyHome()}`;
  const months = (S.data.months || []).slice().reverse();
  const six = months.slice(0, 6).reverse();
  const mx = Math.max(1, ...six.map(m => Math.max(m.inc, m.exp)));
  let html = `${title('חודשים', 'הכנסות מול הוצאות')}<section class="card"><div class="cols">${six.map(m => `<div class="col"><div class="duo">
      <i style="height:${m.inc / mx * 100}%;background:var(--green)"></i><i style="height:${m.exp / mx * 100}%;background:var(--gold)"></i></div><span>${shortMonth(m.m)}</span></div>`).join('')}</div>
    <div class="legend"><span><span class="dot" style="background:var(--green)"></span>נכנסו</span><span><span class="dot" style="background:var(--gold)"></span>יצאו</span></div></section>`;
  const mx2 = Math.max(1, ...months.map(m => Math.max(m.inc, m.exp)));
  html += months.map(m => {
    const open = S.openMonth === m.m;
    const cats = (S.data.month_cats && S.data.month_cats[m.m]) || [];
    return `<section class="card tap" data-month="${esc(m.m)}" aria-expanded="${open}">
      <div class="line" style="padding:0"><span class="lbl" style="font-weight:600;font-size:17px">${monthLabel(m.m)}</span><span class="amt ${m.net >= 0 ? 'pos' : 'neg'}">${money(m.net, true)}</span></div>
      <div style="margin-top:8px">${barRows([{ label: 'נכנסו', value: m.inc, color: 'var(--green)' }, { label: 'יצאו', value: m.exp, color: 'var(--gold)' }]
        .concat(m.sav ? [{ label: 'נחסך', value: m.sav, color: 'var(--navy2)' }] : []), mx2)}</div>
      ${open ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--hair)">${cats.length ? barRows(cats.map(c => ({ label: c.c, ic: c.c, value: c.t, color: c.col })))
        : '<p class="small" style="margin:0">פירוט לפי קטגוריה נשמר לחצי השנה האחרונה.</p>'}${monthDetails(m.m)}</div>` : ''}
    </section>`;
  }).join('');
  return html;
}

/** a month beside the month before and the same month a year before: the whole, and the categories that moved
    most (only when both months have their card statements: else the categories cannot be compared) */
function compareMonth(month) {
  const c = S.data && S.data.month_cmp && S.data.month_cmp[month];
  const now = (S.data.month_cats && S.data.month_cats[month]) || [];
  if (!c || !now.length) return '';
  const cur = Object.fromEntries(now.map(x => [x.c, x.t]));
  const sum = o => Object.values(o || {}).reduce((a, v) => a + Math.max(0, v), 0);
  const detailed = o => o && (o[UND] || 0) < 0.2 * sum(o);
  const pctTxt = (a, b) => (b ? `${a >= b ? '+' : '−'}${fmt(Math.abs(a - b) / b * 100)}%` : '');
  const part = (o, label) => {
    if (!o) return '';
    const a = sum(cur), b = sum(o);
    let h = `<p class="small" style="margin:10px 0 2px;color:var(--ink)">לעומת ${label}: יצאו ${money(a)} מול ${money(b)} <span class="${a > b ? 'neg' : 'pos'}">${pctTxt(a, b)}</span></p>`;
    if (detailed(cur) && detailed(o)) {
      const moves = [...new Set([...Object.keys(cur), ...Object.keys(o)])].filter(k => k !== UND)
        .map(k => [k, (cur[k] || 0) - (o[k] || 0)]).filter(([, dlt]) => Math.abs(dlt) >= 200).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 4);
      if (moves.length) h += `<p class="small" style="margin:0">${moves.map(([k, dlt]) => `${esc(k)} <span class="${dlt > 0 ? 'neg' : 'pos'}">${dlt > 0 ? '+' : '−'}${fmt(Math.abs(dlt))} ₪</span>`).join(' · ')}</p>`;
    }
    return h;
  };
  return part(c.prev, monthName(addMonths(month, -1))) + part(c.ly, `${monthName(month)} ${Number(month.slice(0, 4)) - 1}`);
}

/** an open month: card charges with no details, and the biggest lines (tap one to change its category) */
function monthDetails(month) {
  const all = (S.data && S.data.transactions) || [];
  const inMonth = all.filter(t => (t.src === 'max' ? t.cd || t.d : t.d).slice(0, 7) === month);
  if (!inMonth.length) return '';
  let html = '';
  const undetailed = inMonth.filter(t => t.w === 'undetailed');
  if (undetailed.length) {
    const sum = undetailed.reduce((a, t) => a + t.a, 0);
    html += notice(`${money(Math.abs(sum))} יצאו בחיובי אשראי בלי פירוט (${undetailed.map(t => dm(t.d)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}). כדי לראות על מה, ייבאו את דף האשראי של החודש.`);
  }
  const big = inMonth.filter(t => !t.x && t.w !== 'undetailed').sort((a, b) => Math.abs(b.a) - Math.abs(a.a)).slice(0, 6);
  if (big.length) {
    html += `<p class="small" style="margin:12px 0 2px;color:var(--ink)">התנועות הגדולות <span class="muted">· הקישו כדי לשנות קטגוריה</span></p><div class="tx">${big.map(t =>
      line(`<span class="ellip">${esc(t.s)}</span>`, `<span class="${t.a > 0 ? 'pos' : ''}">${money(t.a, true)}</span>`,
        esc([dm(t.d), t.c, t.card ? `כרטיס ${t.card}` : ''].filter(Boolean).join(', ')), '', t.u ? `data-tx="${esc(t.u)}"` : '', catIcon(t.c, false, colorOf(t.o)))).join('')}</div>`;
  }
  html += compareMonth(month);
  const off = inMonth.filter(t => t.x);
  if (off.length) {
    const sum = off.reduce((a, t) => a + Math.abs(t.a), 0);
    html += `<p class="small" style="margin:10px 0 0">${fmt(off.length)} תנועות בסך ${money(sum)} לא נספרו: חיובי אשראי שהקניות שלהם מפורטות בנפרד, הלוואות והעברות בין החשבונות שלכם. הן מופיעות באפור בלשונית תנועות.</p>`;
  }
  return html;
}

// ------------------------------------------------------------------ people
export function viewPeople() {
  const owners = people().filter(o => o.profile && o.profile.data_points);
  if (!owners.length) return `${title('מי הוציא מה', '', true)}<p class="empty">כשכל כרטיס אשראי ישויך לבעליו, יופיע כאן פרופיל לכל אחד. משייכים כרטיסים בלשונית "עוד".</p>`;
  if (!S.person || !owners.find(o => o.name === S.person)) S.person = (owners.find(o => o.name === meName()) || owners[0]).name;
  const o = owners.find(x => x.name === S.person), p = o.profile, col = colorOf(o.name);
  let html = `${title('מי הוציא מה', '', true)}<div class="chips" role="group">${owners.map(x => `<button class="chip" data-person="${esc(x.name)}" aria-pressed="${x.name === S.person}">
    <span class="dot" style="background:${colorOf(x.name)}"></span>${esc(x.name)}</button>`).join('')}</div>`;
  html += `<p class="lead">החודש עד כה ${abs$(p.current)}.${p.avg3 ? ` בממוצע ${abs$(p.avg3)} בחודש.` : ''}</p>`;
  html += `<section class="card">${line('צפי לסוף החודש', money(p.projected))}${line('עסקה ממוצעת', money(p.avg_ticket), `כ-${Math.round(p.tx_per_month || 0)} עסקאות בחודש`)}
    ${p.household_share != null ? line('חלק מהוצאות הבית', pct(p.household_share), '90 הימים האחרונים') : ''}
    ${o.cards && o.cards.length ? line('כרטיסים', `<span class="num">${o.cards.map(esc).join(', ')}</span>`) : ''}</section>`;
  const mx = Math.max(1, ...(p.monthly || []).map(m => m.spend));
  html += `<section class="card"><h2>שישה חודשים</h2><div class="cols">${(p.monthly || []).map(m => `<div class="col"><i class="single" style="height:${m.spend / mx * 100}%;background:${col}"></i><span>${shortMonth(m.month)}</span></div>`).join('')}</div></section>`;
  if ((p.insights || []).length) html += `<section class="card tint-a"><h2>מה למדנו</h2>${p.insights.map(t => `<p style="margin:6px 0">${esc(t)}</p>`).join('')}</section>`;
  if ((p.categories || []).length) html += `<section class="card"><h2>קטגוריות החודש <small>הקו השחור: הממוצע</small></h2>${barRows(p.categories.slice(0, 8).map(c => ({ label: c.category, ic: c.category, value: c.current, ref: c.avg, color: col })))}</section>`;
  if ((p.top_merchants || []).length) html += `<section class="card"><h2>בתי עסק קבועים <small>90 יום</small></h2>${p.top_merchants.slice(0, 6).map(m => line(`<span class="ellip">${esc(m.name)}</span>`, money(m.total), `${m.count} פעמים, בממוצע ${money(m.avg)}`)).join('')}</section>`;
  if ((p.anomalies || []).length) html += `<section class="card"><h2>כדאי לבדוק <small>${p.anomalies.length}</small></h2>${p.anomalies.map(a => line(`<span class="ellip">${esc(a.description)}</span>`, money(a.amount), `${esc(a.text)}. ${dm(a.date)}`)).join('')}</section>`;
  return html;
}

// ------------------------------------------------------------------ standing orders and subscriptions
const REC_STATUS = { up: ['התייקר', 'neg'], double: ['חיוב כפול', 'neg'], new: ['חדש', ''], stopped: ['לא חויב בזמן', 'muted'], active: ['', ''] };
export function viewRecurring() {
  const rc = S.data && S.data.recurring;
  if (!rc || !rc.count) return `${title('מנויים והוראות קבע', '', true)}<p class="empty">חיובים שחוזרים כל חודש יזוהו כאן אחרי שלושה חודשים של נתונים.</p>`;
  const soon = pe => pe && (new Date(pe + 'T12:00:00') - Date.now()) / 864e5 <= 30;
  return `${title('מנויים והוראות קבע', `${money(rc.monthly)} בחודש, ${money(rc.yearly)} בשנה`, true)}
    <p class="small" style="margin:-4px 0 10px">הקישו על חיוב כדי לרשום מתי נגמר מבצע. נזכיר לכם חודש לפני.</p>
    <section class="card">${(rc.items || []).map(i => {
      const [st, cls] = REC_STATUS[i.s] || ['', ''];
      const why = i.s === 'up' ? `התייקר ב-${money(i.d)}` : st || (soon(i.pe) ? `מבצע עד ${dm(i.pe)}` : i.pe ? `מבצע עד ${dmy(i.pe)}` : esc(i.c || ''));
      return line(`<span class="ellip">${esc(i.n)}</span>`, `<span class="${cls}">${money(i.p)}</span>`, why, `${money(i.y)} בשנה${i.k === 2 ? ', כל חודשיים' : ''}`, `data-rec="${esc(i.id)}"`);
    }).join('')}</section>`;
}

export function viewPlanner() {
  const pl = S.data && S.data.planner;
  if (!pl) return `${title('הוצאות שנתיות', '', true)}<p class="empty">אין עדיין נתונים.</p>`;
  let html = `${title('הוצאות שנתיות', 'הוצאות גדולות שלא חוזרות כל חודש', true)}`;
  if (!pl.enough) html += `<section class="card"><p class="small" style="margin:0">כדי לזהות הוצאות שנתיות (טסט, חגים, קייטנות, חופשות) צריך נתונים של חצי שנה לפחות. כדאי לייבא קבצים של כמה חודשים אחורה.</p></section>`;
  if (pl.provision) html += `<section class="card tint-gold"><h2>הפרשה חודשית מומלצת</h2><p style="margin:0">להפריש ${abs$(pl.provision)} בכל חודש, ויהיה כסף לכל הוצאה כשהיא מגיעה. סה״כ ${abs$(pl.year_total)} בשנה הקרובה.</p></section>`;
  if ((pl.next || []).length) html += `<section class="card"><h2>בקרוב</h2>${pl.next.map(i => line(`<span class="ellip">${esc(i.n)}</span>`, money(i.a), esc(i.l))).join('')}</section>`;
  const months = (pl.months || []).filter(m => m.t);
  if (months.length) html += `<section class="card"><h2>לפי חודש</h2>${barRows(months.map(m => ({ label: m.l, value: m.t, color: 'var(--gold)' })))}</section>`;
  return html;
}

// ------------------------------------------------------------------ imported files
const KIND = { leumi: 'לאומי', max: 'MAX' };
export function viewImports() {
  const list = (S.imports || []).slice().reverse();
  if (!list.length) return `${title('קבצים שיובאו', '', true)}<p class="empty">עוד לא יובאו קבצים.</p>`;
  return `${title('קבצים שיובאו', `${list.filter(i => i.status !== 'removed').length} קבצים`, true)}<section class="card">${list.map(i => {
    const by = S.names[i.by] || '';
    const st = i.status === 'removed' ? 'הוסר' : i.status === 'duplicate' ? 'כבר היה' : `${i.added || 0} תנועות חדשות`;
    return line(`<span class="ellip">${esc(i.name)}</span>`, i.status === 'removed' ? '<span class="muted">הוסר</span>'
      : `<button class="btn ghost small" data-del-import="${esc(i.sha)}" style="padding:2px 4px" aria-label="הסרת הקובץ">${icon('trash')}</button>`,
      `${esc(KIND[i.kind] || '')}${by ? `, מהטלפון של ${esc(by)}` : ''}, ${ago(i.ts)}`, st);
  }).join('')}</section><p class="small">הסרת קובץ מוחקת את התנועות שהגיעו ממנו, בשני הטלפונים.</p>`;
}

// ------------------------------------------------------------------ more
export function viewMore() {
  const f = S.fam, cfg = f.cfg, names = S.names, partner = partnerName();
  const signed = !!A.signedIn();
  const cards = (S.cards || []).filter(c => c.source === 'max' || c.kind === 'card' || c.card);
  let html = `${title('עוד')}`;
  // the family
  html += `<section class="card"><h2>${icon('heart')} המשפחה</h2>
    ${line(`${avatar(names.A, 'a')} <span style="vertical-align:middle">${esc(names.A)}</span>`, f.role === 'A' ? '<span class="tag a">הטלפון הזה</span>' : '')}
    ${line(`${avatar(names.B || '?', names.B ? 'b' : 'ghost')} <span style="vertical-align:middle">${esc(names.B || 'בן/בת הזוג')}</span>`, f.role === 'B' ? '<span class="tag b">הטלפון הזה</span>'
      : (cfg.partnerFileId ? '<span class="tag">חיבור פעיל</span>' : '<span class="tag">עוד אין חיבור</span>'))}
    ${f.role === 'A' ? (cfg.partnerFileId
      ? `<button class="btn" data-act="invite" style="margin-top:8px">${icon('share')} קישור הזמנה חדש (לטלפון חדש)</button>`
      : `<button class="btn primary" data-act="invite" style="margin-top:8px">${icon('share')} הזמנת ${esc(partner || 'בן/בת הזוג')} לאפליקציה</button>`) : ''}
    ${cfg.myFileId && cfg.shared && (f.role === 'B' ? !cfg.partnerKnowsMine : cfg.needsRelink) ? `<button class="btn gold" data-act="connect" style="margin-top:8px">${icon('link')} שליחת קישור חיבור ל${esc(partner)}</button>
      <p class="small" style="margin:6px 0 0">${f.role === 'A' ? 'הקובץ שלך בדרייב נוצר מחדש. ' : ''}פעם אחת, כדי שהקבצים שמיובאים כאן יופיעו גם בטלפון של ${esc(partner)}.</p>` : ''}
</section>`;
  // cards and their owners
  if (cards.length) {
    html += `<section class="card"><h2>${icon('card')} כרטיסי אשראי <small>של מי כל כרטיס</small></h2>${cards.map(c => line(`כרטיס <span class="num">${esc(c.card)}</span>`,
      `<span class="tag ${who(c.owner)}">${esc(c.owner || 'לא שויך')}</span>`, `${fmt(c.count || 0)} תנועות`, '', `data-card="${esc(c.card)}"`)).join('')}</section>`;
  }
  // pages
  html += `<section class="card">
    ${line(`${icon('users', 'inl')} מי הוציא מה`, icon('chev'), '', '', 'data-go="people"')}
    ${line(`${icon('repeat', 'inl')} מנויים והוראות קבע`, icon('chev'), '', '', 'data-go="recurring"')}
    ${line(`${icon('calendar', 'inl')} הוצאות שנתיות`, icon('chev'), '', '', 'data-go="planner"')}
    ${line(`${icon('card', 'inl')} תשלומים פעילים`, icon('chev'), '', '', 'data-go="installments"')}
    ${line(`${icon('bank', 'inl')} הלוואות ומשכנתא`, icon('chev'), '', '', 'data-go="loans"')}
    ${line(`${icon('download', 'inl')} קבצים שיובאו`, icon('chev'), '', '', 'data-go="imports"')}</section>`;
  // Drive
  const drv = cfg.myFileId ? (f.mine.dirty ? 'יש שינויים שעוד לא נשמרו' : `נשמר ${ago(f.mine.pushedAt)}`) : 'עוד לא נשמר בדרייב';
  html += `<section class="card"><h2>${icon('cloud')} Google Drive</h2>
    ${line('הקובץ שלך בדרייב', esc(drv), cfg.email ? esc(cfg.email) : '')}
    ${cfg.partnerFileId ? line(`הנתונים של ${esc(partner)}`, esc(f.theirs.pulledAt ? ago(f.theirs.pulledAt) : 'עוד לא נקראו'), 'מתעדכנים בכל פתיחה') : ''}
    <button class="btn" data-act="sync" style="margin-top:8px">${icon('cloud')} ${signed ? 'סנכרון עכשיו' : 'התחברות לגוגל ושמירה'}</button>
    ${f.role === 'A' ? '<button class="btn ghost" data-act="google-setup">פרטי החיבור לגוגל</button>' : ''}</section>`;
  // security
  // the lock code is a choice: off unless this phone's owner turns it on
  html += A.hasPin() ? `<section class="card"><h2>${icon('shield')} אבטחה</h2>
    ${line('קוד נעילה', '<span class="tag a">פעיל</span>', 'נדרש בכל פתיחה של האפליקציה')}
    ${line('נעילה אוטומטית', `<select id="lockMin" aria-label="נעילה אוטומטית" style="width:auto;padding:6px 10px">${[1, 3, 10, 30].map(m => `<option value="${m}" ${(cfg.lockMin || 3) === m ? 'selected' : ''}>אחרי ${m} דק׳</option>`).join('')}</select>`, 'כשהאפליקציה ברקע')}
    <button class="btn" data-act="pin-change">${icon('lock')} שינוי קוד הנעילה</button>
    <button class="btn" data-act="pin-off">כיבוי קוד הנעילה</button>
    <button class="btn" data-act="recovery">${icon('key')} קוד השחזור של המשפחה</button>
    <button class="btn ghost" data-act="lock-now">נעילה עכשיו</button></section>`
    : `<section class="card"><h2>${icon('shield')} אבטחה</h2>
    ${line('קוד נעילה', '<span class="tag">כבוי</span>', 'אפשר לבקש קוד בכל פתיחה של האפליקציה')}
    <button class="btn" data-act="pin-on">${icon('lock')} הפעלת קוד נעילה</button>
    <button class="btn" data-act="recovery">${icon('key')} קוד השחזור של המשפחה</button></section>`;
  // the look: light, dark or as the phone is set
  const tp = themePref();
  html += `<section class="card"><h2>${icon('sun')} מראה</h2>
    <div class="seg" role="group" aria-label="מראה">${[['auto', 'לפי הטלפון', 'phone'], ['light', 'בהיר', 'sun'], ['dark', 'כהה', 'moon']]
      .map(([k, l, ic]) => `<button data-theme-pick="${k}" aria-pressed="${tp === k}">${icon(ic)}${l}</button>`).join('')}</div></section>`;
  // app
  html += `<section class="card"><h2>${icon('phone')} האפליקציה</h2>
    ${A.inApp() ? '' : `<a class="btn primary" href="FinPal.apk" download="FinPal.apk">${icon('download')} הורדת האפליקציה לאנדרואיד</a>`}
    <button class="btn" data-act="howto">איך מורידים קבצים מהבנק ומהאשראי</button>
    <a class="btn" href="guide.html" target="_blank" rel="noopener">מדריך ההקמה ותקלות נפוצות</a>
    <button class="btn" data-act="privacy">איפה הנתונים שלנו נשמרים</button>
    <button class="btn ghost danger" data-act="wipe">מחיקת הנתונים מהטלפון הזה</button>
    <p class="small" style="margin:10px 0 0;text-align:center">FinPal משפחה ${esc(A.version())}</p></section>`;
  return html;
}

// ------------------------------------------------------------------ render & bind
const VIEWS = { home: viewHome, save: viewSave, tx: viewTx, months: viewMonths, more: viewMore,
  people: viewPeople, recurring: viewRecurring, planner: viewPlanner, imports: viewImports, installments: viewInstallments, loans: viewLoans };
const PARENT = { people: 'more', recurring: 'save', planner: 'save', imports: 'more', installments: 'save', loans: 'save' };

let shown = { tab: null, data: null };
export function render() {
  const fn = VIEWS[S.tab] || viewHome;
  const v = $('#view');
  v.innerHTML = fn();
  // the cards come in and the bars grow when a screen opens or its numbers change, not on every tap
  if (shown.tab !== S.tab || shown.data !== S.data) {
    shown = { tab: S.tab, data: S.data };
    v.classList.remove('anim');
    void v.offsetWidth;
    v.classList.add('anim');
    clearTimeout(render.t);
    render.t = setTimeout(() => v.classList.remove('anim'), 1400);
    countUp(v);
  }
  if (S.scrollMonth && S.tab === 'months') {
    S.scrollMonth = false;
    const el = $(`#view [data-month="${S.openMonth}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  }
  const tab = PARENT[S.tab] || S.tab;
  $$('#tabbar button').forEach(b => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  bind();
}

export function go(tab) {
  S.prevTab = PARENT[tab] ? (S.tab in PARENT ? S.prevTab : S.tab) : null;
  S.tab = tab;
  window.scrollTo(0, 0);
  render();
}

function bind() {
  const v = $('#view');
  $$('[data-back]', v).forEach(el => el.onclick = () => go(S.prevTab || PARENT[S.tab] || 'home'));
  $$('[data-go]', v).forEach(el => el.onclick = () => go(el.dataset.go));
  $$('[data-go-tab]', v).forEach(el => el.onclick = () => go(el.dataset.goTab));
  $$('[data-month]', v).forEach(el => el.onclick = () => { S.openMonth = S.openMonth === el.dataset.month ? null : el.dataset.month; render(); });
  $$('[data-person]', v).forEach(el => el.onclick = () => { S.person = el.dataset.person; render(); });
  $$('[data-cat]', v).forEach(el => el.onclick = () => { S.txCat = el.dataset.cat; S.txQuery = ''; S.txOwner = ''; go('tx'); });
  $$('[data-tx]', v).forEach(el => el.onclick = () => A.openTx(el.dataset.tx));
  $$('[data-rec]', v).forEach(el => el.onclick = () => A.openRecurring(el.dataset.rec));
  $$('[data-card]', v).forEach(el => el.onclick = () => A.pickOwner([el.dataset.card]));
  $$('[data-budget]', v).forEach(el => el.onclick = () => A.act('budget-edit', el));
  $$('[data-open-month]', v).forEach(el => el.onclick = e => { e.stopPropagation(); S.openMonth = el.dataset.openMonth; S.scrollMonth = true; go('months'); });
  $$('[data-del-import]', v).forEach(el => el.onclick = e => { e.stopPropagation(); A.removeImport(el.dataset.delImport); });
  $$('[data-goal]', v).forEach(el => el.onclick = () => A.act('goal-open', el));
  $$('[data-theme-pick]', v).forEach(el => el.onclick = () => A.setTheme(el.dataset.themePick));
  $$('[data-act]', v).forEach(el => el.onclick = e => { e.stopPropagation(); A.act(el.dataset.act, el); });
  const s = $('#txSearch');
  if (s) {
    s.oninput = () => { S.txQuery = s.value; S.txLimit = 150; const pos = s.selectionStart; render(); const n = $('#txSearch'); n.focus(); n.setSelectionRange(pos, pos); };
    $('#txOwner').onchange = e => { S.txOwner = e.target.value; render(); };
    $('#txCat').onchange = e => { S.txCat = e.target.value; render(); };
    const more = $('#txMore'); if (more) more.onclick = () => { S.txLimit += 200; render(); };
  }
  const lm = $('#lockMin'); if (lm) lm.onchange = e => A.setLockMin(+e.target.value);
}

export { COLORS };
