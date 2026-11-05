/* FinPal Family - the family's shared data.

   Every change (an imported file, a card's owner, a category fix, a goal) is an event. Each partner keeps
   their own events in their own Google Drive file, encrypted with the household key. Both phones read both
   files, merge the events and replay them through the engine, so both show exactly the same numbers.
   Nothing is ever overwritten by the other phone: a file has one writer, events are only added.

   The app may be open twice on one phone (the installed app and a Chrome tab share the same storage), so
   every write first merges what the other window may have saved, and saving to Drive takes a lock. */
import { deflateSync, inflateSync, strToU8, strFromU8 } from './vendor/fflate.js';
import * as C from './crypto.js';
import * as D from './drive.js';

export const SHARED = 'משותף';
const MAX_EVENTS = 20000;
const EVENT_TYPES = new Set(['name', 'import', 'import_del', 'owner', 'category', 'recnote', 'goal', 'partner_file']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function newId() { return 'e' + C.b64u(C.randomBytes(9)); }

export function sortEvents(list) {
  return list.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const str = (v, max) => typeof v === 'string' && v.length <= (max || 300) && !BAD_KEYS.has(v);
const roleOk = r => r === 'A' || r === 'B';
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const NOTE_KEYS = new Set(['promo_end', 'promo_price', 'note', 'muted']);

function noteOk(n) {
  if (!plain(n)) return false;
  for (const k of Object.keys(n)) if (!NOTE_KEYS.has(k)) return false;
  if (n.promo_end != null && !(n.promo_end === '' || (typeof n.promo_end === 'string' && /^\d{4}-\d\d-\d\d$/.test(n.promo_end)))) return false;
  if (n.promo_price != null && !(typeof n.promo_price === 'number' && isFinite(n.promo_price) && n.promo_price >= 0 && n.promo_price < 1e7)) return false;
  if (n.note != null && !str(n.note, 500)) return false;
  if (n.muted != null && typeof n.muted !== 'boolean') return false;
  return true;
}

/** the data on this phone was deleted or replaced in another window of the app: this window must start over */
export class HouseholdGone extends Error {
  constructor() { super('household gone'); this.name = 'HouseholdGone'; }
}

/** an event from a file is data from outside: only the known shapes pass */
export function validEvent(e, by) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (typeof e.id !== 'string' || !/^e[A-Za-z0-9_-]{6,30}$/.test(e.id)) return false;
  if (typeof e.ts !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.ts)) return false;
  if (!EVENT_TYPES.has(e.t) || !roleOk(e.by) || (by && e.by !== by)) return false;
  switch (e.t) {
    case 'name': return roleOk(e.role) && str(e.name, 40);
    case 'import': return str(e.name, 300) && (e.kind === 'leumi' || e.kind === 'max') && str(e.sha, 128)
      && Array.isArray(e.txns) && e.txns.length <= 100000 && e.txns.every(plain)
      && (e.warnings == null || (Array.isArray(e.warnings) && e.warnings.length <= 50 && e.warnings.every(w => typeof w === 'string')));
    case 'import_del': return str(e.sha, 128);
    case 'owner': return str(e.card, 40) && (roleOk(e.owner) || e.owner === 'shared');
    case 'category': return Array.isArray(e.uids) && e.uids.length <= 5000 && e.uids.every(u => str(u, 100)) && str(e.category, 80);
    case 'recnote': return str(e.key, 300) && noteOk(e.note);
    case 'goal': return typeof e.amount === 'number' && isFinite(e.amount) && e.amount >= 0 && e.amount < 1e9;
    case 'partner_file': return str(e.fid, 200);
    default: return false;
  }
}

export function pack(obj) { return deflateSync(strToU8(JSON.stringify(obj)), { level: 6 }); }

export function unpack(bytes) {
  let out;
  try { out = JSON.parse(strFromU8(inflateSync(bytes))); } catch (e) { throw new C.CryptoError('format', 'bad content'); }
  if (!out || out.v !== 1 || !Array.isArray(out.events)) throw new C.CryptoError('format', 'bad content');
  return out;
}

