/**
 * FinPal finance engine: a JavaScript port of the tested Python engine (YourAIFinPal: finance_engine/* and
 * service.ingest/post_process). Pure ES module, no DOM and no Node APIs. Deterministic: no clock and no
 * randomness; every timestamp comes from `today` or `opts.now`.
 *
 * State (plain JSON object, store it as is):
 *   { transactions:[...], cards:{}, owners:[], categories:[], rules:[], loans:[], settings:{}, meta:{},
 *     recurring_notes:{}, planned:[] }
 *   transactions have the columns of the Python `transactions` table (id = rising integer). meta also keeps
 *   the imported files (meta.files), second identities of rows (meta.uid_alias) and id counters (meta.seq).
 *
 * API (today = 'YYYY-MM-DD' or a Date):
 *   newState()                                    -> new state (default categories, built-in rules)
 *   ingest(state, parsedFiles, today, opts?)      -> {files:[{name,kind,status,added,dup,updated,message}], new_cards, reconcile}
 *        parsedFile = {name, kind, txns, warnings, error, sha256, path?}. Dedup by uid and soft_key, then postProcess.
 *        opts.now: timestamp for created_at/imported_at (default `${today}T00:00:00`).
 *   postProcess(state, today)                     -> categorize, neutralize card charges, salary months, fixed/variable
 *   setCardOwner(state, card, owner, nickname?)
 *   setCategory(state, idsOrUids, category, learn?, opts?) -> rows changed (number = id, string = uid)
 *   buildPayload(state, today, opts?)             -> the payload of Python build_payload, plus `insights`
 *        insights: up to 6 {kind, title, text, amount}; kinds: double_charge | subscription_up | category_up |
 *        dining | cut20. amount in ₪ (dining: signed difference from the average).
 *        opts.withIds: add `u` (uid) to every transaction. opts.now: generated_at (default `${today}T00:00:00`).
 *   listCards(state)              -> [{card, source, owner, nickname, count, first_seen, last_seen}]
 *   listCategories(state, kind?)  -> [{name, kind, color}] (selection list, desktop order)
 *   setSetting(state, key, value) (dotted keys: 'bank_owner', 'card_month_basis', 'budget_alerts.thresholds' ...)
 *   setRecurringNote(state, key, {promo_end?, promo_price?, note?, muted?}) (key = recurring item id)
 *   Also exported: addOwner, addRule, merchantKey, sameMerchant, DEFAULT_CATEGORIES.
 */

// ====================================================================== constants
export const SCHEMA = 2;
export const APP_NAME = 'Your AI FinPal';
export const SETTLEMENT_CATEGORY = 'סליקת אשראי (מנוטרל)';
export const UNDETAILED_CARD_CATEGORY = 'כרטיס אשראי - ללא פירוט';
export const FALLBACK_OUT = 'כללי';
export const FALLBACK_IN = 'הכנסות אחרות';
export const UNASSIGNED = 'לא משויך';
export const BUILTIN_RULES_VERSION = '2026.11.2';
export const CASHFLOW_VERSION = '1';

const AUTO_PREFIX = 'auto://';
const OWNER_COLORS = ['#2B5C88', '#C8742A', '#2F6B4F', '#A0566E', '#6B5B95', '#3E8A8A'];
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר',
  'אוקטובר', 'נובמבר', 'דצמבר'];
const WEEKDAYS_HE = ['שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון']; // Monday = 0
const ISSUER_LABEL = { max: 'MAX', isracard: 'ישראכרט', cal: 'כאל', amex: 'אמריקן אקספרס', diners: 'דיינרס',
  generic: 'כרטיס אשראי' };
const DETAILED_ISSUERS = new Set(['max']);
const SHIFT_FROM_DAY = 25;
const MIN_PRICE_STEP = 3.0;
const PRICE_STEP_PCT = 0.05;
const SPIKE_MIN = 500.0;
const SPIKE_PCT = 0.35;
const PROMO_NOTICE_DAYS = 30;
const NOT_PLANNED = new Set(['משיכות מזומן', 'הלוואות ומשכנתא', 'עמלות וריביות']);
const CONSUMPTION = new Set(['מזון וסופרמרקט', 'מסעדות וקפה', 'דלק ורכב', 'תחבורה ציבורית ומוניות', 'ביגוד והנעלה',
  'קניות ואלקטרוניקה', 'בית וריהוט', 'טיפוח ויופי', 'בריאות ופארם']);
const DEFAULT_THRESHOLDS = [50, 75, 90, 100];
const TRANSFER_WORDS = new Set(['bit', 'ביט', 'paybox', 'פייבוקס', 'pepper', 'פפר']);
const TRANSFER_PREFIXES = ['העבר', 'משיכ', 'הפקד', 'המחא', 'זיכוי'];

// kind: income | expense | saving | internal (internal = left out of the analytics)
export const DEFAULT_CATEGORIES = [
  ['משכורת', 'income', '#2F6B4F'],
  ['קצבאות וביטוח לאומי', 'income', '#4E8A68'],
  ['החזרים וזיכויים', 'income', '#6FA383'],
  ['הכנסה מהשקעות', 'income', '#3F7D74'],
  ['העברות נכנסות', 'income', '#7FAE95'],
  ['הכנסות אחרות', 'income', '#9DBFAA'],
  ['מזון וסופרמרקט', 'expense', '#C8742A'],
  ['מסעדות וקפה', 'expense', '#B3404A'],
  ['דלק ורכב', 'expense', '#2B5C88'],
  ['תחבורה ציבורית ומוניות', 'expense', '#4A6FA5'],
  ['חשבונות בית', 'expense', '#8C6D3F'],
  ['ארנונה ועירייה', 'expense', '#A3845A'],
  ['תקשורת ואינטרנט', 'expense', '#3E8A8A'],
  ['מנויים ודיגיטל', 'expense', '#6B5B95'],
  ['ביטוחים', 'expense', '#5C6F8A'],
  ['בריאות ופארם', 'expense', '#A0566E'],
  ['ביגוד והנעלה', 'expense', '#C99A2E'],
  ['קניות ואלקטרוניקה', 'expense', '#5E548E'],
  ['בית וריהוט', 'expense', '#9C6B4E'],
  ['פנאי ובידור', 'expense', '#3F8F6B'],
  ['חינוך וילדים', 'expense', '#6E8B3D'],
  ['נסיעות וחופשות', 'expense', '#2E7FA8'],
  ['חיות מחמד', 'expense', '#8A9A5B'],
  ['טיפוח ויופי', 'expense', '#C0697B'],
  ['תרומות', 'expense', '#B8913A'],
  ['הלוואות ומשכנתא', 'expense', '#7D3C45'],
  ['עמלות וריביות', 'expense', '#8C8C8C'],
  ['משיכות מזומן', 'expense', '#6F7D78'],
  ['העברות ותשלומים', 'expense', '#95A39C'],
  ['מיסים וממשלה', 'expense', '#8E5A2E'],
  ['כרטיס אשראי - ללא פירוט', 'expense', '#A7B2AC'],
  ['כללי', 'expense', '#BAC4BE'],
  ['השקעות וחיסכון', 'saving', '#2B5C88'],
  ['סליקת אשראי (מנוטרל)', 'internal', '#C5CEC8'],
  ['קבלת הלוואה', 'internal', '#B4BEB8'],
  ['העברה בין החשבונות שלנו', 'internal', '#A9B4AE'],
];

// built-in merchant rules: [patterns, category, direction, priority]  direction: any | out | in. The longest
// matching pattern wins among rules of the same priority; a lower priority comes first.
const BUILTIN_RULE_GROUPS = [
  // how the bank writes a transfer: before any word inside it ("דיגיטל", "אינטרנט") looks like a shop
  [['העברה דיגיטל', 'העברה דיגיטלית', 'הע. אינטרנט', 'העברה באינטרנט', 'העברה בנקאית', 'העב. לאחר', 'העברה לאחר',
    'הע. לאחר', 'העברה לחשבון'], 'העברות ותשלומים', 'out', 90],
  [['העברה דיגיטל', 'העברה דיגיטלית', 'הע. אינטרנט', 'העברה באינטרנט', 'העברה בנקאית', 'העב. מאחר', 'העברה מאחר',
    'הע. מאחר', 'מפייבוקס', 'הפקדת מזומן', "הפק' מזומן", 'הפקדה במזומן', 'בנק הפועלים', 'בנק לאומי', 'בנק דיסקונט',
    'בנק מזרחי', 'מזרחי טפחות', 'הבינלאומי', 'בנק יהב', 'בנק מרכנתיל', 'בנק ירושלים', 'אוצר החייל'], 'העברות נכנסות', 'in', 90],
  [['משכורת', 'שכר עבודה', 'salary', 'payroll', 'מחלקת שכר', '=שכר', 'עובדי מדינה'], 'משכורת', 'in'],
  [['ביטוח לאומי', 'בטוח לאומי', 'קצבה', 'קצבת', 'דמי אבטלה', 'דמי לידה', 'קצבת ילדים', 'מענק'], 'קצבאות וביטוח לאומי', 'in'],
  [['החזר מס', 'החזר מס הכנסה', 'זיכוי', 'החזר', 'refund'], 'החזרים וזיכויים', 'in'],
  [['ריבית זכות', 'דיבידנד', 'dividend', 'רווח הון', '=ריבית'], 'הכנסה מהשקעות', 'in'],
  [['bit', 'ביט', 'paybox', 'פייבוקס', 'פיי בוקס', 'pepper pay', 'העברה', 'העברת', 'זיכוי מ'], 'העברות נכנסות', 'in'],
  // a loan, and a card bill the bank spread into payments (the bill comes back, and is paid monthly)
  [['הלוואה', 'קבלת הלוואה', 'העמדת הלוואה', 'הלואה', 'העמדת הלואה', 'פריסה לתשלומים', 'פריסת'], 'קבלת הלוואה', 'in'],
  // money a pension or savings company pays a working family is savings taken out, not income
  [['מנורה מבטחים', 'מנורה חיסכון', 'מור גמל', 'אינפיניטי', 'פדיון'], 'השקעות וחיסכון', 'in'],
  [['פיקדון', 'פקדון', 'חיסכון', 'חסכון', 'קופת גמל', 'קרן השתלמות', 'השתלמות', 'ני ע', 'ניירות ערך', 'אקסלנס', 'excellence', 'interactive brokers', 'ibkr', 'אינטראקטיב', 'פסגות', 'מיטב', 'אלטשולר', 'ילין לפידות', 'אנליסט', 'הראל השקעות', 'blink', 'פיקדונות', '=גמל', 'גמל להשקעה', 'גמל להש', 'הראל גמל', 'קופג', 'פוליסת חיסכון'], 'השקעות וחיסכון', 'any'],
  [['שופרסל', 'shufersal', 'רמי לוי', 'יוחננוף', 'ויקטורי', 'victory', 'מגה בעיר', 'אושר עד', 'טיב טעם', 'חצי חינם', 'יינות ביתן', 'פרש מרקט', 'סופר יודה', 'קרפור', 'carrefour', 'am pm', 'אם פי אם', 'ampm', 'מחסני השוק', 'סטופ מרקט', 'זול ובגדול', 'קשת טעמים', 'מינימרקט', 'מכולת', 'סופרמרקט', 'יש חסד', 'היפר כהן', 'פוליצר', 'שוק העיר', 'מאפיית', 'מאפה', 'קצביית', 'אטליז', 'ירקן', 'פירות וירקות', 'נתיב החסד', 'סופר דוש', 'סופר ספיר', 'machsanei', 'osher ad', 'rami levy', 'yochananof', '=סופר', 'מרקט', 'פת הלחם',
    'קונדיטור', 'בשרים', 'מעדני', 'נספרסו', 'nespresso'], 'מזון וסופרמרקט', 'out'],
  [['מקדונלד', 'mcdonald', 'בורגר קינג', 'burger king', 'ארומה', 'aroma', 'קפה קפה', 'גרג', 'לנדוור', 'cofix', 'קופיקס', 'פיצה', 'פיצריה', 'דומינו', 'domino', 'פאפא גונס', 'שווארמה', 'פלאפל', 'סושי', 'מסעדת', 'מסעדה', 'בית קפה', 'wolt', 'וולט', 'תן ביס', '10bis', 'תןביס', 'סיבוס', 'cibus', 'japanika', 'גפניקה', 'מוזס', 'אגאדיר', 'בורגראנץ', 'קפולסקי', 'רולדין', 'starbucks', 'kfc', 'פרגו', 'שיפודי', 'המבורגר', '=קפה', 'בר', 'pub', 'פאב', 'קקאו', 'מכונות אוטומ', 'גלידה', 'גלידות', 'גלידריה', 'חומוס'], 'מסעדות וקפה', 'out'],
  [['פז', 'paz', '=דלק', 'דלק ', 'סונול', 'sonol', 'דור אלון', '=טן', 'ten', 'yellow', 'ילו', 'מנטה', 'חניון', 'חניה', 'פנגו', 'pango', 'סלופארק', 'cellopark', 'אחוזות החוף', 'כביש 6', 'כביש חוצה', 'דרך ארץ', 'נתיבי איילון', 'מוסך', 'צמיגים', 'טסט', 'משרד הרישוי', 'רישוי', 'שלמה סיקסט', 'sixt', 'אלדן', 'באדגט', 'budget', 'הרץ', 'hertz', 'avis', 'אוויס', 'אלבר', 'תחנת דלק', 'חניונים'], 'דלק ורכב', 'out'],
  [['רב קו', 'rav kav', 'ravkav', 'מוביט', 'moovit', 'gett', 'גט טקסי', 'yango', 'יאנגו', 'uber', 'אובר', 'רכבת ישראל', 'israel railways', 'אגד', '=דן', 'קווים', 'מטרופולין', 'אפיקים', 'נתיב אקספרס', 'סופרבוס', 'אקסטרה', 'מונית', 'taxi'], 'תחבורה ציבורית ומוניות', 'out'],
  [['חברת החשמל', 'חברת חשמל', 'חשמל לישראל', 'iec', 'מי אביבים', 'תאגיד מים', '=מים', 'מי כרמל', 'הגיחון', 'מי רעננה', 'מי שבע', 'מי ציונה', 'פזגז', 'אמישראגז', 'סופרגז', '=גז', 'ועד בית', 'חשבון חשמל', 'electra power', 'אלקטרה פאוור', 'סלקום אנרגיה', 'פרטנר חשמל', 'בזק חשמל', 'אמישרגז'], 'חשבונות בית', 'out'],
  [['ארנונה', 'עיריית', 'עירית', 'עירייה', 'מועצה אזורית', 'מועצה מקומית', 'מועצה', 'חברה עירונית'], 'ארנונה ועירייה', 'out'],
  [['סלקום', 'cellcom', 'פרטנר', 'partner', '=הוט', 'hot mobile', 'הוט מובייל', 'hot net', 'בזק', 'bezeq', '=yes', 'גולן טלקום', 'golan', '=012', '=013', '=019', '=018', 'רמי לוי תקשורת', 'we4g', 'אקספון', 'xfone', 'פלאפון', 'pelephone', 'סטינג', '=sting', 'אינטרנט', 'תקשורת', 'סלולר', 'טלקום'], 'תקשורת ואינטרנט', 'out'],
  [['netflix', 'נטפליקס', 'spotify', 'ספוטיפיי', 'apple com', 'itunes', 'icloud', 'google', 'youtube', 'amazon prime', 'disney', 'dazn', 'chatgpt', 'openai', 'anthropic', 'claude ai', 'microsoft', 'adobe', 'dropbox', 'steam', 'playstation', 'xbox', 'nintendo', 'patreon', 'linkedin', 'zoom', 'canva', 'notion', 'github', 'audible', 'kindle', 'tradingview', 'midjourney', 'investing com', 'finviz'], 'מנויים ודיגיטל', 'out'],
  [['ביטוח', 'הראל', 'מגדל', 'כלל ביטוח', 'הפניקס', 'מנורה', 'איילון', '=aig', 'ביטוח ישיר', 'הכשרה', 'שירביט', 'ליברה', 'libra', 'wesure', 'ווישור', 'רכב חובה', 'ביטוח חובה', 'אנקור'], 'ביטוחים', 'out'],
  [['סופר פארם', 'super pharm', 'superpharm', 'בי פארם', 'be pharm', 'ניו פארם', 'new pharm', 'גוד פארם', 'מכבי', 'כללית', 'מאוחדת', '=לאומית', 'בית מרקחת', 'פארם', 'רופא', 'מרפאה', 'מרפאת', 'שיניים', 'אופטיקה', 'אופטיק', 'הלפרין', 'מעבדה', 'בית חולים', 'רפואה', 'פיזיותרפיה', 'מרפאות'], 'בריאות ופארם', 'out'],
  [['זארה', 'zara', 'h m', 'קסטרו', 'castro', '=פוקס', '=fox', '=golf', '=גולף', 'רנואר', 'renuar', 'אמריקן איגל', 'american eagle', 'terminal x', 'terminalx', 'טרמינל איקס', 'asos', 'shein', 'נייקי', 'nike', 'אדידס', 'adidas', 'נעלי', 'הוניגמן', 'טוונטי פור סבן', 'מנגו', '=mango', 'pull bear', 'ברשקה', 'bershka', 'stradivarius', 'גאפ', 'gap', 'קרייזי ליין', 'סקופ', 'ללה', 'lululemon', 'אופנה', 'ביגוד', 'הנעלה', 'טופ טן'], 'ביגוד והנעלה', 'out'],
  [['amazon', 'אמזון', 'aliexpress', 'עלי אקספרס', 'ebay', 'איביי', 'ksp', '=באג', '=bug', 'ivory', 'אייבורי', 'מחסני חשמל', 'שקם אלקטריק', 'temu', 'טמו', 'iherb', 'next', 'פנדה', 'מחשבים', 'אלקטרוניקה', 'דיגיטל', 'idigital', 'istore', 'apple store', 'ציוד משרד'], 'קניות ואלקטרוניקה', 'out'],
  [['איקאה', 'ikea', '=ace', 'אייס', 'הום סנטר', 'home center', 'טמבור', 'מקס סטוק', 'max stock', 'ניצת הדובדבן', 'ביתילי', 'עצמלה', 'פוקס הום', 'fox home', 'גולף אנד קו', 'זול סטוק', 'ריהוט', 'רהיטים', 'כלי בית', 'המשביר', 'מיניסו', 'miniso', 'פליינג טייגר', 'flying tiger'], 'בית וריהוט', 'out'],
  [['סינמה סיטי', 'cinema city', 'יס פלאנט', 'yes planet', 'סינמטק', 'הופעה', 'eventim', 'לאן', 'תיאטרון', 'הבימה', 'קאמרי', 'מוזיאון', 'ספא', 'כושר', 'הולמס פלייס', 'holmes place', 'גו אקטיב', 'go active', 'ספורט', 'בריכה', 'קאנטרי', 'באולינג', 'לונה פארק', 'צומת ספרים', 'סטימצקי', 'steimatzky', '=ספר', 'ספרים', 'פארק', 'גימבורי', 'sport'], 'פנאי ובידור', 'out'],
  [['=גן', 'גנון', 'צהרון', 'בית ספר', 'בית הספר', 'אוניברסיטה', 'מכללה', 'שכר לימוד', 'קורס', '=חוג', 'חוגים', 'צעצועים', 'טויס', 'toys', 'שילב', 'בייבי', 'baby', 'מעון', 'udemy', 'coursera', '=לגו', 'lego'], 'חינוך וילדים', 'out'],
  [['אל על', 'el al', 'elal', 'ישראייר', 'ארקיע', 'wizz', 'ryanair', 'easyjet', 'booking', 'בוקינג', 'airbnb', 'expedia', 'agoda', 'hotel', 'מלון', 'נמל תעופה', 'duty free', 'דיוטי פרי', 'james richardson', 'גיימס ריצרדסון', 'issta', 'איסתא', 'דיזנהויז', 'טיסה', 'טיסות', 'eurowings', 'lufthansa', 'turkish airlines', 'aegean'], 'נסיעות וחופשות', 'out'],
  [['פט שופ', 'petshop', '=pet', 'חיות', 'וטרינר', 'וטרינרית', 'אניפט', 'zoo', 'בעלי חיים'], 'חיות מחמד', 'out'],
  [['מספרה', 'קוסמטיקה', 'ציפורניים', 'מניקור', 'סבון של פעם', 'lush', 'sephora', 'mac cosmetics', 'ברבר', 'barber', 'טיפוח', 'יופי', '=bbw', 'bath body', 'קוסמסיוטיק'], 'טיפוח ויופי', 'out'],
  [['תרומה', 'תרומות', 'עמותת', 'עמותה', 'לתת', 'latet', 'יד שרה'], 'תרומות', 'out'],
  [['הלוואה', 'הלוואות', 'פרעון הלוואה', 'פירעון הלוואה', 'החזר הלוואה', 'משכנתא', 'משכנתה', 'טפחות', 'שפיצר', 'פרעון', 'פירעון', 'פריסה לתשלומים', 'פריסת'], 'הלוואות ומשכנתא', 'out'],
  [['עמלה', 'עמלת', 'עמלות', 'דמי ניהול', 'דמי כרטיס', 'ריבית חובה', 'ריבית', 'משיכת יתר', 'דמי טיפול'], 'עמלות וריביות', 'out'],
  [['משיכת מזומן', 'כספומט', '=מזומן', 'משיכה מבנקט', 'בנקט', '=atm', 'משיכה במזומן'], 'משיכות מזומן', 'out'],
  [['bit', 'ביט', 'paybox', 'פייבוקס', 'פיי בוקס', 'pepper pay', 'העברה', 'העברת', 'הוראת קבע', '=צ ק', 'שיק'], 'העברות ותשלומים', 'out', 110],
  [['מס הכנסה', 'מעמ', 'רשות המסים', 'ביטוח לאומי', 'בטוח לאומי', 'משרד הפנים', 'דואר ישראל', 'אגרה', 'אגרת', 'רשות האכיפה', 'הוצאה לפועל', 'gov il', 'קנס', 'דוח חניה', 'משרד התחבורה'], 'מיסים וממשלה', 'out'],
];

