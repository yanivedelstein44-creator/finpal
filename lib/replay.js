/* FinPal Family - replay the merged events through the engine: the same events on both phones give the
   same state, so both partners always see the same numbers.

   Imports that follow each other with nothing in between are given to the engine together (one ingest
   with several files, like importing them in one go on the desktop): the engine then post-processes once
   instead of after every file, which keeps years of monthly imports fast. */
import { sortEvents, SHARED } from './family.js';

export function ownerName(names, o) {
  if (o === 'A' || o === 'B') return names[o] || (o === 'A' ? 'שותף א' : 'שותף ב');
  if (o === 'shared' || !o) return SHARED;
  return String(o);
}

const call = (E, fn, ...args) => (typeof E[fn] === 'function' ? E[fn](...args) : undefined);

export async function replay(E, events, today, names) {
  const st = E.newState();
  const ev = sortEvents(events);
  // a removal takes away the imports of that file made before it; the same file imported again later counts
  const lastDel = new Map();
  ev.forEach((e, i) => { if (e.t === 'import_del') lastDel.set(e.sha, i); });
  const imports = [], problems = [];
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const run = batch;
    batch = [];
    try {
      const files = run.map(({ e }) => ({ name: e.name, kind: e.kind, txns: e.txns || [], warnings: e.warnings || [], error: null, sha256: e.sha }));
      const res = await E.ingest(st, files, run[run.length - 1].e.ts.slice(0, 10));
      const out = (res && res.files) || [];
      run.forEach(({ rec }, i) => {
        const f = out[i] || {};
        Object.assign(rec, { status: f.status || 'ok', added: f.added || 0, dup: f.dup || 0, updated: f.updated || 0, message: f.message || '' });
      });
    } catch (err) {
      for (const { e, rec } of run) { rec.status = 'error'; problems.push({ id: e.id, t: e.t, error: String((err && err.message) || err) }); }
    }
  };

  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.t === 'import') {
      // the list keeps the order of the events; the engine's answer fills it in when the batch runs
      const rec = { id: e.id, by: e.by, ts: e.ts, name: e.name, kind: e.kind, sha: e.sha, count: (e.txns || []).length, status: 'removed' };
      imports.push(rec);
      if (!(lastDel.get(e.sha) > i)) batch.push({ e, rec });
      continue;
    }
    if (!['owner', 'category', 'recnote'].includes(e.t)) continue; // names, goals, links, removals: not for the engine
    await flush();
    try {
      if (e.t === 'owner') await call(E, 'setCardOwner', st, e.card, ownerName(names, e.owner));
      else if (e.t === 'category') await call(E, 'setCategory', st, e.uids || [], e.category, !!e.learn);
      else if (e.t === 'recnote') await call(E, 'setRecurringNote', st, e.key, e.note || {});
    } catch (err) {
      problems.push({ id: e.id, t: e.t, error: String((err && err.message) || err) });
    }
  }
  await flush();
  await E.postProcess(st, today);
  const payload = await E.buildPayload(st, today, { withIds: true });
  const cards = (await call(E, 'listCards', st)) || [];
  return { payload, cards, imports, problems };
}