function unionEvents(a, b) {
  const seen = new Map();
  for (const e of a || []) seen.set(e.id, e);
  for (const e of b || []) if (!seen.has(e.id)) seen.set(e.id, e);
  return sortEvents([...seen.values()]);
}

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** one writer at a time across the windows of this phone (the Web Locks API where there is one) */
function withLock(name, fn) {
  const locks = globalThis.navigator && globalThis.navigator.locks;
  if (locks && typeof locks.request === 'function') return locks.request(name, fn);
  return fn();
}

export class Family {
  constructor({ store, drive, now } = {}) {
    this.store = store;
    this.drive = drive || D;
    this.now = now || (() => new Date());
    this.cfg = null;
    this._cfgBase = null;
    this.mine = { events: [], dirty: false };
    this.theirs = { events: [] };
    this._hh = null;
  }

  async load() {
    const before = this.cfg && this.cfg.recovery;
    this.cfg = await this.store.get('cfg');
    this._cfgBase = clone(this.cfg);
    this.mine = (await this.store.get('mine')) || { events: [], dirty: false };
    this.theirs = (await this.store.get('theirs')) || { events: [] };
    if (!this.cfg || this.cfg.recovery !== before) this._hh = null; // the key is slow to derive: keep it when it is the same
    return !!this.cfg;
  }

  get ready() { return !!(this.cfg && this.cfg.recovery); }
  get role() { return this.cfg && this.cfg.role; }
  get other() { return this.role === 'A' ? 'B' : 'A'; }

  async hh() {
    if (!this._hh) this._hh = await C.household(this.cfg.recovery);
    return this._hh;
  }

  // ------------------------------------------------------------------ saving, merged with the other window
  /** settings: what this window changed since it read them wins, the rest is taken as stored */
  async saveCfg() {
    const stored = await this.store.get('cfg');
    let merged = this.cfg;
    if (stored && this._cfgBase && stored.recovery === this.cfg.recovery) {
      merged = Object.assign({}, stored);
      for (const k of Object.keys(this.cfg)) if (!same(this.cfg[k], this._cfgBase[k])) merged[k] = this.cfg[k];
    }
    this.cfg = merged;
    this._cfgBase = clone(merged);
    await this.store.set('cfg', merged);
  }

  async saveMine() {
    const stored = await this.store.get('mine');
    if (stored && stored.events) {
      const n = this.mine.events.length;
      this.mine.events = unionEvents(stored.events, this.mine.events);
      if (this.mine.events.length !== n || stored.dirty) this.mine.dirty = true;
    }
    await this.store.set('mine', this.mine);
  }

  async saveTheirs() {
    const stored = await this.store.get('theirs');
    if (stored && stored.events) this.theirs.events = unionEvents(stored.events, this.theirs.events);
    await this.store.set('theirs', this.theirs);
  }

  /** take in what another window of the app saved, before acting on it */
  async fresh() {
    if (!this.cfg) return;
    const cfg = await this.store.get('cfg'), mine = await this.store.get('mine'), theirs = await this.store.get('theirs');
    // deleted from the phone, or another family set up, in another window: never write the old one back
    if (this._cfgBase && (!cfg || cfg.recovery !== this.cfg.recovery)) throw new HouseholdGone();
    if (cfg && cfg.recovery === this.cfg.recovery) {
      const local = {};
      for (const k of Object.keys(this.cfg)) if (!same(this.cfg[k], this._cfgBase && this._cfgBase[k])) local[k] = this.cfg[k];
      this.cfg = Object.assign({}, cfg, local);
      this._cfgBase = clone(cfg);
    }
    if (mine && mine.events) {
      const n = this.mine.events.length;
      this.mine.events = unionEvents(mine.events, this.mine.events);
      if (mine.dirty || this.mine.events.length !== n) this.mine.dirty = true;
      if (mine.pushedAt && (!this.mine.pushedAt || mine.pushedAt > this.mine.pushedAt)) this.mine.pushedAt = mine.pushedAt;
    }
    if (theirs && theirs.events) {
      this.theirs.events = unionEvents(theirs.events, this.theirs.events);
      if (theirs.pulledAt && (!this.theirs.pulledAt || theirs.pulledAt > this.theirs.pulledAt)) this.theirs.pulledAt = theirs.pulledAt;
    }
  }

