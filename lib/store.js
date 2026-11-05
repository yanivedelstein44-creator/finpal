/* FinPal Family - storage on this phone (IndexedDB). Values that hold family data are sealed with the
   device key before they are written; the device key itself is a non-extractable WebCrypto key. */
import { newDeviceKey, sealLocal, openLocal } from './crypto.js';

const DB_NAME = 'finpal-family', STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); dbp = null; };
      resolve(d);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => reject(new Error('storage blocked'));
  });
  return dbp;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
    let out;
    const r = fn(st);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}

export const raw = {
  get: k => tx('readonly', st => st.get(k)),
  set: (k, v) => tx('readwrite', st => st.put(v, k)),
  del: k => tx('readwrite', st => st.delete(k)),
  clear: () => tx('readwrite', st => st.clear())
};

let devKey = null;
async function deviceKey() {
  if (devKey) return devKey;
  let k = await raw.get('deviceKey');
  if (!k) { k = await newDeviceKey(); await raw.set('deviceKey', k); }
  devKey = k;
  return k;
}

/** sealed values: what the family data layer uses */
export const store = {
  async get(k) {
    const rec = await raw.get('s:' + k);
    if (!rec) return null;
    try { return await openLocal(await deviceKey(), rec); } catch (e) { return null; }
  },
  async set(k, v) { return raw.set('s:' + k, await sealLocal(await deviceKey(), v)); },
  del: k => raw.del('s:' + k),
  async wipe() { devKey = null; await raw.clear(); }
};

/** files shared to the app (Android share sheet) wait here until the app picks them up */
export const inbox = {
  async take() {
    const items = (await raw.get('inbox')) || [];
    if (items.length) await raw.del('inbox');
    return items;
  }
};

export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* ignore */ }
  return false;
}
