/* FinPal Family - heavy work off the screen thread: reading bank files and replaying the family's events. */
import { parseFile } from './lib/parsers.js';
import * as E from './lib/engine.js';
import { replay } from './lib/replay.js';

self.onmessage = async ({ data }) => {
  const { id, cmd } = data || {};
  try {
    let out;
    if (cmd === 'parse') out = await parseFile(data.name, new Uint8Array(data.bytes), { password: data.password || '' });
    else if (cmd === 'replay') out = await replay(E, data.events, data.today, data.names);
    else if (cmd === 'categories') out = typeof E.categoryList === 'function' ? E.categoryList() : [];
    else throw new Error('unknown command ' + cmd);
    self.postMessage({ id, ok: true, out });
  } catch (e) {
    self.postMessage({ id, ok: false, err: String((e && e.message) || e) });
  }
};
