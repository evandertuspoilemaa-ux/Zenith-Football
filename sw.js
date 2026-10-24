/* Zenith Football League - service worker
 *
 * What it does
 *  1. Makes the app installable and able to open offline.
 *  2. Serves the "uploaded update" (an HTML file you uploaded inside the app) instead of the
 *     built-in index.html, so you can update the installed app without redeploying or reinstalling.
 *  3. Protects you from a broken update: if an uploaded version fails to start 3 times in a row,
 *     it is automatically replaced by the previous version (or the built-in one).
 *
 * Your game data is NOT touched here. It lives in localStorage, which belongs to the site and
 * survives every update.
 *
 * Recovery: opening the site with ?safe=1 at the end of the address (in a normal browser tab)
 * always loads the built-in version, whatever has been uploaded.
 */
const SHELL_CACHE  = 'zenith-shell-v1';       // bump this number if you ever change the files listed below
const UPDATE_CACHE = 'zenith-user-update';    // uploaded updates + safety copies. NEVER deleted automatically.
const FONT_CACHE   = 'zenith-fonts-v1';
const SHELL = [
  'index.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/favicon-64.png'
];
const MAX_FAILS = 3;

const scopeUrl = (p) => new URL(p, self.registration.scope).href;
const K_CUR  = () => scopeUrl('__zenith/current.html');
const K_PREV = () => scopeUrl('__zenith/previous.html');
const K_META = () => scopeUrl('__zenith/meta.json');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(async (p) => {
      try { await cache.put(scopeUrl(p), await fetch(new Request(scopeUrl(p), { cache: 'reload' }))); }
      catch (e) { if (p === 'index.html') throw e; }   // index.html is required, icons are best-effort
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only old SHELL caches are removed. The uploaded update + backups are never touched.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('zenith-shell-') && n !== SHELL_CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function readMeta() {
  try { const c = await caches.open(UPDATE_CACHE); const r = await c.match(K_META()); return r ? await r.json() : {}; }
  catch (e) { return {}; }
}
async function writeMeta(m) {
  const c = await caches.open(UPDATE_CACHE);
  await c.put(K_META(), new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
}

async function autoRollback(meta) {
  const c = await caches.open(UPDATE_CACHE);
  const bad = meta.cur || {};
  const prev = meta.prev ? await c.match(K_PREV()) : null;
  if (prev) {
    await c.put(K_CUR(), prev);
    meta.cur = Object.assign({}, meta.prev, { pending: false, fails: 0 });
    meta.prev = null;
    await c.delete(K_PREV());
  } else {
    await c.delete(K_CUR());
    meta.cur = null;
  }
  meta.event = { type: 'auto-rollback', name: bad.name || 'update', ts: Date.now() };
  await writeMeta(meta);
}

async function builtIn(event) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(scopeUrl('index.html'));
  if (hit) {
    // refresh the built-in copy in the background (picks up a redeploy on the next launch)
    event.waitUntil((async () => {
      try { const r = await fetch(new Request(scopeUrl('index.html'), { cache: 'no-cache' })); if (r && r.ok) await cache.put(scopeUrl('index.html'), r); }
      catch (e) {}
    })());
    return hit;
  }
  try { return await fetch(event.request); }
  catch (e) { return new Response('Zenith is offline and has no saved copy yet. Open it once while online.', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
}

async function handleNavigate(event) {
  const url = new URL(event.request.url);
  if (url.searchParams.has('safe') || url.searchParams.has('builtin')) return builtIn(event);
  try {
    const meta = await readMeta();
    if (meta && meta.cur) {
      if (meta.cur.pending) {                         // a freshly uploaded version that has not proven itself yet
        meta.cur.fails = (meta.cur.fails || 0) + 1;
        if (meta.cur.fails >= MAX_FAILS) await autoRollback(meta); else await writeMeta(meta);
      }
      if (meta.cur) {
        const c = await caches.open(UPDATE_CACHE);
        const r = await c.match(K_CUR());
        if (r) return r;
      }
    }
  } catch (e) { /* fall through to the built-in version */ }
  return builtIn(event);
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request, { ignoreSearch: cacheName === SHELL_CACHE });
  const net = fetch(event.request).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(event.request, r.clone()); return r; }).catch(() => null);
  if (hit) { event.waitUntil(net); return hit; }
  return (await net) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin) { event.respondWith(handleNavigate(event)); return; }
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf('/__zenith/') >= 0) return;               // internal storage keys are never served
    if (SHELL.some(p => scopeUrl(p) === url.origin + url.pathname)) { event.respondWith(staleWhileRevalidate(event, SHELL_CACHE)); }
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') event.respondWith(staleWhileRevalidate(event, FONT_CACHE));
});