// MAX's own category column -> our categories (substring match, first wins)
const EXT_CATEGORY_MAP = [['חשמל ומחשב', 'קניות ואלקטרוניקה'], ['מחשב', 'קניות ואלקטרוניקה'], ['אלקטרו', 'קניות ואלקטרוניקה'],
  ['מזון', 'מזון וסופרמרקט'], ['מסעד', 'מסעדות וקפה'], ['קפה', 'מסעדות וקפה'], ['ברים', 'מסעדות וקפה'],
  ['דלק', 'דלק ורכב'], ['רכב', 'דלק ורכב'], ['תחבורה', 'תחבורה ציבורית ומוניות'],
  ['תקשורת', 'תקשורת ואינטרנט'], ['פנאי', 'פנאי ובידור'], ['בידור', 'פנאי ובידור'],
  ['ספורט', 'פנאי ובידור'], ['ספרים', 'פנאי ובידור'], ['אופנה', 'ביגוד והנעלה'],
  ['ביגוד', 'ביגוד והנעלה'], ['רפואה', 'בריאות ופארם'], ['מרקחת', 'בריאות ופארם'],
  ['פארם', 'בריאות ופארם'], ['עירי', 'ארנונה ועירייה'], ['ממשל', 'מיסים וממשלה'],
  ['ביטוח', 'ביטוחים'], ['חשמל', 'חשבונות בית'], ['גז', 'חשבונות בית'], ['ריהוט', 'בית וריהוט'],
  ['בית', 'בית וריהוט'], ['קוסמטיקה', 'טיפוח ויופי'], ['טיפוח', 'טיפוח ויופי'],
  ['טיסות', 'נסיעות וחופשות'], ['תיירות', 'נסיעות וחופשות'], ['נופש', 'נסיעות וחופשות'],
  ['בעלי חיים', 'חיות מחמד'], ['תרומ', 'תרומות'], ['חינוך', 'חינוך וילדים'],
  ['העבר', 'העברות ותשלומים'], ['שונות', 'כללי']];

// settings the engine reads (core/settings.py DEFAULTS); state.settings holds the user's changes
const DEFAULT_SETTINGS = {
  card_month_basis: 'charge', // billing date (cash flow) | 'transaction' (purchase date)
  bank_owner: 'משותף',
  settlement_tolerance: 5.0,
  issuer_keywords: {
    // cards of Leumi that MAX runs are charged in the bank as "לאומי ויזה" / "לאומי מסטרקארד"
    max: ['מקס איט', 'מקס-איט', 'max it', 'maxit', 'לאומי קארד', 'לאומיקארד', 'לאומי כרטיסים', 'מקס פיננסים',
      'מקס איט פיננסים', 'לאומי ויזה', 'לאומי-ויזה', 'לאומי מסטרקארד', 'לאומי מאסטרקארד'],
    isracard: ['ישראכרט', 'isracard'],
    cal: ['כרטיסי אשראי לישראל', 'כאל', 'ויזה כאל', 'visa cal', 'cal-'],
    amex: ['אמריקן אקספרס', 'אמקס', 'american express'],
    diners: ['דיינרס', 'diners'],
    generic: ['חיוב כרטיס אשראי', 'חיוב כרטיס', 'כרטיס אשראי', 'כרטיסי אשראי'],
  },
  mobile_tx_days: 120,
  budget_alerts: { enabled: true, thresholds: [50, 75, 90, 100] },
  recurring_alerts: { enabled: true },
  planner: { min_spike: 500 },
};

// ====================================================================== Python-compatible numbers
const hasOwn = (o, k) => o != null && k != null && Object.prototype.hasOwnProperty.call(o, k);

/** Python round(x, n): correctly rounded; exact binary halves go to the even digit. */
function pyRound(x, n = 0) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  const ax = Math.abs(x);
  const t = ax * 2 ** (n + 1);
  let r;
  if (Number.isInteger(t) && t % 2 === 1 && t < 2 ** 53) { // an exact tie
    const h = Math.floor(ax * 10 ** n);
    r = (h % 2 === 0 ? h : h + 1) / 10 ** n;
  } else {
    r = Number(ax.toFixed(n));
  }
  return (x < 0 || Object.is(x, -0)) ? -r : r;
}

/** Python round(x) (an int; halves to even). */
const pyRoundInt = (x) => pyRound(x, 0) + 0;

/** Python format(x, '.{d}f') / format(x, ',.{d}f'). */
function pyFixed(x, d, comma = false) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : (x > 0 ? 'inf' : '-inf');
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  const t = ax * 2 ** (d + 1);
  let s;
  if (Number.isInteger(t) && t % 2 === 1 && t < 2 ** 53) {
    const h = Math.floor(ax * 10 ** d);
    s = String(h % 2 === 0 ? h : h + 1);
    if (d > 0) {
      s = s.padStart(d + 1, '0');
      s = `${s.slice(0, -d)}.${s.slice(-d)}`;
    }
  } else {
    s = ax.toFixed(d);
  }
  if (comma) {
    const dot = s.indexOf('.');
    const ip = dot < 0 ? s : s.slice(0, dot);
    s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dot < 0 ? '' : s.slice(dot));
  }
  return (neg ? '-' : '') + s;
}

/** str() of a Python value as it appears inside f-strings (floats keep '.0', None is 'None'). */
function pyStr(x) {
  if (x === null || x === undefined) return 'None';
  if (typeof x === 'boolean') return x ? 'True' : 'False';
  if (typeof x === 'number' && Number.isInteger(x) && Math.abs(x) < 1e16) return Object.is(x, -0) ? '-0.0' : `${x}.0`;
  return String(x);
}
/** str() of a value read from an INTEGER column. */
const pyIntStr = (x) => (x === null || x === undefined ? 'None' : String(x));

const fmtShekel = (v) => `₪${pyFixed(v, 0, true)}`; // behavior._fmt
const money = (v) => (Math.abs(v) >= 100 ? `₪${pyFixed(Math.abs(v), 0, true)}`
  : `₪${pyFixed(Math.abs(v), 2, true)}`.replace('.00', '')); // planner._money
const pyTruthy = (v) => (Array.isArray(v) ? v.length > 0
  : v !== null && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);
const pyMax = (a, b) => (b > a ? b : a); // Python max(a, b): the first one on ties
const pyMin = (a, b) => (b < a ? b : a);

/** SQLite SUM() (Kahan-Babuska-Neumaier, SQLite >= 3.43); null when there is nothing to sum. */
function sqlSum(vals) {
  let s = 0;
  let err = 0;
  let n = 0;
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    n++;
    const t = s + v;
    if (Math.abs(s) > Math.abs(v)) err += (s - t) + v;
    else err += (v - t) + s;
    s = t;
  }
  if (!n) return null;
  return Number.isFinite(err) ? s + err : s;
}

/** Python 3.12+ sum() of floats (Neumaier compensation). */
function pySum(vals) {
  if (!vals.length) return 0;
  let f = 0 + vals[0];
  let c = 0;
  for (let i = 1; i < vals.length; i++) {
    const x = vals[i];
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** math.fsum: the correctly rounded sum (Shewchuk partials, as in CPython). */
function fsum(vals) {
  const p = [];
  for (let x of vals) {
    if (!Number.isFinite(x)) return vals.reduce((a, b) => a + b, 0);
    let i = 0;
    for (let j = 0; j < p.length; j++) {
      let y = p[j];
      if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t; }
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) p[i++] = lo;
      x = hi;
    }
    p.length = i;
    if (x !== 0) p.push(x);
  }
  let n = p.length;
  let hi = 0;
  let lo = 0;
  if (n > 0) {
    hi = p[--n];
    while (n > 0) {
      const x = hi;
      const y = p[--n];
      hi = x + y;
      lo = y - (hi - x);
      if (lo !== 0) break;
    }
    if (n > 0 && ((lo < 0 && p[n - 1] < 0) || (lo > 0 && p[n - 1] > 0))) {
      const y = lo * 2;
      const x = hi + y;
      if (y === x - hi) hi = x;
    }
  }
  return hi;
}

const fmean = (vals) => fsum(vals) / vals.length; // statistics.fmean

function median(vals) { // statistics.median
  const d = [...vals].sort((a, b) => a - b);
  const n = d.length;
  if (!n) throw new Error('median of no data');
  return n % 2 ? d[(n - 1) / 2] : (d[n / 2 - 1] + d[n / 2]) / 2;
}

function exactParts(x) { // x = m * 2^e exactly (m a BigInt)
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  const hi = v.getUint32(0);
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(v.getUint32(4));
  if (exp) m |= 1n << 52n;
  return [hi >>> 31 ? -m : m, exp ? exp - 1075 : -1074];
}
const bitLen = (b) => (b === 0n ? 0 : b.toString(2).length);
function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLen(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** statistics.pstdev: exact rational sum of squares and a correctly rounded square root, like CPython. */
function pstdev(vals) {
  const parts = vals.map(exactParts);
  const e0 = Math.min(...parts.map((p) => p[1]));
  let sx = 0n;
  let sxx = 0n;
  for (const [m, e] of parts) {
    const x = m << BigInt(e - e0);
    sx += x;
    sxx += x * x;
  }
  const count = BigInt(vals.length);
  let n = count * sxx - sx * sx; // mss = n / m
  let m = count * count;
  if (n === 0n) return 0;
  if (e0 >= 0) n <<= BigInt(2 * e0);
  else m <<= BigInt(-2 * e0);
  const rto = (a, b) => { // floor(sqrt(a/b)) rounded to odd
    const r = isqrt(a / b);
    return r * r * b !== a ? r | 1n : r;
  };
  const q = Math.floor((bitLen(n) - bitLen(m) - 109) / 2);
  if (q >= 0) return Number(rto(n, m << BigInt(2 * q)) << BigInt(q));
  let r = Number(rto(n << BigInt(-2 * q), m));
  for (let k = -q; k > 0; k -= 1000) r /= 2 ** Math.min(k, 1000);
  return r;
}

// ====================================================================== Python-compatible text
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'; // str.isspace
const RE_WS = new RegExp(`[${WS}]+`, 'g');
const RE_EDGE_WS = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');
const RE_NOT_KEY = new RegExp(`[^\\p{L}${WS}]`, 'gu'); // neither str.isalpha() nor str.isspace()
const RE_BIDI = /[‎‏‪-‮⁦-⁩﻿]/g;
const RE_QUOTES = /["'״׳`´‘’“”]/g;
const RE_NOT_DIGIT = /\P{Nd}/gu; // Python's \D

const pyStrip = (s) => s.replace(RE_EDGE_WS, '');
const pySplit = (s) => s.split(RE_WS).filter(Boolean); // str.split()

function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
}
const cpSlice = (s, n) => (cpLen(s) <= n ? s : Array.from(s).slice(0, n).join(''));

/** Code-point order (Python str comparison, SQLite BINARY collation). */
function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xs = x >= 0xd800 && x <= 0xdfff;
      const ys = y >= 0xd800 && y <= 0xdfff;
      if (xs && !ys) return 1;
      if (ys && !xs) return -1;
      return x - y;
    }
  }
  return a.length - b.length;
}

/** SQLite ordering of one value: NULL < numbers < text. */
function sqlCmp(a, b) {
  const ra = a === null || a === undefined ? 0 : typeof a === 'string' ? 2 : 1;
  const rb = b === null || b === undefined ? 0 : typeof b === 'string' ? 2 : 1;
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
  return cmpStr(a, b);
}
function keyCmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    const c = sqlCmp(a[i], b[i]);
    if (c) return c;
  }
  return 0;
}
const strMin = (arr) => arr.reduce((m, x) => (m === null || cmpStr(x, m) < 0 ? x : m), null);
const strMax = (arr) => arr.reduce((m, x) => (m === null || cmpStr(x, m) > 0 ? x : m), null);

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).replace(RE_BIDI, '').replace(/ /g, ' ');
  return pyStrip(s.replace(RE_WS, ' '));
}

