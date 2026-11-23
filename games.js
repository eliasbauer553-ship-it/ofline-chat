'use strict';
// Spiele-Modul für den Offline Chat (v6.2)
//  - liefert alles unter /games/ aus (Ordner-Index, MIME-Typen, Range für Audio/Video, ETag-Cache)
//  - stellt die kleine Server-Schnittstelle für Hofkönig bereit (/games/hofkoenig/api/*):
//    Cloud-Spielstand (mit Revisionsprüfung, Sicherung), Serverzeit, Bestenliste
// Neue Spiele: Ordner public/games/<name>/ mit index.html anlegen und in public/games/games.json eintragen.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.fnt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
};
const REVALIDATE = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.webmanifest', '.fnt', '.xml']);

module.exports = function createGames({ PUBLIC, DATA, currentUser }) {
  const GAMES = path.join(PUBLIC, 'games');
  const HK = path.join(DATA, 'hofkoenig');
  const HK_SAVES = path.join(HK, 'saves'), HK_BAKS = path.join(HK, 'baks'), HK_LB = path.join(HK, 'lb.json');
  try { fs.mkdirSync(HK_SAVES, { recursive: true }); fs.mkdirSync(HK_BAKS, { recursive: true }); } catch {}

  // ---------- Hilfsfunktionen ----------
  const hdr = (extra = {}) => ({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'x-server-time': String(Date.now()), ...extra });
  const json = (res, code, obj) => { res.writeHead(code, hdr()); res.end(JSON.stringify(obj)); };
  const plain = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const writeJson = (f, o) => { const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; } parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---------- Statische Dateien ----------
  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return plain(res, 400, 'Ungültiger Pfad.'); }
    let target = path.resolve(PUBLIC, '.' + rel);
    if (target !== GAMES && !target.startsWith(GAMES + path.sep)) return plain(res, 403, 'Verboten.');
    let st;
    try { st = fs.statSync(target); } catch { return plain(res, 404, 'Nicht gefunden.'); }
    if (st.isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search, 'Cache-Control': 'no-store' }); return res.end(); }
      target = path.join(target, 'index.html');
      try { st = fs.statSync(target); } catch { return plain(res, 404, 'Nicht gefunden.'); }
    }
    if (!st.isFile()) return plain(res, 404, 'Nicht gefunden.');
    const ext = path.extname(target).toLowerCase();
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const base = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': REVALIDATE.has(ext) && !/\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|css)$/.test(url.pathname) ? 'no-cache' : 'public, max-age=604800',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      code = 206; base['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    base['Content-Length'] = String(end - start + 1);
    res.writeHead(code, base);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const rs = fs.createReadStream(target, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  }

  // ---------- Hofkönig: Spielstände, Serverzeit, Bestenliste ----------
  const ID_RE = /^[A-Za-z0-9-]{16,64}$/;
  const MAX_SAVE = 1024 * 1024, NUM_MAX = 1e300;
  const hid = id => crypto.createHash('sha256').update('hk' + id).digest('hex').slice(0, 16);
  const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  function validateSave(body) {
    let o; try { o = JSON.parse(body); } catch { return { error: 'bad json' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'bad shape' };
    if (!Array.isArray(o.plots) || (o.plots.length !== 100 && o.plots.length !== 36)) return { error: 'bad plots' };
    if (typeof o.total !== 'number' || typeof o.money !== 'number' || typeof o.level !== 'number') return { error: 'bad types' };
    if (!Number.isFinite(o.total) || o.total < 0 || o.total > NUM_MAX) return { error: 'bad total' };
    if (!Number.isFinite(o.money) || o.money < 0 || o.money > NUM_MAX) return { error: 'bad money' };
    if (!Number.isFinite(o.level) || o.level < 1 || o.level > 999) return { error: 'bad level' };
    const ct = Number(o.t);
    return { ok: true, total: o.total, ct: Number.isFinite(ct) ? ct : 0 };
  }
  const conflictBody = r => ({ error: 'conflict', rev: r.rev, ts: r.ts, total: r.total, data: r.data });
  const publicBoard = (list, h) => {
    const sorted = [...list].sort((a, b) => b.s - a.s);
    const i = h ? sorted.findIndex(x => x.h === h) : -1;
    const me = i >= 0 ? { rank: i + 1, s: sorted[i].s, claimed: sorted[i].s, pending: false } : null;
    return { top: sorted.slice(0, 100).map(x => ({ n: x.n, s: x.s, me: x.h === h })), me, now: Date.now() };
  };

  async function hofkoenigApi(req, res, url) {
    const sub = url.pathname.slice('/games/hofkoenig/api'.length);   // z. B. /save
    if (!currentUser(req)) return json(res, 401, { error: 'Bitte im Chat anmelden.' });
    try {
      if (sub === '/time' && req.method === 'GET') return json(res, 200, { now: Date.now() });

      if (sub === '/save') {
        const id = url.searchParams.get('id') || '';
        if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
        const f = path.join(HK_SAVES, id + '.json'), fb = path.join(HK_BAKS, id + '.json');
        if (req.method === 'GET') {
          const v = readJson(url.searchParams.get('bak') ? fb : f);
          if (!v) return json(res, 404, { error: 'none' });
          return json(res, 200, { rev: v.rev || 1, ts: v.ts || 0, total: v.total || 0, data: v.data });
        }
        if (req.method !== 'PUT') return json(res, 405, { error: 'method' });
        const body = await readBody(req, MAX_SAVE);
        const chk = validateSave(body);
        if (!chk.ok) return json(res, 400, { error: chk.error });
        const now = Date.now(), force = url.searchParams.get('force') === '1', base = Number(url.searchParams.get('base') || 0);
        const old = readJson(f), oldRev = old ? old.rev : 0;
        if (old && !force && base !== oldRev) return json(res, 409, conflictBody(old));
        if (old) {   // vorherigen Stand höchstens alle 10 Minuten (oder bei erzwungenem Überschreiben / Rückschritt) sichern
          const prev = readJson(fb);
          if (force || old.total > chk.total || !prev || now - prev.ts > 600000) writeJson(fb, old);
        }
        writeJson(f, { rev: oldRev + 1, ts: now, ct: chk.ct, total: chk.total, data: body });
        return json(res, 200, { ok: true, rev: oldRev + 1, ts: now, total: chk.total });
      }

      if (sub === '/lb') {
        let list = readJson(HK_LB) || [];
        if (req.method === 'GET') return json(res, 200, publicBoard(list, null));
        if (req.method === 'POST') {
          let b; try { b = JSON.parse(await readBody(req, 4000)); } catch { return json(res, 400, { error: 'bad json' }); }
          const id = String(b.id || ''), name = cleanName(b.name);
          if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
          if (name.length < 2) return json(res, 400, { error: 'name' });
          const sv = readJson(path.join(HK_SAVES, id + '.json'));
          if (!sv) return json(res, 400, { error: 'nosave' });
          const h = hid(id);
          if (list.some(x => x.h !== h && String(x.n).toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'taken' });
          const cur = list.find(x => x.h === h);
          if (cur) { cur.n = name; cur.s = Math.max(cur.s, sv.total); cur.t = Date.now(); }
          else list.push({ h, n: name, s: sv.total, t: Date.now() });
          list = list.sort((a, b) => b.s - a.s).slice(0, 100);
          writeJson(HK_LB, list);
          return json(res, 200, publicBoard(list, h));
        }
        return json(res, 405, { error: 'method' });
      }

      if (sub.startsWith('/combat/')) return json(res, 503, { error: 'Der Kampfmodus braucht den Cloudflare-Server und ist im Offline Chat nicht verfügbar.' });
      return json(res, 404, { error: 'unbekannt' });
    } catch (e) {
      if (e && e.code === 413) return json(res, 413, { error: 'too large' });
      return json(res, 500, { error: 'server', detail: String(e && e.message || e).slice(0, 120) });
    }
  }

  // Gibt true zurück, wenn die Anfrage hier bearbeitet wurde.
  function handle(req, res, url) {
    if (url.pathname !== '/games' && !url.pathname.startsWith('/games/')) return false;
    if (url.pathname === '/games') { res.writeHead(301, { Location: '/games/games.json' }); res.end(); return true; }
    if (url.pathname.startsWith('/games/hofkoenig/api/')) { hofkoenigApi(req, res, url); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { plain(res, 405, 'Nur GET.'); return true; }
    serveStatic(req, res, url);
    return true;
  }
  return { handle };
};