  /** names of both partners: the latest name event wins, so a name typed at setup can be fixed later */
  names() {
    const n = { A: '', B: '' };
    if (this.cfg) {
      n[this.role] = this.cfg.myName || '';
      n[this.other] = this.cfg.partnerName || '';
    }
    for (const e of this.events()) if (e.t === 'name' && roleOk(e.role) && e.name) n[e.role] = e.name;
    return n;
  }

  events() { return unionEvents(this.mine.events, this.theirs.events); }

  async eventsKey() {
    return C.sha256Hex(this.events().map(e => e.id).join(','));
  }

  /** a clock that runs behind must not put a new change before what it answers: every new event is later
      than any event this phone has seen (both partners'), whatever the phone's clock says */
  stamp() {
    const now = this.now();
    // a time far in the future (a broken clock on the other phone) is not followed: it would carry every
    // later change of this phone with it
    const cap = new Date(now.getTime() + 7 * 864e5).toISOString();
    let last = '';
    for (const list of [this.mine.events, this.theirs.events]) for (const e of list) if (e.ts > last && e.ts <= cap) last = e.ts;
    let ts = now.toISOString();
    if (last && ts <= last) ts = new Date(Date.parse(last) + 1).toISOString();
    return ts;
  }

  async add(ev) {
    if (!this.ready) throw new Error('no household');
    await this.fresh();
    const e = Object.assign({}, ev, { id: newId(), ts: this.stamp(), by: this.role });
    if (!validEvent(e)) throw new Error('bad event ' + ev.t);
    if (this.mine.events.length >= MAX_EVENTS) throw new Error('too many events');
    this.mine.events.push(e);
    this.mine.dirty = true;
    await this.saveMine();
    return e;
  }

  // ------------------------------------------------------------------ starting a household
  async _start(cfg) {
    this.cfg = cfg;
    this.mine = { events: [], dirty: false };
    this.theirs = { events: [] };
    this._hh = null;
    await this.store.set('cfg', cfg);
    this._cfgBase = clone(cfg);
    await this.store.set('mine', this.mine);
    await this.store.set('theirs', this.theirs);
  }

  async create({ myName, partnerName, clientId, apiKey }) {
    const recovery = C.newRecoveryCode();
    await this._start({
      v: 1, role: 'A', recovery, myName: myName.trim(), partnerName: partnerName.trim(),
      clientId: (clientId || '').trim(), apiKey: (apiKey || '').trim(), myFileId: '', shared: false, partnerFileId: '',
      partnerKnowsMine: false, email: '', createdAt: this.now().toISOString()
    });
    await this.add({ t: 'name', role: 'A', name: this.cfg.myName });
    if (this.cfg.partnerName) await this.add({ t: 'name', role: 'B', name: this.cfg.partnerName });
    return C.groupCode(recovery);
  }

  async join(inv, code, myName) { return this.joinWith(await C.openInvite(inv, code), inv, myName); }

  /** the invite was already opened with its code (the slow step); now become the second partner */
  async joinWith(recovery, inv, myName) {
    await this._start({
      v: 1, role: 'B', recovery, myName: (myName || inv.p || '').trim(), partnerName: inv.n || '',
      clientId: inv.cid || '', apiKey: inv.ak || '', myFileId: '', shared: false, partnerFileId: inv.f || '',
      partnerKnowsMine: false, email: '', createdAt: this.now().toISOString()
    });
    if (this.cfg.myName && this.cfg.myName !== inv.p) await this.add({ t: 'name', role: 'B', name: this.cfg.myName });
    if (this.cfg.partnerFileId) await this.add({ t: 'partner_file', fid: this.cfg.partnerFileId });
  }