function normHeader(value) {
  return pyStrip(cleanText(value).replace(RE_QUOTES, '').replace(RE_WS, ' ')).toLowerCase();
}

/** Stable key for 'the same merchant' (drops branch numbers, punctuation, case). */
export function merchantKey(desc) {
  const base = cleanText(desc).toLowerCase();
  const s = pyStrip(base.replace(RE_NOT_KEY, ' ').replace(RE_WS, ' '));
  return s || base;
}

/** Strict test between two merchant keys (normalize.same_merchant). */
export function sameMerchant(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const [short, long] = cpLen(b) < cpLen(a) ? [b, a] : [a, b];
  if (cpLen(short) >= 6 && long.startsWith(short)) return true;
  const ta = new Set(pySplit(a));
  const tb = new Set(pySplit(b));
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  const union = ta.size + tb.size - common;
  return common >= 2 && common / union >= 0.75;
}

function isIls(currency) {
  const c = normHeader(currency);
  return ['', '₪', 'שח', 'ils', 'nis', 'שקל', 'שקלים'].includes(c) || c.includes('₪');
}

// ====================================================================== dates (ISO strings, UTC arithmetic)
const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const pad4 = (n) => String(n).padStart(4, '0');
const dnum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS;
const diso = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const addDays = (iso, n) => diso(dnum(iso) + n);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (iso) => (new Date(dnum(iso) * DAY_MS).getUTCDay() + 6) % 7; // Monday = 0

function shiftMonth(m, n) {
  const idx = +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1) + n;
  const y = Math.floor(idx / 12);
  return `${pad4(y)}-${pad2(idx - y * 12 + 1)}`;
}
const nextMonth = (m) => shiftMonth(m, 1);
const prevMonth = (m) => shiftMonth(m, -1);
const monthEnd = (m) => addDays(`${nextMonth(m)}-01`, -1);
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

function addMonths(iso, n) { // clamps the day to the month's length
  const idx = +iso.slice(0, 4) * 12 + (+iso.slice(5, 7) - 1) + n;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return `${pad4(y)}-${pad2(m)}-${pad2(Math.min(+iso.slice(8, 10), daysInMonth(y, m)))}`;
}

function monthsRange(first, last) {
  const out = [];
  for (let m = first; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

const fmtDM = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const fmtMY = (iso) => `${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

function isoDay(today) {
  if (today === undefined || today === null) today = new Date();
  if (today instanceof Date) return `${pad4(today.getFullYear())}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  return String(today).slice(0, 10);
}

// ====================================================================== state & settings
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function getPath(obj, dotted, def) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (!isObj(cur) || !hasOwn(cur, part)) return def;
    cur = cur[part];
  }
  return cur;
}

const settingsOf = (state) => deepMerge(DEFAULT_SETTINGS, state.settings);

function maxId(arr) {
  let m = 0;
  for (const r of arr) if (typeof r.id === 'number' && r.id > m) m = r.id;
  return m;
}

/** AUTOINCREMENT: ids are never reused, even after a delete. */
function nextId(state, table) {
  const arr = table === 'files' ? state.meta.files : state[table];
  const id = Math.max(state.meta.seq[table] || 0, maxId(arr)) + 1;
  state.meta.seq[table] = id;
  return id;
}

function ensureState(state) {
  for (const [k, make] of [['transactions', () => []], ['cards', () => ({})], ['owners', () => []],
    ['categories', () => []], ['rules', () => []], ['loans', () => []], ['settings', () => ({})], ['meta', () => ({})],
    ['recurring_notes', () => ({})], ['planned', () => []]]) {
    if (state[k] === null || state[k] === undefined) state[k] = make();
  }
  const meta = state.meta;
  if (!Array.isArray(meta.files)) meta.files = [];
  if (!isObj(meta.uid_alias)) meta.uid_alias = {};
  if (!isObj(meta.seq)) meta.seq = {};
  const have = new Set(state.categories.map((c) => c.name)); // INSERT OR IGNORE, like the desktop's start-up
  DEFAULT_CATEGORIES.forEach(([name, kind, color], i) => {
    if (!have.has(name)) {
      state.categories.push({ name, kind, color, sort: i });
      have.add(name);
    }
  });
  if (meta.builtin_rules_version !== BUILTIN_RULES_VERSION) {
    state.rules = state.rules.filter((r) => r.origin !== 'builtin');
    for (const [patterns, category, direction, priority] of BUILTIN_RULE_GROUPS) {
      for (const pattern of patterns) {
        state.rules.push({ id: nextId(state, 'rules'), pattern, category, direction, source: 'any', priority: priority ?? 100,
          is_regex: 0, origin: 'builtin', created_at: null });
      }
    }
    meta.builtin_rules_version = BUILTIN_RULES_VERSION;
  }
  return state;
}

export function newState() {
  const state = { transactions: [], cards: {}, owners: [], categories: [], rules: [], loans: [], settings: {},
    meta: {}, recurring_notes: {}, planned: [] };
  ensureState(state);
  state.meta.cashflow_version = CASHFLOW_VERSION;
  return state;
}

