/* FinPal Family - shared screen helpers: formatting, icons, sheets, toasts. */

export const S = {
  fam: null, data: null, cards: [], imports: [], problems: [], tab: 'home', names: { A: '', B: '' },
  txLimit: 150, txQuery: '', txOwner: '', txCat: '', openMonth: null, person: null, syncing: false,
  lastSync: null, syncError: null, installEvent: null, swWaiting: null, categories: []
};

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf0 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
export const fmt = n => nf0.format(Math.round(n || 0));
export const money = (n, signed = false) => {
  if (n === null || n === undefined || isNaN(n)) return '<span class="num">—</span>';
  const r = Math.round(n);
  const sign = r < 0 ? '-' : (signed && r > 0 ? '+' : '');
  return `<span class="num">${sign}₪${nf0.format(Math.abs(r))}</span>`;
};
export const abs$ = n => `<span class="num">₪${nf0.format(Math.abs(Math.round(n || 0)))}</span>`;
export const pct = n => `<span class="num">${Math.round(n || 0)}%</span>`;

export const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
// dates come from bank files: everything shown is rebuilt from numbers, so nothing from a file reaches the page as is
const num = v => (Number.isFinite(+v) ? +v : 0);
export const monthLabel = m => { const [y, mo] = String(m).split('-'); return `${HE_MONTHS[num(mo) - 1] || ''} ${num(y)}`; };
export const monthName = m => HE_MONTHS[num(String(m).split('-')[1]) - 1] || '';
export const shortMonth = m => (HE_MONTHS[num(String(m).split('-')[1]) - 1] || '').slice(0, 3) + "'";
export const dmy = d => { const [y, m, dd] = String(d).split('-'); return `${num(dd)}.${num(m)}.${String(num(y)).slice(2)}`; };
export const dm = d => { const [, m, dd] = String(d).split('-'); return `${num(dd)}.${num(m)}`; };
export const dayLabel = d => { const t = new Date(String(d).slice(0, 10) + 'T12:00:00'); return isNaN(t) ? '' : `יום ${HE_DAYS[t.getDay()]}, ${t.getDate()}.${t.getMonth() + 1}`; };

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysLeftInMonth(d = new Date()) {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return last - d.getDate() + 1;
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
}