  /** recovery code + Google sign-in: find this account's file and continue from it.
      Returns null (nothing found), {ask: [{role, name}]} when the account holds both partners' files and
      the person must say who they are, or {role, names}. */
  async restore(recovery, { clientId, apiKey }, tok, wantRole) {
    const hh = await C.household(recovery);
    const files = await this.drive.findFiles(tok, hh.hid);
    const found = [];
    for (const f of files) {
      let opened, data;
      try { opened = await C.openFile(hh, await this.drive.readOwn(tok, f.id)); data = unpack(opened.bytes); } catch (e) { continue; }
      if (found.some(x => x.role === opened.by)) continue; // newest first: keep the newest file of each partner
      found.push({ role: opened.by, file: f, events: sortEvents(data.events.filter(e => validEvent(e, opened.by))), name: data.name || '' });
    }
    if (!found.length) return null;
    const names = { A: '', B: '' };
    for (const x of found) for (const e of x.events) if (e.t === 'name') names[e.role] = e.name;
    if (!wantRole && found.length > 1) return { ask: found.map(x => ({ role: x.role, name: names[x.role] || x.name })) };
    const pick = found.find(x => x.role === wantRole) || found[0];
    const role = pick.role, other = role === 'A' ? 'B' : 'A';
    let partnerFileId = '';
    for (const e of pick.events) if (e.t === 'partner_file' && e.fid) partnerFileId = e.fid;
    const otherHere = found.find(x => x.role === other);
    if (otherHere) partnerFileId = otherHere.file.id;
    await this._start({
      v: 1, role, recovery: C.normCode(recovery), myName: names[role] || pick.name || '', partnerName: names[other] || '',
      clientId, apiKey, myFileId: pick.file.id, shared: false, partnerFileId, partnerKnowsMine: role === 'A',
      email: '', createdAt: this.now().toISOString()
    });
    this._hh = hh;
    this.mine = { events: pick.events, dirty: false, pushedAt: this.now().toISOString() };
    this.theirs = { events: otherHere ? otherHere.events : [] };
    await this.store.set('mine', this.mine);
    await this.store.set('theirs', this.theirs);
    return { role, names };
  }

  // ------------------------------------------------------------------ Drive
  async sealMine(events) {
    const hh = await this.hh();
    return C.sealFile(hh, this.role, pack({ v: 1, by: this.role, name: this.cfg.myName, at: this.now().toISOString(), events: events || this.mine.events }));
  }

  async readFile(text, expectBy) {
    const opened = await C.openFile(await this.hh(), text);
    if (expectBy && opened.by !== expectBy) throw new C.CryptoError('format', 'file of the wrong partner');
    const data = unpack(opened.bytes);
    return data.events.filter(e => validEvent(e, opened.by));
  }

  /** read the partner's file (no sign-in needed): returns true when something new arrived */
  async pull() {
    if (!this.ready || !this.cfg.partnerFileId) return false;
    if (!this.cfg.apiKey) throw new D.DriveError('apikey', 0, 'no api key');
    const text = await this.drive.readShared(this.cfg.partnerFileId, this.cfg.apiKey);
    const incoming = await this.readFile(text, this.other);
    await this.fresh();
    const before = this.theirs.events.length;
    this.theirs.events = unionEvents(this.theirs.events, incoming);
    this.theirs.pulledAt = this.now().toISOString();
    await this.saveTheirs();
    // the partner's log says which file of ours they read: once it is the current one, no reminder is needed
    if (this.cfg.myFileId && this.theirs.events.some(e => e.t === 'partner_file' && e.fid === this.cfg.myFileId)
      && (!this.cfg.partnerKnowsMine || this.cfg.needsRelink)) {
      this.cfg.partnerKnowsMine = true;
      this.cfg.needsRelink = false;
      await this.saveCfg();
    }
    return this.theirs.events.length !== before;
  }

  /** write our own events to our own Drive file (creates and shares it the first time) */
  async push(tok) {
    if (!this.ready) return false;
    if (!tok) throw new D.DriveError('auth', 401, 'not signed in');
    return withLock('finpal-family-push', () => this._push(tok));
  }