/** Settings.set with dotted keys ('bank_owner', 'budget_alerts.thresholds'). */
export function setSetting(state, key, value) {
  ensureState(state);
  const parts = String(key).split('.');
  let cur = state.settings;
  for (const p of parts.slice(0, -1)) {
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

// ====================================================================== categorizer (categories.py)
function compileRule(r) {
  let p = pyStrip(String(r.pattern ?? ''));
  let exact = p.startsWith('=');
  if (exact) p = p.slice(1);
  const origin = r.origin || 'builtin';
  const rule = { category: r.category, origin, direction: r.direction || 'any', source: r.source || 'any',
    priority: r.priority || 100, rank: origin === 'builtin' ? 1 : 0, rx: null, key: '', exact };
  if (r.is_regex) {
    rule.key = p;
    try { rule.rx = new RegExp(p, 'iu'); } catch {
      try { rule.rx = new RegExp(p, 'i'); } catch { rule.rx = /(?!)/; }
    }
  } else {
    rule.key = merchantKey(p);
    if (!rule.key.includes(' ') && cpLen(rule.key) <= 3) rule.exact = true; // short words match whole words
  }
  rule.klen = cpLen(rule.key);
  return rule;
}

/** User rules (manual/learned/AI) before built-in ones; then lower priority, then the longest pattern. */
function makeCategorizer(state) {
  const kinds = new Map(state.categories.map((c) => [c.name, c.kind]));
  const rules = [...state.rules].sort((a, b) => a.id - b.id).map(compileRule);
  rules.sort((a, b) => a.rank - b.rank || a.priority - b.priority || b.klen - a.klen);
  return { rules, kinds };
}

function ruleMatches(r, key, tokens, raw, direction, source) {
  if (r.direction !== 'any' && r.direction !== direction) return false;
  if (r.source !== 'any' && r.source !== source) return false;
  if (r.rx) return r.rx.test(raw);
  if (!r.key) return false;
  if (r.exact) {
    if (r.key.includes(' ')) return ` ${key} `.includes(` ${r.key} `);
    return tokens.has(r.key);
  }
  return key.includes(r.key);
}

function categorizeOne(cz, description, amount, source, extCategory) {
  const key = merchantKey(description);
  const tokens = new Set(pySplit(key));
  const src = source === 'leumi' ? 'bank' : 'card';
  // a positive card line is a refund: it belongs to the merchant's expense category
  const direction = (amount < 0 || src === 'card') ? 'out' : 'in';
  for (const r of cz.rules) {
    if (ruleMatches(r, key, tokens, String(description ?? ''), direction, src) && cz.kinds.has(r.category)) {
      return [r.category, r.origin];
    }
  }
  if (extCategory && direction === 'out') {
    const e = pyStrip(String(extCategory));
    if (cz.kinds.has(e)) return [e, 'ext'];
    for (const [needle, cat] of EXT_CATEGORY_MAP) if (e.includes(needle)) return [cat, 'ext'];
  }
  return [direction === 'out' ? FALLBACK_OUT : FALLBACK_IN, 'fallback'];
}

function categorizeRows(state, onlyMissing, cz = makeCategorizer(state)) {
  let n = 0;
  for (const t of state.transactions) {
    if (onlyMissing ? t.category !== null && t.category !== undefined : (t.category_locked || t.is_settlement)) continue;
    const [cat, origin] = categorizeOne(cz, t.description, t.amount, t.source, t.ext_category);
    t.category = cat;
    t.category_source = origin;
    n++;
  }
  return n;
}

// ====================================================================== ingest (service.py)
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const txt = (v) => (v === null || v === undefined ? null : String(v));

function normTxn(t) {
  return {
    source: txt(t.source), account: txt(t.account), date: txt(t.date), charge_date: txt(t.charge_date ?? t.date),
    description: t.description === null || t.description === undefined ? '' : String(t.description),
    amount: Number(t.amount), orig_amount: num(t.orig_amount), orig_currency: txt(t.orig_currency),
    reference: txt(t.reference), balance: num(t.balance), txn_type: txt(t.txn_type), notes: txt(t.notes),
    ext_category: txt(t.ext_category), installment_no: num(t.installment_no), installment_total: num(t.installment_total),
    day_seq: num(t.day_seq) ?? 0, uid: txt(t.uid), soft_key: t.soft_key ? String(t.soft_key) : null, pending: !!t.pending,
  };
}

const uniqJoin = (list) => [...new Set((list || []).map(String))].join('; ');

function deleteRows(state, ids) { // deletes rows and their second identities; returns their uids
  const set = new Set(ids);
  const gone = new Set();
  if (!set.size) return gone;
  state.transactions = state.transactions.filter((t) => {
    if (set.has(t.id)) { gone.add(t.uid); return false; }
    return true;
  });
  for (const [u, tid] of Object.entries(state.meta.uid_alias)) if (set.has(tid)) delete state.meta.uid_alias[u];
  return gone;
}

function dropPending(state, path, soft) {
  const fileIds = new Set(state.meta.files.filter((f) => f.path === path).map((f) => f.id));
  const rows = state.transactions.filter((t) => t.pending && fileIds.has(t.file_id));
  if (soft) for (const r of rows) if (r.soft_key && soft.get(r.soft_key) === r.id) soft.delete(r.soft_key);
  return deleteRows(state, rows.map((r) => r.id));
}

const isAutoPath = (p) => typeof p === 'string' && p.slice(0, AUTO_PREFIX.length).toLowerCase() === AUTO_PREFIX;
const crossKey = (source, account, amount) => JSON.stringify([source, account, pyRoundInt(amount * 100)]);

/** Rows that arrived the other way (file vs automatic connection) in the same dates. */
function crossIndex(state, txns, isAuto) {
  const idx = new Map();
  if (!txns.length) return idx;
  const lo = addDays(strMin(txns.map((t) => t.date)), -1);
  const hi = addDays(strMax(txns.map((t) => t.date)), 1);
  const paths = new Map(state.meta.files.map((f) => [f.id, f.path]));
  const rows = state.transactions.filter((t) => {
    if (!(t.date >= lo && t.date <= hi)) return false;
    const auto = isAutoPath(paths.get(t.file_id));
    return isAuto ? (!auto && !t.pending) : auto;
  }).sort((a, b) => cmpStr(a.date, b.date) || a.id - b.id);
  for (const r of rows) {
    const k = crossKey(r.source, r.account, r.amount);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  return idx;
}

function refDigits(ref) {
  const d = String(ref || '').replace(RE_NOT_DIGIT, '').replace(/^0+/, '');
  return cpLen(d) >= 3 ? d : null;
}

const isTransfer = (key) => pySplit(key).some((w) => TRANSFER_WORDS.has(w) || TRANSFER_PREFIXES.some((p) => w.startsWith(p)));

function twinScore(t, key, r) { // null when not the same transaction; higher is surer
  const ra = refDigits(t.reference);
  const rb = refDigits(r.reference);
  if (ra && rb) return (ra.endsWith(rb) || rb.endsWith(ra)) ? 3 : null;
  const rkey = r.merchant_key || '';
  if (isTransfer(key) || isTransfer(rkey)) {
    const same = key === rkey && (t.description || '').replace(RE_NOT_DIGIT, '') === (r.description || '').replace(RE_NOT_DIGIT, '');
    return same ? 2 : null;
  }
  if (key === rkey) return 2;
  return sameMerchant(key, rkey) ? 1 : null;
}

function crossAssign(txns, idx, taken) {
  const out = new Map();
  if (!idx.size) return out;
  const claimed = new Set(taken);
  for (const maxGap of [0, 1]) {
    for (const t of txns) {
      if (out.has(t)) continue;
      const cands = idx.get(crossKey(t.source, t.account, t.amount));
      if (!cands) continue;
      const key = merchantKey(t.description);
      const day = dnum(t.date);
      let best = null;
      for (const r of cands) {
        if (claimed.has(r.id) || Math.abs(dnum(r.date) - day) > maxGap) continue;
        const score = twinScore(t, key, r);
        if (score !== null && (best === null || score > best[0])) best = [score, r.id];
      }
      if (best) {
        claimed.add(best[1]);
        out.set(t, best[1]);
      }
    }
  }
  return out;
}

export function ingest(state, parsedFiles, today, opts = {}) {
  ensureState(state);
  today = isoDay(today);
  const now = opts.now || `${today}T00:00:00`;
  const report = { files: [], new_cards: [], reconcile: {} };
  const meta = state.meta;
  const alias = meta.uid_alias;
  const cardsBefore = new Set(Object.keys(state.cards));
  const uids = new Set(state.transactions.map((t) => t.uid));
  for (const u of Object.keys(alias)) uids.add(u);
  const soft = new Map();
  for (const t of state.transactions) if (t.soft_key !== null && t.soft_key !== undefined) soft.set(t.soft_key, t.id);
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  let seq = Math.max(meta.seq.transactions || 0, maxId(state.transactions));
  const result = (pf, status, extra = {}) => ({ name: pf.name, kind: pf.kind ?? null, status, added: 0, dup: 0,
    updated: 0, message: '', ...extra });

  for (const pf of parsedFiles || []) {
    if (pf.error) { report.files.push(result(pf, 'error', { message: String(pf.error) })); continue; }
    if (!pf.kind) { report.files.push(result(pf, 'ignored', { kind: null })); continue; }
    const txns = (pf.txns || []).map(normTxn);
    if (txns.some((t) => !t.uid)) {
      report.files.push(result(pf, 'error', { message: 'חסר מזהה (uid) לתנועות בקובץ' }));
      continue;
    }
    const isAuto = isAutoPath(pf.path);
    // an automatic batch is always processed: its not-yet-final rows replace the previous sync's
    if (!isAuto && pf.sha256 !== null && pf.sha256 !== undefined && meta.files.some((f) => f.sha256 === pf.sha256)) {
      report.files.push(result(pf, 'duplicate', { message: 'הקובץ כבר יובא' }));
      continue;
    }
    const warn = uniqJoin(pf.warnings);
    const fileId = nextId(state, 'files');
    const frec = { id: fileId, sha256: isAuto ? `${pf.sha256}@${now}#${fileId}` : (pf.sha256 ?? null), name: pf.name,
      path: pf.path ?? null, kind: pf.kind, imported_at: now, rows_total: txns.length, rows_added: 0, rows_dup: 0,
      rows_updated: 0, date_from: strMin(txns.map((t) => t.date)), date_to: strMax(txns.map((t) => t.date)),
      status: 'imported', message: cpSlice(warn, 500) };
    meta.files.push(frec);
    const res = result(pf, 'imported', { message: cpSlice(warn, 300) });
    let gone = new Set();
    if (isAuto) { // last sync's not-yet-final rows: this batch has them fresh
      gone = dropPending(state, pf.path, soft);
      for (const u of gone) uids.delete(u);
      for (const id of [...byId.keys()]) if (gone.has(byId.get(id).uid)) byId.delete(id);
    }
    // rows already here by their exact identity are taken: a second identical coffee must not pair with them
    const known = new Set(txns.filter((t) => uids.has(t.uid)).map((t) => t.uid));
    const taken = new Set();
    for (const t of state.transactions) if (known.has(t.uid)) taken.add(t.id);
    for (const [u, tid] of Object.entries(alias)) if (known.has(u)) taken.add(tid);
    const fresh = [];
    for (const t of txns) {
      if (uids.has(t.uid)) continue;
      if (!t.pending && t.soft_key && soft.has(t.soft_key)) {
        if (soft.get(t.soft_key) !== -1) taken.add(soft.get(t.soft_key));
        continue;
      }
      fresh.push(t);
    }
    const idx = crossIndex(state, fresh, isAuto);
    const pendingIds = new Set();
    for (const rows of idx.values()) for (const r of rows) if (r.pending) pendingIds.add(r.id);
    const twins = crossAssign(fresh, idx, taken);
    for (const t of txns) {
      if (uids.has(t.uid)) { res.dup++; continue; }
      if (!t.pending && t.soft_key && soft.has(t.soft_key) && soft.get(t.soft_key) !== -1) {
        const row = byId.get(soft.get(t.soft_key)); // the same purchase, final now (billing date/amount changed)
        if (row) {
          Object.assign(row, { uid: t.uid, amount: t.amount, charge_date: t.charge_date, notes: t.notes,
            txn_type: t.txn_type, file_id: fileId });
          uids.add(t.uid);
          res.updated++;
          continue;
        }
      }
      let twin = twins.has(t) ? twins.get(t) : null;
      if (twin !== null && pendingIds.has(twin)) { // a final row supersedes the automatic not-yet-final copy
        deleteRows(state, [twin]);
        byId.delete(twin);
        twin = null;
      }
      if (twin !== null) { // already here from the other source
        if (!t.pending) {
          if (!hasOwn(alias, t.uid)) alias[t.uid] = twin;
          uids.add(t.uid);
        }
        res.dup++;
        continue;
      }
      const row = {
        id: ++seq, uid: t.uid, soft_key: t.pending ? null : t.soft_key, source: t.source, account: t.account,
        date: t.date, charge_date: t.charge_date, description: t.description, merchant_key: merchantKey(t.description),
        amount: t.amount, orig_amount: t.orig_amount, orig_currency: t.orig_currency, reference: t.reference,
        balance: t.balance, day_seq: t.day_seq, txn_type: t.txn_type, notes: t.notes, ext_category: t.ext_category,
        category: null, category_source: null, category_locked: 0, is_settlement: 0, neutralized: 0,
        settlement_issuer: null, recon_note: null, installment_no: t.installment_no,
        installment_total: t.installment_total, file_id: fileId, created_at: now, pending: t.pending ? 1 : 0,
        eff_date: null, flow: null,
      };
      state.transactions.push(row);
      byId.set(row.id, row);
      uids.add(t.uid);
      if (t.soft_key && !t.pending) soft.set(t.soft_key, -1);
      if (t.pending && gone.has(t.uid)) res.dup++; // the same not-yet-final row as last time
      else res.added++;
    }
    if (isAuto && !res.updated && !state.transactions.some((t) => t.file_id === fileId)) {
      meta.files = meta.files.filter((f) => f.id !== fileId); // nothing came from it: no clutter
      if (!res.added) { res.status = 'duplicate'; res.message = 'אין תנועות חדשות'; }
    } else {
      Object.assign(frec, { rows_added: res.added, rows_dup: res.dup, rows_updated: res.updated });
    }
    const cards = [...new Set(txns.filter((t) => t.source === 'max' && t.account).map((t) => t.account))].sort(cmpStr);
    for (const card of cards) {
      const dates = txns.filter((t) => t.account === card).map((t) => t.date);
      const lo = strMin(dates);
      const hi = strMax(dates);
      const c = hasOwn(state.cards, card) ? state.cards[card] : null;
      if (!c) {
        state.cards[card] = { card, owner: null, nickname: null, issuer: 'max', first_seen: lo, last_seen: hi };
      } else {
        c.first_seen = strMin([c.first_seen ?? lo, lo]);
        c.last_seen = strMax([c.last_seen ?? hi, hi]);
      }
    }
    report.files.push(res);
  }
  meta.seq.transactions = seq;
  report.new_cards = Object.keys(state.cards).filter((c) => !cardsBefore.has(c)).sort(cmpStr);
  report.reconcile = postProcess(state, today);
  return report;
}

// ====================================================================== reconcile.py
function detectIssuer(description, issuerKeywords) {
  const key = ` ${merchantKey(description)} `;
  const ordered = Object.keys(issuerKeywords).filter((k) => k !== 'generic');
  if (hasOwn(issuerKeywords, 'generic')) ordered.push('generic');
  for (const issuer of ordered) {
    for (const kw of issuerKeywords[issuer] || []) {
      const k = merchantKey(kw);
      if (k && (cpLen(k) <= 3 ? key.includes(` ${k} `) : key.includes(k))) return issuer;
    }
  }
  return null;
}

function groupRows(rows, keyFn) { // SQL GROUP BY: groups in key order, rows in scan order
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const ks = JSON.stringify(k);
    let g = map.get(ks);
    if (!g) { g = { key: k, rows: [] }; map.set(ks, g); }
    g.rows.push(r);
  }
  return [...map.values()].sort((a, b) => keyCmp(a.key, b.key));
}

/** Neutralizes the bank's monthly card charge when the MAX file lists the purchases behind it. */
function reconcile(state, issuerKeywords, tolerance = 5.0) {
  const stats = { settlements: 0, neutralized: 0, exact: 0, kept: 0 };
  const perDate = new Map(); // billing date -> card -> money out
  const cardMonths = new Set();
  const maxRows = state.transactions.filter((t) => t.source === 'max' && !t.pending);
  for (const g of groupRows(maxRows, (t) => [t.charge_date, t.account])) {
    const [cd, acc] = g.key;
    if (!perDate.has(cd)) perDate.set(cd, new Map());
    const m = perDate.get(cd);
    m.set(acc, (m.get(acc) ?? 0) + -sqlSum(g.rows.map((t) => t.amount)));
    cardMonths.add(cd.slice(0, 7));
  }
  const updates = [];
  for (const r of state.transactions.filter((t) => t.source === 'leumi' && t.amount < 0)) {
    const issuer = detectIssuer(r.description, issuerKeywords);
    if (!issuer) {
      if (r.is_settlement) updates.push([0, 0, null, null, null, r.category_locked, r]); // keywords changed: release
      continue;
    }
    if (r.pending) {
      // today's card charge, not final yet: the purchases behind it already count from MAX
      const detailed = (DETAILED_ISSUERS.has(issuer) || issuer === 'generic') && cardMonths.size > 0;
      const note = detailed ? 'חיוב אשראי בקליטה: לא נספר, הקניות שלו כבר נספרות מ-MAX'
        : `חיוב ${ISSUER_LABEL[issuer] ?? issuer} בקליטה: אין פירוט, נספר כהוצאה`;
      updates.push([1, detailed ? 1 : 0, issuer, note, detailed ? SETTLEMENT_CATEGORY : UNDETAILED_CARD_CATEGORY,
        r.category_locked, r]);
      continue;
    }
    stats.settlements++;
    const debit = -r.amount;
    const bankDay = dnum(r.date);
    let neutral = 0;
    let note = '';
    if (DETAILED_ISSUERS.has(issuer) || issuer === 'generic') {
      const tol = Math.max(tolerance, 0.01 * debit);
      let best = null; // [diff, charge_date, label, total]
      let anyWindow = null;
      for (let off = -3; off < 6; off++) {
        const cd = diso(bankDay + off);
        const cards = perDate.get(cd);
        if (!cards || !cards.size) continue;
        const total = pySum([...cards.values()]);
        const cand = [[Math.abs(debit - total), cd, 'כל הכרטיסים', total]];
        for (const [c, v] of cards) cand.push([Math.abs(debit - v), cd, `כרטיס ${pyIntStr(c)}`, v]);
        for (const c of cand) if (best === null || c[0] < best[0]) best = c;
        if (anyWindow === null || Math.abs(off) < Math.abs(anyWindow[0])) anyWindow = [off, cd, total];
      }
      // a charge the card files explain: the purchases behind it are counted, not the charge. A charge they do
      // not explain (a card whose statement was not imported, or a charge abroad of next month's statement:
      // the Leumi cards are charged for every one on its own day) is counted as a card expense with no details.
      if (best && best[0] <= tol) {
        neutral = 1;
        stats.exact++;
        note = `הותאם לחיוב MAX מ-${best[1]} (${best[2]}, ₪${pyFixed(best[3], 2, true)})`;
        if (best[0] >= 0.01) note += `, הפרש ₪${pyFixed(best[0], 2, true)}`;
      } else if (anyWindow && debit >= 0.5 * anyWindow[2] && debit <= 1.5 * anyWindow[2]) {
        neutral = 1;
        note = `נוטרל: חיובי MAX ב-${anyWindow[1]} בסך ₪${pyFixed(anyWindow[2], 2, true)} `
          + `(הפרש ₪${pyFixed(Math.abs(debit - anyWindow[2]), 2, true)})`;
      } else {
        note = cardMonths.has(r.date.slice(0, 7)) ? 'אין לחיוב הזה פירוט בקבצי האשראי שיובאו, ולכן הוא נספר כהוצאה'
          : 'לא נמצא פירוט MAX תואם, החיוב נספר כהוצאה';
      }
    } else {
      note = `חיוב ${ISSUER_LABEL[issuer] ?? issuer}: אין קובץ פירוט, נספר כהוצאה`;
    }
    if (neutral) stats.neutralized++;
    else stats.kept++;
    updates.push([1, neutral, issuer, note, neutral ? SETTLEMENT_CATEGORY : UNDETAILED_CARD_CATEGORY,
      r.category_locked, r]);
  }
  for (const [isS, neutral, issuer, note, cat, locked, r] of updates) {
    if (isS) {
      Object.assign(r, { is_settlement: 1, neutralized: neutral, settlement_issuer: issuer, recon_note: note });
      if (!locked) Object.assign(r, { category: cat, category_source: 'reconcile' });
    } else {
      if (!r.category_locked) Object.assign(r, { category: null, category_source: null });
      Object.assign(r, { is_settlement: 0, neutralized: 0, settlement_issuer: null, recon_note: null });
    }
  }
  return stats;
}

// ====================================================================== what one line cannot tell
const SALARY_MIN = 2000;      // a payer that pays at least this, in three different months, pays a salary
const MOVED_MIN = 2000;       // money taken out of savings and sent on within a week: savings moving, not spending
/** Rules that look at more than one line. A payer the rules do not know that pays the account a large sum
    every month is a salary ("עיריית ראשל"צ", an employer). Money taken out of a savings fund and transferred on
    within days (to another fund or a broker) is savings moving, not income and spending. A line the person
    categorized is never touched; a line these rules changed goes back when the reason is gone. */
function contextRules(state) {
  const cz = makeCategorizer(state);
  const kinds = catKinds(state);
  const bank = state.transactions.filter((t) => t.source === 'leumi' && !t.category_locked && !t.is_settlement);
  for (const t of bank) {
    if (t.category_source === 'salary' || t.category_source === 'moved') {
      [t.category, t.category_source] = categorizeOne(cz, t.description, t.amount, t.source, t.ext_category);
    }
  }
  if (kinds.has('משכורת')) {
    // a salary is about the same every month: a payer's sums far from its usual one are something else
    const byPayer = new Map();
    for (const t of bank.filter((x) => x.amount >= SALARY_MIN && x.category_source === 'fallback')) {
      const k = merchantKey(t.description);
      if (!byPayer.has(k)) byPayer.set(k, []);
      byPayer.get(k).push(t);
    }
    for (const rows of byPayer.values()) {
      const amounts = rows.map((t) => t.amount).sort((a, b) => a - b);
      const mid = amounts[amounts.length >> 1];
      const usual = rows.filter((t) => t.amount >= 0.5 * mid && t.amount <= 2 * mid);
      if (new Set(usual.map((t) => t.date.slice(0, 7))).size < 3) continue;
      for (const t of usual) Object.assign(t, { category: 'משכורת', category_source: 'salary' });
    }
  }
  const savingCat = state.categories.find((c) => c.kind === 'saving');
  if (savingCat) {
    const outs = bank.filter((t) => t.amount <= -MOVED_MIN && kinds.get(t.category) === 'expense'
      && t.category === 'העברות ותשלומים').sort((a, b) => cmpStr(a.date, b.date) || a.id - b.id);
    const used = new Set();
    for (const w of bank.filter((t) => t.amount >= MOVED_MIN && kinds.get(t.category) === 'saving')
      .sort((a, b) => cmpStr(a.date, b.date) || a.id - b.id)) {
      const day = dnum(w.date);
      const hit = outs.find((o) => !used.has(o.id) && dnum(o.date) >= day && dnum(o.date) - day <= 7
        && -o.amount >= 0.8 * w.amount && -o.amount <= 1.005 * w.amount);
      if (hit) {
        used.add(hit.id);
        Object.assign(hit, { category: savingCat.name, category_source: 'moved' });
      }
    }
  }
}

// ====================================================================== cashflow.py: salary months, fixed/variable
function catKinds(state) {
  return new Map(state.categories.map((c) => [c.name, c.kind]));
}
const kindJoin = (kinds, t) => (t.category !== null && t.category !== undefined && kinds.has(t.category)
  ? kinds.get(t.category) : null);

/**
 * Salary paid at the end of a month funds the next one: a regular income from a payer that pays around the
 * month boundary (>= 30% on the 1st-5th), received on the 25th or later, counts in the next month unless that
 * month has its own payment; a regular payment on the 1st-5th whose previous month got none while this month
 * has two counts in the previous month. Stored in eff_date.
 */
function salaryMonths(state, kinds) {
  for (const t of state.transactions) if (t.eff_date !== null && t.eff_date !== undefined) t.eff_date = null;
  const rows = state.transactions.filter((t) => t.source === 'leumi' && t.amount > 0 && !t.neutralized && !t.pending
    && (kindJoin(kinds, t) ?? 'income') === 'income');
  const byPayer = new Map();
  for (const r of rows) {
    if (!r.merchant_key) continue;
    if (!byPayer.has(r.merchant_key)) byPayer.set(r.merchant_key, []);
    byPayer.get(r.merchant_key).push(r);
  }
  const updates = [];
  for (const rs of byPayer.values()) {
    const events = []; // one payment may come in parts a day or two apart: they move together
    for (const r of [...rs].sort((a, b) => cmpStr(a.date, b.date))) {
      const last = events[events.length - 1];
      if (last && dnum(r.date) - dnum(last[last.length - 1].date) <= 3) last.push(r);
      else events.push([r]);
    }
    const months = new Map();
    for (const ev of events) {
      const m = ev[0].date.slice(0, 7);
      months.set(m, (months.get(m) ?? 0) + 1);
    }
    const amounts = events.map((ev) => pySum(ev.map((r) => r.amount)));
    if (months.size < 3) continue;
    const med = median(amounts);
    if (amounts.filter((a) => Math.abs(a - med) <= 0.3 * med).length < 0.7 * amounts.length) continue;
    const day = (ev) => +ev[0].date.slice(8, 10);
    const boundary = events.filter((ev) => day(ev) <= 5).length / events.length >= 0.3;
    if (boundary) {
      for (let i = events.length - 1; i >= 0; i--) { // latest first: chains shift together
        const ev = events[i];
        const m = ev[0].date.slice(0, 7);
        const to = nextMonth(m);
        if (day(ev) < SHIFT_FROM_DAY || months.get(to)) continue;
        months.set(m, months.get(m) - 1);
        months.set(to, 1);
        for (const r of ev) updates.push([`${to}-01`, r]);
      }
    } else {
      for (const ev of events) {
        const m = ev[0].date.slice(0, 7);
        const frm = prevMonth(m);
        if (day(ev) > 5 || (months.get(m) ?? 0) < 2 || months.get(frm)) continue;
        months.set(m, months.get(m) - 1);
        months.set(frm, 1);
        for (const r of ev) updates.push([monthEnd(frm), r]);
      }
    }
  }
  for (const [d, r] of updates) r.eff_date = d;
  return updates.length;
}

function isRegular(months, span0) {
  const win = new Set(span0);
  const seen = [...months.keys()].filter((m) => win.has(m)).sort();
  if (seen.length < 3) return false;
  const span = span0.filter((m) => m >= seen[0]).length;
  const sums = seen.map((m) => months.get(m)[0]);
  const med = median(sums);
  const steady = sums.filter((v) => Math.abs(v - med) <= 0.3 * Math.abs(med)).length;
  const counts = seen.map((m) => months.get(m)[1]);
  const perMonth = median(counts);
  const steadyCount = counts.filter((n) => n === perMonth).length >= 0.7 * counts.length;
  return seen.length / span >= 0.7 && steady >= 0.7 * seen.length && perMonth <= 4 && steadyCount && med > 0;
}

/**
 * Fixed vs variable expenses (flow). Fixed: installments, and anything charged regularly: in >= 70% of the
 * complete months since it first appeared (3 or more), with a steady monthly total and the same small number
 * of charges (up to 4) most months.
 */
function flows(state, kinds, today) {
  const rows = state.transactions.filter((t) => t.amount < 0 && !t.neutralized && !t.is_settlement
    && (kindJoin(kinds, t) ?? 'expense') === 'expense');
  if (!rows.length) return 0;
  const current = today.slice(0, 7);
  const series = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.source, r.merchant_key]);
    if (!series.has(k)) series.set(k, new Map());
    const s = series.get(k);
    const m = r.charge_date.slice(0, 7);
    if (!s.has(m)) s.set(m, [0, 0]);
    const cell = s.get(m);
    cell[0] += -r.amount;
    cell[1] += 1;
  }
  const first = strMin(rows.map((r) => r.charge_date.slice(0, 7)));
  const complete = monthsRange(first, prevMonth(current));
  const recent = complete.slice(-6);
  const fixed = new Set();
  for (const [k, months] of series) if (isRegular(months, complete) || isRegular(months, recent)) fixed.add(k);
  for (const r of rows) {
    r.flow = ((r.installment_total || 0) > 1 || fixed.has(JSON.stringify([r.source, r.merchant_key]))) ? 'fixed' : 'variable';
  }
  return fixed.size;
}