export function ago(iso) {
  if (!iso) return '';
  const t = new Date(iso), now = new Date(), min = Math.round((now - t) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דק׳`;
  const hm = t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  if (t.toDateString() === now.toDateString()) return `היום ב-${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return `אתמול ב-${hm}`;
  return `${t.getDate()}.${t.getMonth() + 1} ב-${hm}`;
}

// ------------------------------------------------------------------ partners
export function who(name) {
  const n = S.names;
  if (name && name === n.A) return 'a';
  if (name && name === n.B) return 'b';
  return 's';
}
// CSS variables, so that each partner's color follows the light or dark look
export const COLORS = { a: 'var(--a)', b: 'var(--b)', s: 'var(--s)' };
export const colorOf = name => COLORS[who(name)];
export const initial = name => (String(name || '').trim()[0] || '?');
export function avatar(name, cls) {
  return `<span class="av ${cls || who(name)}" aria-hidden="true">${esc(initial(name))}</span>`;
}

// ------------------------------------------------------------------ icons (24px line icons)
const P = {
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  same: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.7-3.2 3-5 6-5s5.3 1.8 6 5M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.7c1.8.6 3 2.2 3.5 4.8"/>',
  heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  shield: '<path d="M12 3.5 5 6.2v5.3c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6.2z"/><path d="m9 12 2.2 2.2L15.3 10"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.7 4.7 0 0 0 7 18.5z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16 6.6l2.4 2.4M13.8 8.8l1.8 1.8"/>',
  seed: '<path d="M12 20.5v-8.5M12 12C12 8 9.3 5.2 5 5.2c0 4.3 2.8 6.8 7 6.8zM12 14.2c0-3.6 2.5-6.2 6.8-6.2 0 3.9-2.6 6.2-6.8 6.2z"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  trendUp: '<path d="m4 16 5.5-5.5 4 4L20 8"/><path d="M15 8h5v5"/>',
  trendDown: '<path d="m4 8 5.5 5.5 4-4L20 16"/><path d="M15 16h5v-5"/>',
  coffee: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.9.6 1.6 0 2.5M11.5 3.5c-.6.9.6 1.6 0 2.5"/>',
  repeat: '<path d="M17 3.5 20 6.5l-3 3M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20M7 20.5 4 17.5l3-3M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/>',
  copy2: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3 10h18M7 15h3"/>',
  bank: '<path d="M3.5 9.5 12 4.5l8.5 5M5.5 10v7M9.8 10v7M14.2 10v7M18.5 10v7M3.5 19.5h17"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.8 6.6-4M8.7 13.2l6.6 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M11 17.5h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1-1"/>',
  google: '<path d="M20 12.2c0-.6 0-1.2-.2-1.8H12v3.4h4.5a3.9 3.9 0 0 1-1.7 2.5v2.1h2.7c1.6-1.5 2.5-3.6 2.5-6.2zM12 20.5c2.3 0 4.2-.8 5.5-2.1l-2.7-2.1c-.7.5-1.7.8-2.8.8a4.9 4.9 0 0 1-4.6-3.4H4.6v2.2A8.5 8.5 0 0 0 12 20.5zM7.4 13.7a5 5 0 0 1 0-3.4V8.1H4.6a8.5 8.5 0 0 0 0 7.8zM12 6.9c1.3 0 2.4.4 3.3 1.3l2.4-2.4A8.5 8.5 0 0 0 4.6 8.1l2.8 2.2A4.9 4.9 0 0 1 12 6.9z"/>',
  chev: '<path d="m14.5 6-6 6 6 6"/>',
  back: '<path d="m9.5 6 6 6-6 6"/>',
  edit: '<path d="M14.5 5.5 18.5 9.5M4.5 19.5l1-4.2L15.8 5a1.4 1.4 0 0 1 2 0l1.2 1.2a1.4 1.4 0 0 1 0 2L8.7 18.5z"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M3 9h18M12 9v11M12 9c-1.5-3.5-5.5-4-5.5-1.7S12 9 12 9zm0 0c1.5-3.5 5.5-4 5.5-1.7S12 9 12 9z"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2.5 2.5 0 0 0 2.5 2.5H20V8H6.5A2.5 2.5 0 0 1 4 7.5z"/><circle cx="16" cy="13.8" r="1.1"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  flag: '<path d="M5.5 21V4M5.5 4.5h11l-2.2 4 2.2 4h-11"/>',
  finger: '<path d="M12 11v2.5c0 2.2-.6 4.3-1.7 6M8.6 9.6A3.8 3.8 0 0 1 15.8 11v2c0 1.6-.2 3.2-.7 4.7M5.4 15.6c.4-1.2.6-2.5.6-3.8a6 6 0 0 1 9.9-4.6M18.2 9.6c.3.8.4 1.6.4 2.4v1c0 1.9-.3 3.8-.8 5.5M8.6 20.4c.5-1 .9-2.1 1.1-3.3M4.3 10A8.3 8.3 0 0 1 12 3.7c2 0 3.9.7 5.4 1.9"/>',
  // the categories
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17M11 12.5v1.5h2v-1.5"/>',
  refund: '<path d="M9 14 4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
  arrowIn: '<path d="M17 7 7 17M7 9.5V17h7.5"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  cart: '<path d="M3.5 4.5h2.2l2.1 10.3a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.5-1.1L20 8H6.3"/><circle cx="10" cy="19.6" r="1.3"/><circle cx="17" cy="19.6" r="1.3"/>',
  utensils: '<path d="M6.5 3.5v5.5a2.5 2.5 0 0 0 5 0V3.5M9 3.5v17M17 20.5V3.5c-2 1-3.2 3.3-3.2 6.5 0 1.8.9 2.8 3.2 3"/>',
  car: '<path d="M4.5 17.5v-5l2-5.2c.3-.8 1-1.3 1.9-1.3h7.2c.9 0 1.6.5 1.9 1.3l2 5.2v5M4.5 12.5h15M4.5 17.5h15M6.5 17.5v2M17.5 17.5v2"/><circle cx="8" cy="15" r=".7"/><circle cx="16" cy="15" r=".7"/>',
  bus: '<rect x="5" y="3.5" width="14" height="14" rx="2.5"/><path d="M5 11h14M8 17.5V20M16 17.5V20M8.5 6.5h7M8.5 14.3v.1M15.5 14.3v.1"/>',
  bolt: '<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  city: '<path d="M4 20.5h16M6 20.5V8.5L12 4l6 4.5v12M10 20.5v-4h4v4M9.3 10.5v.1M14.7 10.5v.1M9.3 13.5v.1M14.7 13.5v.1"/>',
  wifi: '<path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.7a7.6 7.6 0 0 1 11 0M9.5 15.8a3.4 3.4 0 0 1 5 0M12 19v.1"/>',
  play: '<rect x="3.5" y="4.5" width="17" height="12.5" rx="2.5"/><path d="m10.5 8.2 4.3 2.6-4.3 2.6zM8 20.5h8"/>',
  umbrella: '<path d="M3.5 12a8.5 8.5 0 0 1 17 0zM12 12v6.3a2 2 0 0 1-4 0M12 3.5v-1"/>',
  medical: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>',
  shirt: '<path d="M8.5 4 4 6.5l1.7 3.8 2.3-1V20h8V9.3l2.3 1L20 6.5 15.5 4c-.5 1.4-1.9 2.3-3.5 2.3S9 5.4 8.5 4z"/>',
  bag: '<path d="M5.5 8h13l-1 12h-11zM9 10.5V7a3 3 0 0 1 6 0v3.5"/>',
  sofa: '<path d="M5 11V8.5A2.5 2.5 0 0 1 7.5 6h9A2.5 2.5 0 0 1 19 8.5V11M3.5 13a1.5 1.5 0 0 1 3 0v1.5h11V13a1.5 1.5 0 0 1 3 0v4.5h-17zM5.5 17.5V19M18.5 17.5V19"/>',
  ticket: '<path d="M4 7.5h16v3a1.5 1.5 0 0 0 0 3v3H4v-3a1.5 1.5 0 0 0 0-3zM14.5 8.5V10M14.5 11.3v1.4M14.5 14v1.5"/>',
  book: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 8h6"/>',
  suitcase: '<rect x="4" y="7.5" width="16" height="12" rx="2"/><path d="M9 7.5v-2A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5v2M8 7.5v12M16 7.5v12"/>',
  paw: '<circle cx="6.6" cy="10.2" r="1.6"/><circle cx="9.9" cy="6.4" r="1.6"/><circle cx="14.1" cy="6.4" r="1.6"/><circle cx="17.4" cy="10.2" r="1.6"/><path d="M12 11.5c-2.6 0-5 3.2-5 5.5 0 1.6 1.2 2.5 2.7 2.5 1 0 1.5-.5 2.3-.5s1.3.5 2.3.5c1.5 0 2.7-.9 2.7-2.5 0-2.3-2.4-5.5-5-5.5z"/>',
  sparkle: '<path d="M11 3.5c.7 3.9 2.6 5.8 6.5 6.5-3.9.7-5.8 2.6-6.5 6.5-.7-3.9-2.6-5.8-6.5-6.5 3.9-.7 5.8-2.6 6.5-6.5zM18 15c.3 1.6 1 2.3 2.5 2.5-1.5.2-2.2.9-2.5 2.5-.3-1.6-1-2.3-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z"/>',
  house: '<path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"/>',
  percent: '<path d="M18.5 5.5 5.5 18.5"/><circle cx="7.5" cy="7.5" r="2.2"/><circle cx="16.5" cy="16.5" r="2.2"/>',
  cash: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v.1M17.5 14.5v.1"/>',
  send: '<path d="M20.5 3.5 3.5 10.5l6.8 2.8 2.8 6.8z"/><path d="m10.3 13.3 10.2-9.8"/>',
  swap: '<path d="M7 4.5 3.5 8 7 11.5M3.5 8h13M17 12.5l3.5 3.5-3.5 3.5M20.5 16h-13"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3zM9 8h6M9 11.5h6M9 15h3.5"/>',
  dots: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 2l-6.7 6.7a1.4 1.4 0 0 1-2 0z"/><circle cx="8" cy="8" r="1.3"/>'
};
export function icon(name, cls) { return `<svg class="${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`; }

// ------------------------------------------------------------------ categories: an icon each, in the category's color
export const CAT_ICON = {
  'משכורת': 'briefcase', 'קצבאות וביטוח לאומי': 'bank', 'החזרים וזיכויים': 'refund', 'הכנסה מהשקעות': 'trendUp',
  'העברות נכנסות': 'arrowIn', 'הכנסות אחרות': 'plusCircle', 'מזון וסופרמרקט': 'cart', 'מסעדות וקפה': 'utensils',
  'דלק ורכב': 'car', 'תחבורה ציבורית ומוניות': 'bus', 'חשבונות בית': 'bolt', 'ארנונה ועירייה': 'city',
  'תקשורת ואינטרנט': 'wifi', 'מנויים ודיגיטל': 'play', 'ביטוחים': 'umbrella', 'בריאות ופארם': 'medical',
  'ביגוד והנעלה': 'shirt', 'קניות ואלקטרוניקה': 'bag', 'בית וריהוט': 'sofa', 'פנאי ובידור': 'ticket',
  'חינוך וילדים': 'book', 'נסיעות וחופשות': 'suitcase', 'חיות מחמד': 'paw', 'טיפוח ויופי': 'sparkle', 'תרומות': 'heart',
  'הלוואות ומשכנתא': 'house', 'עמלות וריביות': 'percent', 'משיכות מזומן': 'cash', 'העברות ותשלומים': 'send',
  'מיסים וממשלה': 'receipt', 'כרטיס אשראי - ללא פירוט': 'card', 'כרטיסי אשראי': 'card', 'כללי': 'tag',
  'השקעות וחיסכון': 'seed', 'סליקת אשראי (מנוטרל)': 'card', 'קבלת הלוואה': 'bank', 'העברה בין החשבונות שלנו': 'swap',
  'שאר הקטגוריות': 'dots', 'החזר הלוואה קצרה': 'refund', 'כסף שעבר דרך החשבון': 'swap'
};
const HEX = /^#[0-9A-Fa-f]{3,8}$/;
/** a category's color, as the engine keeps it (a color of a category the family added, too) */
export function catColor(cat) {
  const c = S.data && S.data.categories && S.data.categories[cat];
  return c && HEX.test(c.col || '') ? c.col : '#95A39C';
}
/** the category's icon on a tile of its color; `dot`: a partner's color in the corner (whose card it was) */
export function catIcon(cat, small, dot) {
  const col = cat === 'כרטיסי אשראי' ? 'var(--navy2)' : catColor(cat);
  return `<span class="cic${small ? ' sm' : ''}" style="--c:${col}" aria-hidden="true">${icon(CAT_ICON[cat] || 'tag')}${dot ? `<i style="background:${dot}"></i>` : ''}</span>`;
}

// ------------------------------------------------------------------ the look: light, dark or as the phone is
const THEME_KEY = 'finpal.theme';
export function themePref() { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
export function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref); else root.removeAttribute('data-theme');
  try { if (pref === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref); } catch (e) { /* private mode */ }
  // the browser's bar: the page's color in either look
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const add = (color, media) => { const m = document.createElement('meta'); m.name = 'theme-color'; m.content = color; if (media) m.media = media; document.head.append(m); };
  if (pref === 'auto') { add('#F6F2EA', '(prefers-color-scheme: light)'); add('#0E1620', '(prefers-color-scheme: dark)'); } else add(pref === 'dark' ? '#0E1620' : '#F6F2EA');
}

// ------------------------------------------------------------------ motion: numbers that count up, once per screen
export const calm = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
/** count each [data-count] up from 0 to its sum, in the same format as money() */
export function countUp(root) {
  if (calm()) return;
  root.querySelectorAll('[data-count]').forEach(el => {
    const to = Math.round(+el.dataset.count), signed = el.dataset.signed === '1', box = el.querySelector('.num');
    if (!box || !isFinite(to) || Math.abs(to) < 10) return;
    const final = box.textContent, ms = 750;
    let t0 = null, done = false;
    // the sum as written, at the end or after a second whatever the frames did
    const finish = () => { if (!done) { done = true; box.textContent = final; } };
    const show = v => { box.textContent = `${v < 0 ? '-' : signed && v > 0 ? '+' : ''}₪${nf0.format(Math.abs(v))}`; };
    const step = now => {
      if (done || !box.isConnected) return;
      if (t0 == null) t0 = now;
      const k = Math.min(1, (now - t0) / ms);
      if (k >= 1) { finish(); return; }
      show(Math.round(to * (1 - Math.pow(1 - k, 3))));
      requestAnimationFrame(step);
    };
    show(0);
    requestAnimationFrame(step);
    setTimeout(finish, ms + 300);
  });
}

// ------------------------------------------------------------------ feedback
export function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

export function sheet(html, { onClose } = {}) {
  const body = $('#sheetBody');
  body.innerHTML = html;
  $('#sheet').classList.remove('hidden');
  sheet.onClose = onClose || null;
  const first = body.querySelector('input, select, button');
  if (first && first.tagName !== 'BUTTON') setTimeout(() => first.focus(), 60);
  return body;
}
export function closeSheet() {
  $('#sheet').classList.add('hidden');
  const cb = sheet.onClose; sheet.onClose = null;
  if (cb) cb();
}

export function busy(text) { $('#busyText').textContent = text || 'רגע…'; $('#busy').classList.remove('hidden'); }
export function unbusy() { $('#busy').classList.add('hidden'); }

/** run fn with the busy layer up */
export async function withBusy(text, fn) {
  busy(text);
  try { return await fn(); } finally { unbusy(); }
}

// ------------------------------------------------------------------ building blocks
/** a row: label and its sub line, the amount and its sub line; `lead`: an icon before the label */
export function line(label, amount, sub, subAmt, attrs, lead) {
  return `<div class="line${attrs ? ' tap' : ''}${lead ? ' withic' : ''}" ${attrs || ''}>${lead || ''}<span class="lbl">${label}${sub ? `<span class="sub">${sub}</span>` : ''}</span>
    <span class="amt">${amount}${subAmt ? `<span class="sub">${subAmt}</span>` : ''}</span></div>`;
}

/** bars: name | bar | amount. `ic`: a category, shown by its icon; `dot`: a color before the name */
export function barRows(items, max) {
  const mx = max || Math.max(1, ...items.map(i => Math.max(i.value || 0, i.ref || 0)));
  return `<div class="bars">${items.map(i => `<div class="brow"${i.attrs ? ' ' + i.attrs : ''}><span class="ellip">${i.ic ? catIcon(i.ic, true) : i.dot ? `<span class="dot" style="--c:${esc(i.dot)}"></span>` : ''}${esc(i.label)}</span>
    <span class="track"><span class="fill" style="width:${Math.max(0, Math.min(100, (i.value || 0) / mx * 100))}%;--c:${esc(i.color || 'var(--green)')}"></span>
    ${i.ref ? `<span class="tick" style="inset-inline-start:${Math.min(100, i.ref / mx * 100)}%"></span>` : ''}</span>
    <span class="amt">${i.text || money(i.value)}</span></div>`).join('')}</div>`;
}

export function notice(html, kind) {
  return `<div class="notice ${kind || ''}">${icon(kind === 'green' ? 'shield' : 'info')}<div>${html}</div></div>`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('הועתק'); return true; } catch (e) { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  toast(ok ? 'הועתק' : 'לא הצלחתי להעתיק. אפשר לסמן ולהעתיק ידנית.');
  return ok;
}

/** the Android share sheet (WhatsApp etc.), or WhatsApp directly, or the clipboard */
export async function shareText(text, title) {
  if (navigator.share) {
    try { await navigator.share({ title: title || 'FinPal', text }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const a = document.createElement('a');
  a.href = wa; a.target = '_blank'; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  return 'whatsapp';
}