  async _push(tok) {
    await this.fresh();
    const hh = await this.hh();
    const hadFile = this.cfg.myFileId;
    if (!this.cfg.myFileId) {
      // reinstalled app, a lost answer from Drive, or a second try after a failure: our file may be there
      const found = (await this.drive.findFiles(tok, hh.hid)).filter(f => (f.appProperties || {}).finpal_role === this.role);
      if (found.length) { this.cfg.myFileId = found[0].id; this.cfg.shared = false; await this.saveCfg(); }
    }
    let replaced = false;
    if (this.cfg.myFileId) {
      // read-merge-write: never drop events that only the Drive copy has
      try {
        const remote = await this.readFile(await this.drive.readOwn(tok, this.cfg.myFileId), this.role);
        const merged = unionEvents(this.mine.events, remote);
        if (merged.length !== this.mine.events.length) { this.mine.events = merged; await this.saveMine(); }
      } catch (e) {
        if (e instanceof D.DriveError && e.kind === 'missing') {
          // our file is gone (deleted, or another Google account): a new one is made, and the partner must hear
          replaced = true;
          this.cfg.myFileId = '';
          this.cfg.shared = false;
          await this.saveCfg();
        } else if (e instanceof D.DriveError) throw e;
        // a damaged or foreign file is replaced by ours
      }
    }
    const sent = this.mine.events.slice();
    const text = await this.sealMine(sent);
    if (this.cfg.myFileId) {
      await this.drive.updateFile(tok, this.cfg.myFileId, text);
    } else {
      const name = `FinPal (מוצפן, לא למחוק) ${this.role === 'A' ? '1' : '2'}`;
      const id = await this.drive.createFile(tok, { name, appProperties: { finpal: '1', finpal_hid: hh.hid, finpal_role: this.role }, text });
      this.cfg.myFileId = id;
      this.cfg.shared = false;
      if (replaced || (hadFile && hadFile !== id)) {
        // the other phone may still read the old file: until it gets a new connect link, keep reminding
        this.cfg.partnerKnowsMine = false;
        if (this.role === 'A' && (this.cfg.partnerFileId || this.cfg.invitedAt)) this.cfg.needsRelink = true;
      }
      await this.saveCfg();
    }
    if (!this.cfg.shared) {
      // shared by link until it works: a failure here (network, policy) is retried on the next save
      await this.drive.shareByLink(tok, this.cfg.myFileId);
      this.cfg.shared = true;
      await this.saveCfg();
    }
    // a change made meanwhile (in this window or another) is not in the file yet: it stays "to save"
    const ids = new Set(sent.map(e => e.id));
    const stored = await this.store.get('mine');
    this.mine.events = unionEvents(stored && stored.events, this.mine.events);
    this.mine.dirty = this.mine.events.some(e => !ids.has(e.id));
    this.mine.pushedAt = this.now().toISOString();
    await this.store.set('mine', this.mine);
    return true;
  }

  // ------------------------------------------------------------------ links
  async invite(base) {
    if (this.role !== 'A') throw new Error('only the first partner invites');
    if (!this.cfg.myFileId || !this.cfg.shared) throw new D.DriveError('nofile', 0, 'save to Drive first');
    const names = this.names();
    const { code, payload } = await C.makeInvite(this.cfg.recovery, {
      fromName: names.A, toName: names.B, clientId: this.cfg.clientId, apiKey: this.cfg.apiKey, fileId: this.cfg.myFileId
    });
    await this.setConfig({ invitedAt: this.now().toISOString(), needsRelink: false }); // a new invite carries the current file
    return { code, link: `${base}#join=${payload}` };
  }

  /** either partner can send it: "read my file here" (the second partner's first save, or a file made anew) */
  async connectLink(base) {
    if (!this.cfg.myFileId || !this.cfg.shared) throw new D.DriveError('nofile', 0, 'save to Drive first');
    return `${base}#connect=${await C.connectPayload(await this.hh(), this.cfg.myFileId, this.cfg.myName, this.role)}`;
  }

  /** the link to the new file was sent: the first partner's reminder ends here (the second partner's ends
      when the first phone's log shows it reads her file) */
  async connectSent() {
    if (this.role === 'A' && this.cfg.needsRelink) await this.setConfig({ needsRelink: false });
  }

  async acceptConnect(payload) {
    const { fileId, by } = await C.readConnect(await this.hh(), payload);
    if (fileId === this.cfg.myFileId || (by && by === this.role)) throw new C.CryptoError('own', 'own link');
    await this.fresh();
    const changed = this.cfg.partnerFileId !== fileId;
    this.cfg.partnerFileId = fileId;
    await this.saveCfg();
    if (changed) await this.add({ t: 'partner_file', fid: fileId });
    return changed;
  }

  async setConfig(fields) {
    await this.fresh();
    Object.assign(this.cfg, fields);
    await this.saveCfg();
  }
}