function cashflowRefresh(state, today) {
  const kinds = catKinds(state);
  return { salary_shifted: salaryMonths(state, kinds), fixed_series: flows(state, kinds, today) };
}

/** After every import: categorize, neutralize card charges, categorize again, salary months and fixed/variable. */
export function postProcess(state, today) {
  ensureState(state);
  today = isoDay(today);
  const S = settingsOf(state);
  const cz = makeCategorizer(state);
  categorizeRows(state, true, cz);
  const stats = reconcile(state, S.issuer_keywords || {}, Number(S.settlement_tolerance ?? 5.0));
  categorizeRows(state, true, cz);
  contextRules(state);
  try {
    cashflowRefresh(state, today);
    state.meta.cashflow_version = CASHFLOW_VERSION;
  } catch (e) {
    stats.cashflow_error = String(e && e.message ? e.message : e);
  }
  return stats;
}

// ====================================================================== owners, cards, categories, rules
export function addOwner(state, name, color = null) {
  ensureState(state);
  name = pyStrip(String(name ?? ''));
  if (!name || state.owners.some((o) => o.name === name)) return;
  const n = state.owners.length;
  state.owners.push({ name, color: color || OWNER_COLORS[n % OWNER_COLORS.length], sort: n });
}

export function setCardOwner(state, card, owner, nickname = null) {
  ensureState(state);
  if (owner) addOwner(state, owner);
  if (hasOwn(state.cards, card)) {
    const c = state.cards[card];
    c.owner = owner || null;
    if (nickname !== null && nickname !== undefined) c.nickname = nickname;
  }
}

export function listCards(state) {
  ensureState(state);
  const counts = new Map();
  for (const t of state.transactions) if (t.source === 'max') counts.set(t.account, (counts.get(t.account) ?? 0) + 1);
  return Object.keys(state.cards).sort(cmpStr).map((card) => {
    const c = state.cards[card];
    return { card, source: c.issuer || 'max', owner: c.owner || null, nickname: c.nickname ?? null,
      count: counts.get(card) ?? 0, first_seen: c.first_seen ?? null, last_seen: c.last_seen ?? null };
  });
}

export function listCategories(state, kind = null) {
  ensureState(state);
  return state.categories.filter((c) => !kind || c.kind === kind)
    .sort((a, b) => sqlCmp(a.sort, b.sort) || cmpStr(a.name, b.name))
    .map((c) => ({ name: c.name, kind: c.kind, color: c.color }));
}

export function addRule(state, pattern, category, opts = {}) {
  ensureState(state);
  state.rules = state.rules.filter((r) => !(r.pattern === pattern && ['user', 'learned', 'ai'].includes(r.origin)));
  state.rules.push({ id: nextId(state, 'rules'), pattern, category, direction: opts.direction ?? 'any',
    source: opts.source ?? 'any', priority: opts.priority ?? 50, is_regex: opts.is_regex ? 1 : 0,
    origin: opts.origin ?? 'user', created_at: opts.now ?? null });
}

/**
 * Manual category change (ids are numbers, uids are strings). With learn=true the merchant is remembered and
 * all its other (unlocked) transactions are re-labelled. Returns the number of rows changed, like Python.
 */
export function setCategory(state, ids, category, learn = false, opts = {}) {
  ensureState(state);
  if (!ids || !ids.length) return 0;
  const byUid = new Map(state.transactions.map((t) => [t.uid, t.id]));
  const want = new Set();
  for (const x of ids) {
    if (typeof x === 'string') {
      const id = byUid.has(x) ? byUid.get(x) : state.meta.uid_alias[x];
      if (id !== undefined && id !== null) want.add(id);
    } else {
      want.add(Number(x));
    }
  }
  const rows = state.transactions.filter((t) => want.has(t.id));
  for (const t of rows) Object.assign(t, { category, category_source: 'manual', category_locked: 1 });
  let changed = ids.length;
  if (learn) {
    const keys = [];
    for (const t of rows) if (t.merchant_key && !keys.includes(t.merchant_key)) keys.push(t.merchant_key);
    for (const key of keys) {
      addRule(state, key, category, { origin: 'learned', now: opts.now });
      for (const t of state.transactions) {
        if (t.merchant_key === key && !t.category_locked && !t.is_settlement) {
          Object.assign(t, { category, category_source: 'learned' });
          changed++;
        }
      }
    }
  }
  return changed;
}

/** Recurring-charge note (planner.set_note): promo_end/promo_price/note/muted; an omitted field is kept. */
export function setRecurringNote(state, key, note = {}) {
  ensureState(state);
  if (typeof note === 'string') note = { note };
  const row = hasOwn(state.recurring_notes, key) ? { ...state.recurring_notes[key] }
    : { key, promo_end: null, promo_price: null, note: '', muted: 0 };
  const given = (v) => v !== undefined && v !== null;
  if (given(note.promo_end)) row.promo_end = note.promo_end || null;
  if (given(note.promo_price)) row.promo_price = note.promo_price || null;
  if (given(note.note)) row.note = note.note;
  if (given(note.muted)) row.muted = note.muted ? 1 : 0;
  state.recurring_notes[key] = row;
  return { ...row };
}

// ====================================================================== analytics.py
/** Rows joined with their category and card (BASE_FROM), plus the KIND/owner expressions. */
function makeCtx(state) {
  const S = settingsOf(state);
  const bankOwner = S.bank_owner ?? 'משותף';
  const basis = S.card_month_basis ?? 'charge';
  const cats = new Map(state.categories.map((c) => [c.name, c]));
  const rows = [...state.transactions].sort((a, b) => a.id - b.id).map((t) => {
    const c = t.category !== null && t.category !== undefined ? cats.get(t.category) : undefined;
    const k = t.source === 'max' && hasOwn(state.cards, t.account) ? state.cards[t.account] : null;
    const eff = t.eff_date ?? null;
    return { ...t,
      kind: c ? c.kind : (t.amount < 0 ? 'expense' : 'income'),
      ckind: c ? c.kind : null, // c.kind: what `GROUP BY ... kind` really groups by in SQLite
      owner: t.source === 'max' ? ((k && k.owner) || UNASSIGNED) : bankOwner,
      ccolor: c ? c.color : null,
      kowner: k ? k.owner : null,
      mc: (eff ?? t.charge_date).slice(0, 7),
      mt: (eff ?? ((t.installment_total ?? 0) > 1 ? t.charge_date : t.date)).slice(0, 7) };
  });
  return { state, S, bankOwner, basis, rows };
}

/** The month a row counts in: billing month (cash flow) or purchase month; eff_date overrides. */
const em = (v, basis) => (basis === 'transaction' ? v.mt : v.mc);

// SQLite resolves `GROUP BY ... kind` to the column c.kind (not to the KIND alias) and `GROUP BY flow` to t.flow;
// a bare result column is taken from the group's first row, or from its last row when MAX() saw only NULLs.
const firstKind = (g) => g.rows[0].kind;

function monthlySummaries(cx, basis, owner = null) {
  const rows = cx.rows.filter((v) => !v.neutralized && (!owner || v.owner === owner));
  const out = new Map();
  for (const g of groupRows(rows, (v) => [em(v, basis), v.ckind])) {
    const m = g.key[0];
    const kind = firstKind(g);
    const s = sqlSum(g.rows.map((v) => v.amount));
    if (!out.has(m)) out.set(m, { month: m, income: 0, expense: 0, saving: 0, count: 0 });
    const ms = out.get(m);
    if (kind === 'income') ms.income += s;
    else if (kind === 'expense') ms.expense += -s;
    else if (kind === 'saving') ms.saving += -s;
    else continue;
    ms.count += g.rows.length;
  }
  return [...out.keys()].sort(cmpStr).map((k) => out.get(k));
}

