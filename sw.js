/* FinPal Family - service worker: the app opens without network, and files shared from the Android share
   sheet ("שיתוף" -> FinPal) are kept until the app takes them. The asset list and version are written by
   tools/build.py. */
const VERSION = '1.1.0-d55e42a3d8';
const ASSETS = ["app.js", "config.js", "fonts/IBMPlexSansHebrew-Medium.ttf", "fonts/IBMPlexSansHebrew-Regular.ttf", "fonts/IBMPlexSansHebrew-SemiBold.ttf", "fonts/OFL-IBMPlexSansHebrew.txt", "guide.html", "guide.js", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-96.png", "icons/maskable-192.png", "icons/maskable-512.png", "index.html", "lib/crypto.js", "lib/drive.js", "lib/engine.js", "lib/family.js", "lib/parsers.js", "lib/pdf.js", "lib/replay.js", "lib/store.js", "lib/vendor/fflate.js", "manifest.webmanifest", "privacy.html", "styles.css", "ui/flows.js", "ui/kit.js", "ui/views.js", "version.json", "worker.js"];
const CACHE = 'finpal-family-' + VERSION;
// pdf.js (for statements saved as PDF) is big and changes rarely: kept in its own cache when first used,
// not downloaded again with every new version of the app
const PDFJS = 'finpal-pdfjs-6.5.438';
const BASE = self.registration.scope;
const MAX_SHARE = 50 * 1024 * 1024;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(BASE + a, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if ((k.startsWith('finpal-family-') && k !== CACHE) || (k.startsWith('finpal-pdfjs-') && k !== PDFJS)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  if (event.data === 'version' && event.source) event.source.postMessage({ version: VERSION });
});

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('finpal-family', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function keepShared(items) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite'), st = t.objectStore('kv');
    const g = st.get('inbox');
    g.onsuccess = () => st.put((g.result || []).concat(items).slice(-30), 'inbox');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
}

async function onShare(request) {
  try {
    const form = await request.formData();
    const items = [];
    for (const f of form.getAll('files')) {
      if (!f || typeof f.arrayBuffer !== 'function' || f.size > MAX_SHARE || items.length >= 20) continue;
      items.push({ name: String(f.name || 'file').slice(0, 200), type: String(f.type || ''), bytes: await f.arrayBuffer(), at: Date.now() });
    }
    if (items.length) await keepShared(items);
    return Response.redirect(BASE + '?share=' + items.length, 303);
  } catch (e) {
    return Response.redirect(BASE + '?share=error', 303);
  }
}

self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google sign-in and Drive go straight to the network
  if (req.method === 'POST' && url.href.split('?')[0] === BASE + 'share') { event.respondWith(onShare(req)); return; }
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    // the app's own pages (the guide, the privacy page) open as themselves; anything else in the scope is the app
    event.respondWith((async () => {
      const page = /\.html$/.test(url.pathname) && !/\/index\.html$/.test(url.pathname);
      if (/\.[a-z0-9]+$/i.test(url.pathname) && !/\.html$/.test(url.pathname)) return fetch(req); // a download (the APK)
      if (page) {
        const hit = await caches.match(url.origin + url.pathname, { ignoreSearch: true });
        if (hit) return hit;
        try { return await fetch(req); } catch (e) { /* offline: the app instead */ }
      }
      return (await caches.match(BASE + 'index.html', { ignoreSearch: true })) || fetch(req);
    })());
    return;
  }
  if (url.pathname.includes('/lib/vendor/pdfjs/')) {
    event.respondWith((async () => {
      const c = await caches.open(PDFJS);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await c.put(req, res.clone());
      return res;
    })());
    return;
  }
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});