function categoryTotals(cx, basis, month, owner = null, kinds = ['expense']) {
  const rows = cx.rows.filter((v) => !v.neutralized && em(v, basis) === month && (!owner || v.owner === owner));
  const out = [];
  for (const g of groupRows(rows, (v) => [v.category, v.ckind])) {
    const cat = g.key[0];
    const kind = g.key[1] === null ? g.rows[g.rows.length - 1].kind : firstKind(g); // MAX(c.color) is NULL there
    if (!kinds.includes(kind)) continue;
    const s = sqlSum(g.rows.map((v) => v.amount));
    const color = strMax(g.rows.map((v) => v.ccolor).filter((c) => c !== null && c !== undefined));
    out.push({ category: cat || 'ללא קטגוריה', kind, color: color || '#94a3b8',
      total: pyRound(kind === 'income' ? s : -s, 2), count: g.rows.length });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

function endOfDay(rows) { // the row nobody 'continues' from
  if (rows.length === 1) return rows[0].balance;
  const tails = rows.filter((t) => !rows.some((u) => u !== t && Math.abs((u.balance - u.amount) - t.balance) < 0.005));
  if (tails.length === 1) return tails[0].balance;
  let best = rows[0];
  for (const r of rows) if (sqlCmp(r.day_seq, best.day_seq) > 0 || (sqlCmp(r.day_seq, best.day_seq) === 0 && r.id > best.id)) best = r;
  return best.balance;
}

function balanceSeries(state, since = null) {
  const rows = state.transactions.filter((t) => t.source === 'leumi' && t.balance !== null && t.balance !== undefined
    && (!since || t.date >= since)).sort((a, b) => cmpStr(a.date, b.date) || sqlCmp(a.day_seq, b.day_seq) || a.id - b.id);
  const out = [];
  let day = null;
  let bucket = [];
  for (const r of rows) {
    if (r.date !== day && bucket.length) {
      out.push([day, pyRound(endOfDay(bucket), 2)]);
      bucket = [];
    }
    day = r.date;
    bucket.push(r);
  }
  if (bucket.length) out.push([day, pyRound(endOfDay(bucket), 2)]);
  return out;
}

function latestBalance(state) {
  const dates = state.transactions.filter((t) => t.source === 'leumi' && t.balance !== null && t.balance !== undefined)
    .map((t) => t.date);
  const last = strMax(dates);
  if (!last) return [null, null];
  const s = balanceSeries(state, last);
  return s.length ? s[s.length - 1] : [null, null];
}

function signedByCategory(cx, basis, month) {
  const out = new Map();
  const rows = cx.rows.filter((v) => !v.neutralized && em(v, basis) === month);
  for (const g of groupRows(rows, (v) => [v.category, v.ckind])) {
    out.set(g.key[0] || 'ללא קטגוריה', [firstKind(g), sqlSum(g.rows.map((v) => v.amount))]);
  }
  return out;
}

/**
 * Per category: forecast = the larger of actual-so-far and the 3-month average for income, the smaller for
 * expenses/savings (the actual for a complete month). Known future card charges in the month count as actual.
 */
function forecast(cx, basis, month, today, withBalance = true) {
  const cur = signedByCategory(cx, basis, month);
  const prev = [1, 2, 3].map((i) => signedByCategory(cx, basis, shiftMonth(month, -i))).filter((p) => p.size);
  const nprev = prev.length || 1;
  const all = new Set(cur.keys());
  for (const p of prev) for (const c of p.keys()) all.add(c);
  // Python walks a set here (its order changes from run to run); a sorted walk keeps ties stable
  const cats = [...all].sort(cmpStr);
  const complete = month < today.slice(0, 7);
  const tot = { income: [0, 0, 0], expense: [0, 0, 0], saving: [0, 0, 0] };
  const rows = [];
  for (const cat of cats) {
    const kind = (cur.get(cat) || prev.find((p) => p.has(cat)).get(cat))[0];
    if (!hasOwn(tot, kind)) continue;
    const a = cur.has(cat) ? cur.get(cat)[1] : 0.0;
    const avg = pySum(prev.map((p) => (p.has(cat) ? p.get(cat)[1] : 0.0))) / nprev;
    const f = complete ? a : kind === 'income' ? pyMax(a, avg) : pyMin(a, avg);
    const sign = kind === 'income' ? 1 : -1;
    tot[kind][0] += sign * a;
    tot[kind][1] += sign * avg;
    tot[kind][2] += sign * f;
    rows.push({ category: cat, kind, actual: pyRound(sign * a, 2), avg: pyRound(sign * avg, 2),
      forecast: pyRound(sign * f, 2) });
  }
  rows.sort((x, y) => ((x.kind !== 'income') - (y.kind !== 'income')) || (y.forecast - x.forecast));
  const res = {
    month, complete, rows,
    income_actual: pyRound(tot.income[0], 2), income_forecast: pyRound(tot.income[2], 2),
    expense_actual: pyRound(tot.expense[0], 2), expense_forecast: pyRound(tot.expense[2], 2),
    saving_actual: pyRound(tot.saving[0], 2), saving_forecast: pyRound(tot.saving[2], 2),
    income_avg: pyRound(tot.income[1], 2), expense_avg: pyRound(tot.expense[1], 2),
  };
  res.net_actual = pyRound(res.income_actual - res.expense_actual - res.saving_actual, 2);
  res.net_forecast = pyRound(res.income_forecast - res.expense_forecast - res.saving_forecast, 2);
  res.end_balance = null;
  if (withBalance && !complete) {
    const [balDate, bal] = latestBalance(cx.state);
    if (bal !== null) {
      const fc = basis === 'charge' ? res : forecast(cx, 'charge', month, today, false);
      const reflected = sqlSum(cx.rows.filter((v) => !v.neutralized && v.kind !== 'internal'
        && v.charge_date.slice(0, 7) === month && v.charge_date <= balDate).map((v) => v.amount)) ?? 0.0;
      res.end_balance = pyRound(bal + (fc.net_forecast - reflected), 2);
      res.balance_date = balDate;
      res.balance = bal;
    }
  }
  return res;
}

function loanMath(principal, annualRate, months, first, today, monthlyOverride) {
  months = Math.max(Math.trunc(Number(months) || 1), 1);
  const r = (annualRate || 0.0) / 100.0 / 12.0;
  const pmt = monthlyOverride ? monthlyOverride : r > 0 ? principal * r / (1 - (1 + r) ** -months) : principal / months;
  let k = 0;
  for (let i = 0; i < months; i++) if (addMonths(first, i) <= today) k++;
  let remaining = r > 0 ? principal * (1 + r) ** k - pmt * ((1 + r) ** k - 1) / r : principal - pmt * k;
  remaining = Math.max(0.0, remaining);
  return { monthly: pyRound(pmt, 2), paid_count: k, total_count: months, remaining: pyRound(remaining, 2),
    progress: k / months, end_date: addMonths(first, months - 1), next_date: k < months ? addMonths(first, k) : null,
    total_interest: pyRound(pmt * months - principal, 2) };
}

function loansStatus(state, today) {
  const out = [];
  for (const ln of [...state.loans].filter((l) => (l.active ?? 1) === 1 || l.active === true).sort((a, b) => a.id - b.id)) {
    const first = /^\d{4}-\d{2}-\d{2}$/.test(String(ln.first_payment ?? '')) ? ln.first_payment : today;
    const m = loanMath(ln.principal || 0.0, ln.annual_rate || 0.0, ln.months || 1, first, today, ln.monthly_override);
    let det = { count: 0, last: null, total: 0.0 };
    const key = merchantKey(ln.keyword || '');
    if (key) {
      const rs = state.transactions.filter((t) => t.amount < 0 && !t.neutralized && (t.merchant_key || '').includes(key));
      det = { count: rs.length, last: strMax(rs.map((t) => t.date)), total: pyRound(-(sqlSum(rs.map((t) => t.amount)) || 0.0), 2) };
    }
    out.push({ id: ln.id, name: ln.name, keyword: ln.keyword, principal: ln.principal, annual_rate: ln.annual_rate,
      months: ln.months, first_payment: ln.first_payment, notes: ln.notes, ...m, detected: det });
  }
  return out;
}

// ====================================================================== cashflow.flow_summary
/**
 * Fixed and variable spending this month, the fixed charges still expected, and what is left to spend on
 * variable expenses (per category: the 3-month average minus what was already spent, never below zero).
 */
function flowSummary(cx, basis, month, today) {
  const exp = cx.rows.filter((v) => !v.neutralized && v.kind === 'expense');
  // grouped by the raw t.flow: a refund (flow NULL) is its own group, and the dict keeps the later group
  const cur = new Map();
  for (const g of groupRows(exp.filter((v) => em(v, basis) === month), (v) => [v.flow ?? null, v.category])) {
    const flow = g.key[0] ?? 'variable';
    cur.set(JSON.stringify([flow, g.key[1]]), { flow, cat: g.key[1], s: sqlSum(g.rows.map((v) => -v.amount)) || 0.0 });
  }
  const curVals = [...cur.values()];
  const fixedNow = pySum(curVals.filter((x) => x.flow === 'fixed').map((x) => x.s));
  const varNow = pySum(curVals.filter((x) => x.flow === 'variable').map((x) => x.s));

  const months = [prevMonth(month)];
  for (let i = 0; i < 2; i++) months.push(prevMonth(months[months.length - 1]));
  const inWindow = new Set(months);
  const hist = groupRows(exp.filter((v) => inWindow.has(em(v, basis))), (v) => [em(v, basis), v.flow ?? null,
    v.category, v.merchant_key, v.source, (v.installment_total ?? 0) > 1 ? 1 : 0]);
  const present = [...new Set(hist.map((g) => g.key[0]))].sort();
  const n = Math.max(1, present.length);
  const varAvg = new Map();
  const regular = new Map();
  for (const g of hist) {
    const [m, rawFlow, cat, mk, src, inst] = g.key;
    const flow = rawFlow ?? 'variable';
    const s = sqlSum(g.rows.map((v) => -v.amount)) || 0.0;
    if (flow === 'variable') {
      varAvg.set(cat, (varAvg.get(cat) ?? 0) + s / n);
    } else if (!inst) {
      const k = JSON.stringify([src, mk]);
      if (!regular.has(k)) regular.set(k, new Map());
      const mm = regular.get(k);
      mm.set(m, (mm.get(m) ?? 0) + s);
    }
  }
  const curOf = (flow, cat) => cur.get(JSON.stringify([flow, cat]))?.s ?? 0.0;
  const left = pySum([...varAvg].map(([cat, avg]) => pyMax(0.0, avg - curOf('variable', cat))));
  const over = pySum(curVals.filter((x) => x.flow === 'variable').map((x) => pyMax(0.0, x.s - (varAvg.get(x.cat) ?? 0.0))));

  // regular fixed charges (standing orders, subscriptions) not seen yet this month
  const seenNow = new Set(cx.rows.filter((v) => !v.neutralized && v.flow === 'fixed' && (v.installment_total ?? 0) <= 1
    && em(v, basis) === month).map((v) => JSON.stringify([v.source, v.merchant_key])));
  let fixedLeft = pySum([...regular].filter(([k, mm]) => !seenNow.has(k) && mm.size >= 2).map(([, mm]) => median([...mm.values()])));

  // installment plans, each on its own: the next payment is expected when the plan isn't over and this
  // month's payment hasn't shown up
  const planRows = cx.rows.filter((v) => !v.neutralized && (v.installment_total ?? 0) > 1 && em(v, basis) <= month)
    .sort((a, b) => cmpStr(em(a, basis), em(b, basis)));
  const plans = new Map();
  for (const v of planRows) {
    const k = JSON.stringify([v.source, v.account, v.merchant_key, v.date, v.installment_total]);
    if (!plans.has(k)) plans.set(k, { count: 0, last_no: 0, now: false, amount: 0.0, tot: v.installment_total, last_m: '' });
    const pl = plans.get(k);
    const m = em(v, basis);
    pl.count += 1;
    pl.last_no = Math.max(pl.last_no, v.installment_no || 0);
    pl.amount = -v.amount;
    pl.last_m = m;
    pl.now = pl.now || m === month;
  }
  const recent = prevMonth(prevMonth(month)); // a plan last seen long ago has ended (or left the data)
  for (const pl of plans.values()) {
    const paid = Math.max(pl.last_no, pl.count);
    if (!pl.now && paid < pl.tot && pl.amount > 0 && pl.last_m >= recent) fixedLeft += pl.amount;
  }

  const future = cx.rows.filter((v) => v.source === 'max' && v.charge_date >= today);
  let nextCard = null;
  if (future.length) {
    const d = strMin(future.map((v) => v.charge_date));
    nextCard = { date: d, amount: pyRound(sqlSum(future.filter((v) => v.charge_date === d).map((v) => -v.amount)), 2) };
  }
  return {
    fixed: pyRound(fixedNow, 2), fixed_left: pyRound(fixedLeft, 2),
    variable: pyRound(varNow, 2), variable_avg: pyRound(pySum([...varAvg.values()]), 2),
    left_to_spend: present.length ? pyRound(left, 2) : null,
    over: present.length ? pyRound(over, 2) : null,
    next_card: nextCard,
  };
}

// ====================================================================== planner.py: recurring charges
const seriesKey = (source, account, merchant) => `${pyIntStr(source)}|${pyIntStr(account)}|${pyIntStr(merchant)}`;

function mostCommon(list) { // max(set(list), key=list.count); ties: the first one seen
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = null;
  let bc = -1;
  for (const [x, c] of counts) if (c > bc) { best = x; bc = c; }
  return best;
}

/** One merchant text may hide several standing orders (three phone lines): each rank is its own series. */
function splitSeries(perMonth, category) {
  if (CONSUMPTION.has(category)) return [['', perMonth]];
  const counts = [...perMonth.values()].map((v) => v.length);
  const freq = new Map();
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
  let c = null;
  for (const v of [...freq.keys()].sort((a, b) => a - b)) if (c === null || freq.get(v) > freq.get(c)) c = v;
  if (c <= 1 || freq.get(c) < 0.7 * counts.length || c > 6) return [['', perMonth]];
  const out = [];
  for (let j = 0; j < c; j++) {
    const part = new Map();
    for (const [m, rs] of perMonth) if (rs.length === c) part.set(m, [[...rs].sort((a, b) => b.amount - a.amount)[j]]);
    out.push([`#${j + 1}`, part]);
  }
  return out;
}

/** A payment due at a month's end that slipped to the 1st leaves one month empty and the next with two. */
function settle(perMonth) {
  const out = new Map();
  for (const [m, v] of perMonth) out.set(m, [...v]);
  for (const m of [...out.keys()].sort()) {
    const rs = [...out.get(m)].sort((a, b) => cmpStr(a.date, b.date));
    if (rs.length !== 2) continue;
    const pm = prevMonth(m);
    const nm = nextMonth(m);
    if (!out.has(pm) && +rs[0].date.slice(8, 10) <= 5) {
      out.set(pm, [rs[0]]);
      out.set(m, [rs[1]]);
    } else if (!out.has(nm) && +rs[1].date.slice(8, 10) >= 25) {
      out.set(nm, [rs[1]]);
      out.set(m, [rs[0]]);
    }
  }
  return out;
}

function oneSeries(src, acc, mk, suffix, perMonth0, notes, today, curMonth, accountStart, dataEnd) {
  const perMonth = settle(perMonth0);
  const months = [...perMonth.keys()].sort();
  if (months.length < 3) return null;
  const lastM = months[months.length - 1];
  const lastRows = perMonth.get(lastM);
  // the latest month charged twice, in two charges: a double charge, not a new price
  const double = lastRows.length === 2 && months.slice(0, -1).every((m) => perMonth.get(m).length === 1);
  if (!double && Math.max(...[...perMonth.values()].map((v) => v.length)) > 1) return null;
  // a standing order comes on (nearly) the same day of the month; shopping doesn't
  const days = months.map((m) => +perMonth.get(m)[0].date.slice(8, 10));
  const mid = median(days);
  const near = days.filter((d) => Math.min(Math.abs(d - mid), 31 - Math.abs(d - mid)) <= 4).length;
  if (near < 0.6 * days.length) return null;
  const gaps = months.slice(1).map((m, i) => monthsBetween(months[i], m));
  const cadence = gaps.filter((g) => g === 1).length >= 0.7 * gaps.length ? 1
    : gaps.filter((g) => g === 2).length >= 0.7 * gaps.length ? 2 : 0;
  if (!cadence) return null;
  // a fixed foreign price is followed in its own currency: the shekel amount moves with the rate
  const first = months.map((m) => perMonth.get(m)[0]);
  const curs = new Set(first.map((r) => r.orig_currency ?? null));
  const cur1 = [...curs][0];
  const foreign = curs.size === 1 && ![null, '', 'ILS', '₪', 'NIS'].includes(cur1) && first.every((r) => r.orig_amount);
  const unit = foreign ? cur1 : '₪';
  const amounts = months.map((m) => (foreign ? Math.abs(perMonth.get(m)[0].orig_amount) : -perMonth.get(m)[0].amount));
  const ils = months.map((m) => -pySum(perMonth.get(m).slice(0, 1).map((r) => r.amount)));
  const steps = [];
  for (let i = 0; i + 1 < amounts.length; i++) if (amounts[i] > 0) steps.push(Math.abs(amounts[i + 1] - amounts[i]) <= 0.15 * amounts[i]);
  const allowed = steps.length <= 4 ? steps.length - 1 : 0.7 * steps.length; // an intro price may end early on
  if (!steps.length || steps.filter(Boolean).length < allowed || median(amounts) < 5) return null;
  const last = lastRows[0];
  const price = amounts[amounts.length - 1];
  const prev = median(amounts.slice(-4, -1));
  const change = pyRound(price - prev, 2);
  // bills that follow consumption move a little every month: only a clear jump counts there
  const rel = [];
  for (let i = 0; i + 2 < amounts.length; i++) if (amounts[i] > 0) rel.push(Math.abs(amounts[i + 1] - amounts[i]) / amounts[i]);
  const vol = rel.length ? median(rel) : 0.0;
  const pct = vol < 0.01 ? PRICE_STEP_PCT : Math.max(0.15, 2.5 * vol);
  const minStep = MIN_PRICE_STEP * (foreign ? 0.5 : 1);
  let trend = '';
  if (change >= minStep && change >= pct * prev) trend = 'up';
  else if (-change >= minStep && -change >= pct * prev) trend = 'down';
  const lastCharge = lastRows[lastRows.length - 1].charge_date;
  const expected = addMonths(lastCharge, cadence);
  // judged by the last day this account has data for: an account not updated for a while has no news
  const seenUntil = dataEnd ? strMin([today, dataEnd.slice(0, 10)]) : today;
  const missed = dnum(seenUntil) > dnum(expected) + 20;
  if (missed && dnum(today) - dnum(lastCharge) > 31 * (cadence + 3)) return null; // ended long ago
  const firstSeen = perMonth.get(months[0])[0].charge_date;
  // new only if the account has older data without it (the first sync loads a year at once)
  const isNew = months.length <= 3 && monthsBetween(firstSeen.slice(0, 7), curMonth) <= cadence * 2 + 1
    && !!accountStart && monthsBetween(accountStart.slice(0, 7), firstSeen.slice(0, 7)) >= 2;
  const key = seriesKey(src, acc, mk) + suffix;
  const note = (hasOwn(notes, key) && notes[key]) || {};
  const status = double ? 'double' : missed ? 'stopped' : isNew ? 'new' : (trend || 'active');
  return {
    key, name: last.description + (suffix ? ` (${suffix.slice(1)})` : ''), category: last.category || '',
    source: src, account: acc, owner: last.kowner || '',
    cadence, price: pyRound(ils[ils.length - 1], 2), prev: pyRound(prev, 2), change, unit,
    unit_price: pyRound(price, 2), trend, status, monthly: pyRound(ils[ils.length - 1] / cadence, 2),
    typical: pyRound(median(ils), 2), yearly: pyRound(ils[ils.length - 1] * 12 / cadence, 2),
    since: firstSeen, last: lastCharge, next: missed ? null : expected, count: months.length,
    promo_end: note.promo_end ?? null, promo_price: note.promo_price ?? null, note: note.note || '',
    muted: !!note.muted,
  };
}

/** Every regular charge (standing orders, subscriptions). Installment plans are not subscriptions. */
function recurring(cx, today) {
  const since = addMonths(`${today.slice(0, 8)}01`, -14);
  const rows = cx.rows.filter((v) => v.amount < 0 && !v.neutralized && !v.is_settlement && !v.pending
    && (v.installment_total ?? 0) <= 1 && v.kind === 'expense' && (v.category ?? '') !== 'משיכות מזומן'
    && v.charge_date >= since).sort((a, b) => cmpStr(a.charge_date, b.charge_date));
  const groups = new Map();
  const firstByAccount = new Map();
  const dataEnd = new Map();
  for (const r of rows) {
    const acc = JSON.stringify([r.source, r.account]);
    if (!firstByAccount.has(acc)) firstByAccount.set(acc, r.charge_date);
    dataEnd.set(acc, strMax([dataEnd.get(acc) ?? '', r.date]));
    if (r.merchant_key) {
      const k = JSON.stringify([r.source, r.account, r.merchant_key]);
      if (!groups.has(k)) groups.set(k, { src: r.source, acc: r.account, mk: r.merchant_key, rows: [] });
      groups.get(k).rows.push(r);
    }
  }
  const notes = cx.state.recurring_notes || {};
  const curMonth = today.slice(0, 7);
  const out = [];
  for (const g of groups.values()) {
    const byMonth = new Map();
    for (const r of g.rows) {
      const m = r.charge_date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(r);
    }
    const acc = JSON.stringify([g.src, g.acc]);
    for (const [suffix, perMonth] of splitSeries(byMonth, mostCommon(g.rows.map((r) => r.category || '')))) {
      const item = oneSeries(g.src, g.acc, g.mk, suffix, perMonth, notes, today, curMonth,
        firstByAccount.get(acc) ?? '', dataEnd.get(acc) ?? '');
      if (item) out.push(item);
    }
  }
  const order = { up: 0, double: 1, new: 2, stopped: 3, down: 4, active: 5 };
  out.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.yearly - a.yearly);
  return out;
}

function recurringSummary(items) {
  const live = items.filter((i) => i.status !== 'stopped');
  return {
    count: live.length, monthly: pyRound(pySum(live.map((i) => i.monthly)), 2),
    yearly: pyRound(pySum(live.map((i) => i.yearly)), 2),
    up: live.filter((i) => i.status === 'up').length,
    double: live.filter((i) => i.status === 'double').length,
    new: live.filter((i) => i.status === 'new').length,
    stopped: items.filter((i) => i.status === 'stopped').length,
  };
}

const unitMoney = (i) => ((i.unit ?? '₪') !== '₪' ? (v) => `${pyFixed(v, 2, true)} ${i.unit}`.replace('.00', '') : money);

/** What is worth a notification right now (each has a stable id). */
function recurringEvents(items, today) {
  const out = [];
  for (const i of items) {
    if (i.muted) continue;
    const name = i.name;
    if (i.status === 'up') {
      const perYear = i.change * 12 / i.cadence;
      const fx = (i.unit ?? '₪') !== '₪';
      const m = unitMoney(i);
      out.push({ id: `up:${i.key}:${pyStr(fx ? i.unit_price : i.price)}`, kind: 'up', key: i.key,
        text: `${name} התייקר: ${m(i.prev)} ← ${m(i.unit_price ?? i.price)} (עוד ${m(perYear)} בשנה)` });
    }
    if (i.status === 'double') {
      out.push({ id: `double:${i.key}:${i.last.slice(0, 7)}`, kind: 'double', key: i.key,
        text: `${name} חויב פעמיים ב-${fmtMY(i.last)}. כדאי לבדוק` });
    }
    if (i.status === 'new') {
      out.push({ id: `new:${i.key}`, kind: 'new', key: i.key,
        text: `חיוב קבוע חדש: ${name}, ${money(i.price)} ${i.cadence === 1 ? 'בחודש' : 'כל חודשיים'}` });
    }
    if (i.status === 'stopped') {
      out.push({ id: `stop:${i.key}:${i.last}`, kind: 'stopped', key: i.key,
        text: `${name} לא חויב בזמן (אחרון ב-${fmtDM(i.last)}). אם ביטלתם, מצוין; אם לא, כדאי לבדוק` });
    }
    if (i.promo_end) {
      const end = String(i.promo_end);
      const days = dnum(end) - dnum(today);
      const after = i.promo_price ? `, ואחריו ${money(i.promo_price)}` : '';
      if (days > 0 && days <= PROMO_NOTICE_DAYS) {
        out.push({ id: `promo30:${i.key}:${end}`, kind: 'promo', key: i.key,
          text: `המבצע של ${name} מסתיים ב-${fmtDM(end)}${after}. זה הזמן להתקשר ולהתמקח` });
      } else if (days >= -7 && days <= 0) {
        out.push({ id: `promo0:${i.key}:${end}`, kind: 'promo', key: i.key, text: `המבצע של ${name} הסתיים${after}` });
      }
    }
  }
  return out;
}

// ====================================================================== planner.py: annual planner
/**
 * The big expenses that don't come every month: months in which a category spent well above its usual month
 * over the last twelve, expected again in the same month, plus what the user added. The monthly provision is
 * the smallest fixed amount that, put aside from next month on, covers every expected expense in time.
 */
function annualPlan(cx, basis, today, minSpike = SPIKE_MIN, recItems = null) {
  const regular = new Set((recItems || recurring(cx, today)).map((i) => i.key.split('#')[0]));
  const start = `${today.slice(0, 8)}01`;
  const first = addMonths(start, -12).slice(0, 7);
  const last = addMonths(start, -1).slice(0, 7);
  const rows = cx.rows.filter((v) => !v.neutralized && v.kind === 'expense' && (v.installment_total ?? 0) <= 1
    && em(v, basis) >= first && em(v, basis) <= last);
  const seenMonths = new Set();
  const tot = new Map();
  const top = new Map();
  for (const g of groupRows(rows, (v) => [em(v, basis), v.category ?? 'ללא קטגוריה', v.description, v.source,
    v.account, v.merchant_key])) {
    const [m, cat, d, src, acc, mk] = g.key;
    seenMonths.add(m);
    if (regular.has(seriesKey(src, acc, mk || ''))) continue; // a regular bill is not a yearly expense
    const s = sqlSum(g.rows.map((v) => -v.amount)) || 0.0;
    const k = JSON.stringify([cat, m]);
    tot.set(k, (tot.get(k) ?? 0) + s);
    if (!top.has(k)) top.set(k, new Map());
    top.get(k).set(d, (top.get(k).get(d) ?? 0) + s);
  }
  const months = [...seenMonths].sort();
  const items = [];
  if (months.length >= 6) { // half a year at least, or every month looks special
    const cats = [...new Set([...tot.keys()].map((k) => JSON.parse(k)[0]))].filter((c) => !NOT_PLANNED.has(c)).sort(cmpStr);
    for (const cat of cats) {
      const vals = months.map((m) => [m, tot.get(JSON.stringify([cat, m])) ?? 0.0]);
      const usual = median(vals.map((x) => x[1]));
      for (const [m, v] of vals) {
        const extra = v - usual;
        if (extra >= pyMax(minSpike, usual * SPIKE_PCT)) {
          // name it after what made the month heavy, not after the usual monthly charges
          const tm = top.get(JSON.stringify([cat, m])) ?? new Map();
          const extraBy = [...tm].map(([d, a]) => [d, a - median(months.map((mm) => top.get(JSON.stringify([cat, mm]))?.get(d) ?? 0.0))]);
          const names = extraBy.filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
          const label = names.map(([d]) => d).join(', ') || cat;
          items.push({ key: `auto|${cat}|${+m.slice(5, 7)}`, name: `${cat}: ${label}`, what: label, category: cat,
            month: +m.slice(5, 7), amount: pyRound(extra, 0), auto: true, seen: m, usual: pyRound(usual, 0) });
        }
      }
    }
  }
  const planned = [...(cx.state.planned || [])].sort((a, b) => a.id - b.id);
  const overrides = new Map();
  for (const r of planned) if (r.auto_key !== null && r.auto_key !== undefined) overrides.set(r.auto_key, r);
  const plan = [];
  for (let it of items) {
    const ov = overrides.get(it.key);
    if (ov && ov.hidden) continue;
    if (ov) {
      it = { ...it, amount: ov.amount, name: ov.name || it.name, what: ov.name || it.what, month: ov.month || it.month,
        year: ov.year ?? null, id: ov.id, edited: true };
    }
    plan.push(it);
  }
  for (const r of planned) {
    if ((r.auto_key === null || r.auto_key === undefined) && !r.hidden) {
      plan.push({ key: `manual|${r.id}`, id: r.id, name: r.name, what: r.name, category: '', month: r.month,
        year: r.year ?? null, amount: r.amount, auto: false });
    }
  }
  const timeline = [];
  for (let k = 0; k < 12; k++) { // the next twelve months, this one first
    const d = addMonths(start, k);
    const y = +d.slice(0, 4);
    const mo = +d.slice(5, 7);
    const due = plan.filter((it) => Number(it.month) === mo && (!it.year || Number(it.year) === y));
    timeline.push({ month: d.slice(0, 7), label: `${HE_MONTHS[mo - 1]} ${y}`, items: [...due].sort((a, b) => b.amount - a.amount),
      total: pyRound(pySum(due.map((x) => x.amount)), 0) });
  }
  let cum = 0.0;
  let need = 0.0;
  timeline.slice(1).forEach((mth, i) => { // what can still be saved for, from next month on
    cum += mth.total;
    need = pyMax(need, cum / (i + 1));
  });
  const provision = need ? Math.trunc(Math.ceil(need / 10.0) * 10) : 0;
  const upcoming = [];
  for (const m of timeline) for (const it of m.items) upcoming.push({ ...it, when: m.month, label: m.label });
  return {
    history_months: months.length, enough_history: months.length >= 6, items: plan, timeline, provision,
    average: pyRound(pySum(timeline.map((m) => m.total)) / 12, 0), this_month: timeline[0].total,
    year_total: pyRound(pySum(timeline.map((m) => m.total)), 0), next: upcoming.slice(0, 6),
  };
}

// ====================================================================== alerts.py
/** This month's expenses against the month's expected income (the larger of arrived and forecast). */
function budgetStatus(cx, basis, today, fc = null) {
  const month = today.slice(0, 7);
  fc = fc || forecast(cx, basis, month, today);
  const base = pyMax(fc.income_forecast || 0.0, fc.income_actual || 0.0);
  const spent = fc.expense_actual || 0.0;
  return { month, base: pyRound(base, 2), spent: pyRound(spent, 2), pct: base > 0 ? pyRoundInt(100 * spent / base) : null };
}

// ====================================================================== behavior.py: per-person profile
function ownersOverview(state, bankOwner) {
  const named = new Map();
  for (const r of [...state.owners].sort((a, b) => sqlCmp(a.sort, b.sort) || cmpStr(a.name, b.name))) named.set(r.name, r.color);
  const cards = new Map();
  for (const card of Object.keys(state.cards).sort(cmpStr)) {
    const o = state.cards[card].owner || UNASSIGNED;
    if (!cards.has(o)) cards.set(o, []);
    cards.get(o).push(card);
  }
  const names = [...named.keys()];
  for (const n of cards.keys()) if (!names.includes(n)) names.push(n);
  if (!names.includes(bankOwner)) names.push(bankOwner);
  return names.map((n, i) => ({ name: n, color: named.get(n) || OWNER_COLORS[i % OWNER_COLORS.length],
    cards: cards.get(n) || [], is_bank_owner: n === bankOwner, unassigned: n === UNASSIGNED }));
}

function mostCommonName(counter) { // Counter.most_common(1): ties go to the first one counted
  let best = null;
  let bc = -1;
  for (const [k, c] of counter) if (c > bc) { best = k; bc = c; }
  return best;
}

function findAnomalies(rows, curM) {
  const out = [];
  const seenIds = new Set();
  const prevM = shiftMonth(curM, -1);
  const recentMonths = new Set([curM, prevM]);
  const histByMk = new Map();
  const histByCat = new Map();
  const firstSeen = new Map();
  for (const r of rows) {
    if (r.amount >= 0) continue;
    const mk = r.merchant_key || r.description;
    if (!histByMk.has(mk)) histByMk.set(mk, []);
    histByMk.get(mk).push([r.id, -r.amount]);
    const c = r.category || 'כללי';
    if (!histByCat.has(c)) histByCat.set(c, []);
    histByCat.get(c).push(-r.amount);
    if (!firstSeen.has(mk)) firstSeen.set(mk, r.date);
  }
  const add = (r, kind, text) => {
    if (seenIds.has(r.id)) return;
    seenIds.add(r.id);
    out.push({ date: r.date, description: r.description, amount: pyRound(-r.amount, 2), kind, text, card: r.account });
  };
  const dkey = (r) => JSON.stringify([r.merchant_key, r.date, pyRound(r.amount, 2), r.account]);
  const dups = new Map();
  for (const r of rows) if (r.amount < 0 && !r.installment_total) dups.set(dkey(r), (dups.get(dkey(r)) ?? 0) + 1);
  for (const r of rows) {
    if (r.amount >= 0 || !recentMonths.has(r.date.slice(0, 7))) continue;
    const amt = -r.amount;
    const mk = r.merchant_key || r.description;
    if ((dups.get(dkey(r)) ?? 0) >= 2 && amt >= 15) {
      add(r, 'duplicate', 'חיוב כפול אפשרי: אותו סכום, אותו בית עסק ואותו יום');
      continue;
    }
    const hist = histByMk.get(mk) || [];
    const others = hist.filter(([i]) => i !== r.id).map(([, a]) => a);
    if (others.length >= 3) {
      const med = median(others);
      if (med > 0 && amt > 3 * med && amt - med >= 100) {
        add(r, 'merchant', `פי ${pyFixed(amt / med, 1)} מהסכום הרגיל בבית עסק זה (₪${pyFixed(med, 0, true)})`);
        continue;
      }
    }
    if ((firstSeen.get(mk) ?? r.date) >= prevM && amt >= 500 && hist.length === 1) {
      add(r, 'new', 'בית עסק חדש בסכום גבוה');
      continue;
    }
    const catVals = histByCat.get(r.category || 'כללי') || [];
    if (catVals.length >= 6 && amt >= 300) {
      const mean = fmean(catVals);
      const sd = pstdev(catVals);
      if (sd > 0 && amt > mean + 3 * sd) {
        add(r, 'category', `גבוה במיוחד לקטגוריה ${pyIntStr(r.category)} (ממוצע ₪${pyFixed(mean, 0, true)})`);
      }
    }
  }
  out.sort((a, b) => cmpStr(b.date, a.date));
  return out;
}

function profileInsights(p, today) {
  const tips = [];
  const name = p.owner;
  const day = +today.slice(8, 10);
  const dim = daysInMonth(+today.slice(0, 4), +today.slice(5, 7));
  if (p.avg3 && day >= 7) {
    const diff = (p.projected - p.avg3) / p.avg3 * 100;
    tips.push(`קצב ההוצאות של ${name} החודש צפוי להגיע ל-${fmtShekel(p.projected)}, `
      + `${pyFixed(Math.abs(diff), 0)}% ${diff >= 0 ? 'מעל' : 'מתחת'} לממוצע האישי (${fmtShekel(p.avg3)}).`);
  } else if (p.avg3) {
    tips.push(`תחילת החודש: ${fmtShekel(p.current)} עד כה. הממוצע האישי של ${name} הוא ${fmtShekel(p.avg3)} לחודש.`);
  } else if (p.current) {
    tips.push(`הוצאות ${name} החודש עד כה: ${fmtShekel(p.current)}. עוד חודשים של נתונים ישפרו את ההשוואה.`);
  }
  const ups = p.categories.filter((c) => c.avg > 0 && c.current > c.avg * 1.25 && c.current - c.avg > 150);
  for (const c of ups.slice(0, 3)) {
    tips.push(`${c.category}: ${fmtShekel(c.current)} החודש לעומת ממוצע ${fmtShekel(c.avg)} `
      + `(+${pyFixed((c.current / c.avg - 1) * 100, 0)}%).`);
  }
  if (day / dim > 0.6) {
    const downs = p.categories.filter((c) => c.avg > 300 && c.current < c.avg * 0.6);
    for (const c of downs.slice(0, 1)) tips.push(`חיסכון יפה ב${c.category}: ${fmtShekel(c.current)} לעומת ${fmtShekel(c.avg)} בממוצע.`);
  }
  if (p.frequent.length && p.frequent[0].count >= 3) {
    const f = p.frequent[0];
    tips.push(`בית העסק הקבוע: ${f.name} (${f.count} ביקורים ב-90 יום, ${fmtShekel(f.total)}).`);
  }
  if (p.weekdays.some((w) => w.count)) {
    let busiest = p.weekdays[0];
    for (const w of p.weekdays) if (w.total > busiest.total) busiest = w;
    tips.push(`היום עם הכי הרבה הוצאות: יום ${busiest.day}.`);
  }
  if (p.subscriptions.length) {
    const n = p.subscriptions.length;
    const lead = n === 1 ? 'חיוב חוזר אחד (מנוי)' : `${n} חיובים חוזרים (מנויים)`;
    tips.push(`${lead} בסך ${fmtShekel(pySum(p.subscriptions.map((s) => s.monthly)))} לחודש.`);
  }
  if (p.installments.length) {
    const n = p.installments.length;
    const lead = n === 1 ? 'עסקה אחת בתשלומים פעילה' : `${n} עסקאות בתשלומים פעילות`;
    tips.push(`${lead}: ${fmtShekel(pySum(p.installments.map((i) => i.monthly)))} בחודש, `
      + `נותרו לתשלום ${fmtShekel(pySum(p.installments.map((i) => i.remaining)))}.`);
  }
  if (p.foreign_90d > 0) tips.push(`${fmtShekel(p.foreign_90d)} הוצאו במטבע חוץ ב-90 הימים האחרונים.`);
  if (p.anomalies.length) {
    const n = p.anomalies.length;
    tips.push(`${n === 1 ? 'עסקה חריגה אחת כדאי לבדוק' : `${n} עסקאות חריגות כדאי לבדוק`} (ראה רשימת חריגות).`);
  }
  if (p.avg_ticket) tips.push(`עסקה ממוצעת: ${fmtShekel(p.avg_ticket)}, כ-${pyFixed(p.tx_per_month, 0)} עסקאות בחודש.`);
  if (p.household_share !== null && p.owner !== UNASSIGNED) {
    tips.push(`חלק מהוצאות משק הבית ב-90 הימים האחרונים: ${pyFixed(p.household_share, 0)}%.`);
  }
  return tips;
}

/** What FinPal learned about one person: pace, category shifts, merchants, habits, subscriptions, anomalies. */
function profile(cx, owner, today) {
  const curM = today.slice(0, 7);
  const months = [5, 4, 3, 2, 1, 0].map((i) => shiftMonth(curM, -i)); // 6 months, oldest first
  const since = `${months[0]}-01`;
  const rows = cx.rows.filter((v) => !v.neutralized && v.date >= since && v.owner === owner && v.kind === 'expense')
    .sort((a, b) => cmpStr(a.date, b.date));
  const prev3 = months.slice(-4, -1);
  const spend = new Map();
  const catMonth = new Map();
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    spend.set(m, (spend.get(m) ?? 0) + -r.amount);
    const k = JSON.stringify([r.category || 'כללי', m]);
    catMonth.set(k, (catMonth.get(k) ?? 0) + -r.amount);
  }
  const cur = spend.get(curM) ?? 0.0;
  const prevVals = prev3.filter((m) => spend.get(m)).map((m) => spend.get(m));
  const avg3 = prevVals.length ? pySum(prevVals) / prevVals.length : null;
  const day = +today.slice(8, 10);
  const dim = daysInMonth(+today.slice(0, 4), +today.slice(5, 7));
  const projected = day ? cur / day * dim : cur;

  const cats = [...new Set([...catMonth.keys()].map((k) => JSON.parse(k)[0]))].sort(cmpStr);
  const catRows = [];
  for (const c of cats) {
    const a = catMonth.get(JSON.stringify([c, curM])) ?? 0.0;
    const av = pySum(prev3.map((m) => catMonth.get(JSON.stringify([c, m])) ?? 0.0)) / (prevVals.length || 1);
    if (a || av) {
      catRows.push({ category: c, current: pyRound(a, 2), avg: pyRound(av, 2),
        delta_pct: av ? pyRound((a - av) / av * 100, 1) : null });
    }
  }
  catRows.sort((x, y) => y.current - x.current);

  const recentSince = addDays(today, -90);
  const recent = rows.filter((r) => r.date >= recentSince);
  const purchases = recent.filter((r) => r.amount < 0);
  const merch = new Map();
  const names = new Map();
  for (const r of purchases) {
    const mk = r.merchant_key || r.description;
    if (!merch.has(mk)) merch.set(mk, { count: 0, total: 0.0 });
    const d = merch.get(mk);
    d.count += 1;
    d.total += -r.amount;
    if (!names.has(mk)) names.set(mk, new Map());
    names.get(mk).set(r.description, (names.get(mk).get(r.description) ?? 0) + 1);
  }
  const merchants = [...merch].map(([k, v]) => ({ name: mostCommonName(names.get(k)), count: v.count,
    total: pyRound(v.total, 2), avg: pyRound(v.total / v.count, 2) }));
  const topMerchants = [...merchants].sort((a, b) => b.total - a.total).slice(0, 8);
  const frequent = [...merchants].sort((a, b) => b.count - a.count).slice(0, 5);

  const wdCount = [0, 0, 0, 0, 0, 0, 0];
  const wdTotal = [0, 0, 0, 0, 0, 0, 0];
  for (const r of purchases) {
    const wd = weekday(r.date);
    wdCount[wd] += 1;
    wdTotal[wd] += -r.amount;
  }
  const weekdays = [6, 0, 1, 2, 3, 4, 5].map((i) => ({ day: WEEKDAYS_HE[i], count: wdCount[i], total: pyRound(wdTotal[i], 2) }));

  const tickets = purchases.map((r) => -r.amount);
  const avgTicket = tickets.length ? fmean(tickets) : 0.0;
  const fullPrev = rows.filter((r) => prev3.includes(r.date.slice(0, 7)) && r.amount < 0);
  const txPerMonth = fullPrev.length ? fullPrev.length / (prevVals.length || 1) : purchases.length / 3;

  // subscriptions: same merchant, >= 3 of the last 5 months, near-constant amount
  const last5 = new Set(months.slice(-5));
  const byMkMonth = new Map();
  for (const r of rows) {
    if (r.amount < 0 && !r.installment_total && last5.has(r.date.slice(0, 7))) {
      const mk = r.merchant_key || r.description;
      if (!byMkMonth.has(mk)) byMkMonth.set(mk, new Map());
      const pm = byMkMonth.get(mk);
      const m = r.date.slice(0, 7);
      if (!pm.has(m)) pm.set(m, []);
      pm.get(m).push(-r.amount);
    }
  }
  const subscriptions = [];
  for (const [mk, perM] of byMkMonth) {
    if (perM.size < 3) continue;
    const vals = [...perM.values()].map((v) => pySum(v));
    const med = median(vals);
    if (med <= 0) continue;
    const cv = vals.length > 1 ? pstdev(vals) / fmean(vals) : 0;
    if (cv <= 0.15 && [...perM.values()].every((v) => v.length <= 2)) {
      subscriptions.push({ name: names.has(mk) ? mostCommonName(names.get(mk)) : mk, monthly: pyRound(med, 2), months: perM.size });
    }
  }
  subscriptions.sort((a, b) => b.monthly - a.monthly);

  // open installment plans (latest installment seen per plan)
  const plans = new Map();
  for (const r of rows) {
    if (r.installment_total && r.installment_no) {
      const key = JSON.stringify([r.merchant_key, r.installment_total, r.orig_amount, r.account]);
      if (!plans.has(key) || r.installment_no > plans.get(key).no) {
        plans.set(key, { name: r.description, no: r.installment_no, total: r.installment_total, monthly: -r.amount });
      }
    }
  }
  const installments = [];
  for (const p of plans.values()) {
    const left = p.total - p.no;
    if (left > 0) installments.push({ ...p, left, remaining: pyRound(left * p.monthly, 2) });
  }
  installments.sort((a, b) => b.remaining - a.remaining);

  const foreign = pySum(purchases.filter((r) => r.orig_currency && !isIls(r.orig_currency)).map((r) => -r.amount));
  const anomalies = findAnomalies(rows, curM);
  const hh = sqlSum(cx.rows.filter((v) => !v.neutralized && v.kind === 'expense' && v.date >= recentSince).map((v) => v.amount));
  const totalHousehold = hh === null ? 0.0 : (-hh || 0.0);
  const ownRecent = pySum(recent.map((r) => -r.amount));
  const share = totalHousehold > 0 ? ownRecent / totalHousehold * 100 : null;

  const p = {
    owner, month: curM,
    current: pyRound(cur, 2), projected: pyRound(projected, 2), avg3: avg3 !== null ? pyRound(avg3, 2) : null,
    monthly: months.map((m) => ({ month: m, spend: pyRound(spend.get(m) ?? 0.0, 2) })),
    categories: catRows.slice(0, 12), top_merchants: topMerchants, frequent,
    weekdays, avg_ticket: pyRound(avgTicket, 2), tx_per_month: pyRound(txPerMonth, 1),
    subscriptions: subscriptions.slice(0, 10), installments: installments.slice(0, 10),
    foreign_90d: pyRound(foreign, 2), anomalies: anomalies.slice(0, 15),
    household_share: share !== null ? pyRound(share, 1) : null,
    data_points: rows.length,
  };
  p.insights = profileInsights(p, today);
  return p;
}

// ====================================================================== savings insights (new, phone only)
const DINING = 'מסעדות וקפה';
// not something a family trims by 20% (contracts, transfers, bank lines)
const NOT_REDUCIBLE = new Set([SETTLEMENT_CATEGORY, UNDETAILED_CARD_CATEGORY, 'הלוואות ומשכנתא', 'עמלות וריביות',
  'משיכות מזומן', 'העברות ותשלומים', 'מיסים וממשלה', 'ארנונה ועירייה', 'ביטוחים', 'חשבונות בית', FALLBACK_OUT,
  'ללא קטגוריה']);
const NOT_COMPARED = new Set([SETTLEMENT_CATEGORY, UNDETAILED_CARD_CATEGORY, 'הלוואות ומשכנתא', DINING]);

/**
 * Up to 6 saving tips {kind, title, text, amount}: a possible double charge, subscriptions that went up,
 * categories above the average of the 3 previous months, restaurants and deliveries, and a 20% idea.
 */
function savingsInsights(cx, basis, today, recItems, owners) {
  const curM = today.slice(0, 7);
  const totals = (m) => new Map(categoryTotals(cx, basis, m).map((c) => [c.category, c.total]));
  const cur = totals(curM);
  const prevMonths = [1, 2, 3].map((i) => shiftMonth(curM, -i))
    .filter((m) => cx.rows.some((v) => !v.neutralized && em(v, basis) === m));
  const prev = prevMonths.map(totals);
  const avgOf = (c) => pySum(prev.map((p) => p.get(c) ?? 0.0)) / prev.length;
  const pctTxt = (diff, avg) => (avg > 0 ? ` (${pyFixed(diff / avg * 100, 0)}%)` : '');
  const doubles = [];
  const subs = [];
  const ups = [];
  const extra = [];

  // a possible double charge: two equal charges at the same shop on the same day, or a standing order twice
  const seen = new Set();
  const named = new Set();
  for (const o of owners) {
    for (const a of o.profile.anomalies) {
      const k = JSON.stringify([a.description, a.date, a.amount, a.card]);
      if (a.kind !== 'duplicate' || seen.has(k)) continue;
      seen.add(k);
      named.add(a.description);
      doubles.push({ kind: 'double_charge', title: 'חיוב כפול אפשרי',
        text: `${a.description} חויב פעמיים ב-${fmtDM(a.date)}, באותו סכום (${money(a.amount)}). `
          + 'אם הייתה רק קנייה אחת, כדאי לפנות לחברת האשראי ולבקש זיכוי.', amount: pyRound(a.amount, 2) });
    }
  }
  for (const i of recItems) {
    if (i.status !== 'double' || i.muted) continue;
    if (named.has(i.name.replace(/ \(\d+\)$/, ''))) continue; // the same double charge, already told above
    doubles.push({ kind: 'double_charge', title: `${i.name} חויב פעמיים`,
      text: `${i.name} חויב פעמיים ב-${fmtMY(i.last)}. אם זה לא מכוון, כדאי לבקש החזר על החיוב הנוסף.`,
      amount: pyRound(i.price, 2) });
  }

  // subscriptions that went up, and what it costs a year
  for (const i of recItems) {
    if (i.status !== 'up' || i.muted) continue;
    const m = unitMoney(i);
    const perYear = i.change * 12 / i.cadence;
    const rate = i.unit_price ? i.price / i.unit_price : 1; // a foreign price, in shekels
    subs.push({ kind: 'subscription_up', title: `${i.name} התייקר`,
      text: `המחיר עלה מ-${m(i.prev)} ל-${m(i.unit_price)} ${i.cadence === 1 ? 'בחודש' : 'לחודשיים'}, כלומר עוד `
        + `${m(perYear)} בשנה. שיחה קצרה לשירות הלקוחות יכולה להחזיר את המחיר הקודם.`,
      amount: pyRound(perYear * rate, 2) });
  }
  subs.sort((a, b) => b.amount - a.amount);

  // categories this month above the average of the 3 previous months
  if (prev.length) {
    for (const [c, t] of cur) {
      if (NOT_COMPARED.has(c)) continue;
      const avg = avgOf(c);
      const diff = t - avg;
      if (diff < 100 || (avg > 0 && diff < 0.15 * avg)) continue;
      ups.push({ kind: 'category_up', title: `${c}: יותר מהרגיל`,
        text: avg > 0
          ? `החודש יצאו ${money(t)} על ${c}, ${money(diff)}${pctTxt(diff, avg)} יותר מהממוצע של שלושת `
            + `החודשים הקודמים (${money(avg)}). שווה להציץ ולראות מה הקפיץ את זה.`
          : `החודש יצאו ${money(t)} על ${c}, הוצאה שלא הופיעה בשלושת החודשים הקודמים. `
            + 'אם זו קנייה חד-פעמית, הכול בסדר.',
        amount: pyRound(diff, 2) });
    }
    ups.sort((a, b) => b.amount - a.amount);
  }

  // restaurants, cafes and deliveries this month against the average
  let dining = null;
  if (prev.length) {
    const t = cur.get(DINING) ?? 0.0;
    const avg = avgOf(DINING);
    const diff = t - avg;
    const day = +today.slice(8, 10);
    const early = basis === 'transaction' && day / daysInMonth(+today.slice(0, 4), +today.slice(5, 7)) < 0.6;
    if (t > 0 || avg > 0) {
      let text = null;
      if (Math.abs(diff) < Math.max(50, 0.05 * avg)) {
        text = `החודש יצאו ${money(t)} על מסעדות, בתי קפה ומשלוחים, בערך כמו בממוצע (${money(avg)}). יציבות יפה.`;
      } else if (diff > 0) {
        text = `החודש יצאו ${money(t)} על מסעדות, בתי קפה ומשלוחים, ${money(diff)}${pctTxt(diff, avg)} יותר מהממוצע `
          + `(${money(avg)}). ערב אחד בשבוע של בישול בבית יכול לעשות הבדל יפה.`;
      } else if (!early) {
        text = `החודש יצאו ${money(t)} על מסעדות, בתי קפה ומשלוחים, ${money(-diff)} פחות מהממוצע (${money(avg)}). `
          + 'כל הכבוד, ככה ממשיכים!';
      }
      if (text) dining = { kind: 'dining', title: 'מסעדות ומשלוחים', text, amount: pyRound(diff, 2) };
    }
  }

  // "if you cut X by 20%": the biggest variable category (average of the 3 previous months)
  let cut = null;
  const varAvg = new Map();
  const inPrev = new Set(prevMonths);
  for (const v of cx.rows) {
    if (v.neutralized || v.kind !== 'expense' || (v.flow ?? 'variable') !== 'variable' || !inPrev.has(em(v, basis))) continue;
    const c = v.category || 'ללא קטגוריה';
    if (NOT_REDUCIBLE.has(c)) continue;
    varAvg.set(c, (varAvg.get(c) ?? 0) + -v.amount);
  }
  let bestCat = null;
  for (const [c, s] of varAvg) if (bestCat === null || s > varAvg.get(bestCat)) bestCat = c;
  if (bestCat !== null && prevMonths.length) {
    const monthly = varAvg.get(bestCat) / prevMonths.length;
    const yearly = monthly * 0.2 * 12;
    if (yearly >= 100) {
      cut = { kind: 'cut20', title: 'רעיון לחיסכון',
        text: `אם תצמצמו את ההוצאות על ${bestCat} ב-20%, תחסכו כ-${money(yearly)} בשנה `
          + `(בערך ${money(monthly * 0.2)} בחודש, מתוך ממוצע של ${money(monthly)}).`,
        amount: pyRound(yearly, 2) };
    }
  }

  const out = [...doubles.slice(0, 1), ...subs.slice(0, 1), ...ups.slice(0, 2), ...(dining ? [dining] : []),
    ...(cut ? [cut] : [])];
  extra.push(...ups.slice(2), ...subs.slice(1), ...doubles.slice(1));
  while (out.length < 6 && extra.length) out.push(extra.shift());
  return out.slice(0, 6);
}

// ====================================================================== export.py: the payload
/** The compact JSON the phone renders (Python build_payload), plus `insights`. */
export function buildPayload(state, today, opts = {}) {
  ensureState(state);
  today = isoDay(today);
  const cx = makeCtx(state);
  const { basis, bankOwner, S } = cx;
  const curM = today.slice(0, 7);

  // future billing months (known card charges only) are not shown as months
  const months = monthlySummaries(cx, basis).filter((m) => m.month <= curM).slice(-18);
  const monthList = months.map((m) => ({ m: m.month, inc: pyRound(m.income, 2), exp: pyRound(m.expense, 2),
    sav: pyRound(m.saving, 2), net: pyRound(m.income - m.expense - m.saving, 2) }));
  const listed = monthList.map((x) => x.m);
  const monthCats = {};
  for (const m of [...listed.slice(-6), ...(listed.includes(curM) ? [] : [curM])]) {
    monthCats[m] = categoryTotals(cx, basis, m).slice(0, 14).map((c) => ({ c: c.category, t: c.total, col: c.color }));
  }
  const fc = forecast(cx, basis, curM, today);
  const [balDate, bal] = latestBalance(state);
  const series = balanceSeries(state, addDays(today, -180));

  const owners = [];
  for (const o of ownersOverview(state, bankOwner)) {
    const prof = profile(cx, o.name, today);
    if (!prof.data_points && !o.cards.length) continue;
    owners.push({ name: o.name, color: o.color, cards: o.cards, bank: o.is_bank_owner, profile: prof });
  }

  const since = addDays(today, -Math.trunc(Number(getPath(S, 'mobile_tx_days', 120)) || 0));
  // the lines that are not counted are listed too, marked (x): a card charge whose purchases are listed one by
  // one, a loan, money between the family's own accounts. Seeing them, and why, is what makes the totals clear.
  const txns = cx.rows.filter((v) => v.date >= since)
    .sort((a, b) => cmpStr(b.date, a.date) || b.id - a.id).slice(0, 2500).map((r) => {
      const item = { d: r.date, cd: r.charge_date, s: r.description, a: r.amount, c: r.category || '', o: r.owner, src: r.source };
      if (r.source === 'max') item.card = r.account;
      if (r.installment_total) item.i = `${pyIntStr(r.installment_no)}/${pyIntStr(r.installment_total)}`;
      if (r.pending) item.p = 1;
      if (opts.withIds) item.u = r.uid;
      if (r.neutralized || r.kind === 'internal') item.x = 1;
      const why = r.neutralized ? 'settle' : r.is_settlement ? 'undetailed' : r.kind === 'internal' ? 'internal'
        : r.category_source === 'salary' || r.category_source === 'moved' ? r.category_source : '';
      if (why) item.w = why;
      return item;
    });

  const cats = {};
  for (const c of state.categories) cats[c.name] = { k: c.kind, col: c.color };

  const recItems = recurring(cx, today);
  const plan = annualPlan(cx, basis, today, SPIKE_MIN, recItems);
  const thresholds = getPath(S, 'budget_alerts.thresholds', null);
  return {
    schema: SCHEMA, app: APP_NAME, generated_at: opts.now || `${today}T00:00:00`,
    basis, currency: 'ILS', month: curM,
    balance: { amount: bal, date: balDate },
    months: monthList, month_cats: monthCats,
    forecast: Object.fromEntries(['income_actual', 'income_forecast', 'expense_actual', 'expense_forecast',
      'saving_actual', 'saving_forecast', 'net_actual', 'net_forecast', 'end_balance', 'income_avg', 'expense_avg']
      .map((k) => [k, fc[k] ?? null])),
    forecast_rows: fc.rows.slice(0, 20),
    flow: flowSummary(cx, basis, curM, today),
    recurring: { ...recurringSummary(recItems),
      items: recItems.slice(0, 80).map((i) => ({ n: i.name, c: i.category, o: i.owner, p: i.price, d: i.change,
        s: i.status, y: i.yearly, k: i.cadence, pe: i.promo_end, id: i.key })),
      events: recurringEvents(recItems, today).map((e) => ({ id: e.id, t: e.text })).slice(0, 10) },
    planner: { provision: plan.provision, average: plan.average, this_month: plan.this_month,
      year_total: plan.year_total, enough: plan.enough_history,
      next: plan.next.map((i) => ({ n: i.what, a: i.amount, m: i.when, l: i.label })),
      months: plan.timeline.map((m) => ({ m: m.month, l: m.label, t: m.total })) },
    budget: { ...budgetStatus(cx, basis, today, fc), thresholds: pyTruthy(thresholds) ? thresholds : DEFAULT_THRESHOLDS },
    balance_series: series,
    loans: loansStatus(state, today).map((l) => ({ name: l.name, monthly: l.monthly, remaining: l.remaining,
      paid: l.paid_count, total: l.total_count, end: l.end_date, progress: pyRound(l.progress, 3), next: l.next_date })),
    owners, categories: cats, transactions: txns,
    insights: savingsInsights(cx, basis, today, recItems, owners),
  };
}
