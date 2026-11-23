'use strict';
// Dokumentenspeicher für Office-Apps (Text, Tabellen, Folien …): versioniert, mit Raumfreigabe und Konflikterkennung.
// Die Office-Apps unter public/apps/<id>/ nutzen ihn über window.parent.OCAPP.docs. Alles liegt in <DATA>/docs und ist im Backup enthalten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
module.exports = function createDocs(ctx) {
  const DIR = path.join(ctx.DATA, 'docs');
  fs.mkdirSync(DIR, { recursive: true });
  const MAX_CONTENT = 6 * 1024 * 1024, MAX_BODY = 8 * 1024 * 1024, KEEP = 20;
  const TYPES = /^[a-z0-9_-]{1,24}$/;
  const fileOf = id => path.join(DIR, id + '.json');
  const idOk = id => /^[0-9a-f-]{36}$/.test(id);
  const read = id => { try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; } };
  const write = d => { const t = fileOf(d.meta.id) + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, fileOf(d.meta.id)); };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const canUse = (user, m) => m.ownerId === user.id || (m.roomId && ctx.canAccess(user.id, m.roomId));
  function body(req, res, cb) {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { json(res, 413, { error: 'Dokument ist zu groß.' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'Ungültige Daten.' }); } try { cb(b); } catch (e) { json(res, 400, { error: e.message }); } });
  }
  const notify = (m, extra) => {
    const msg = { type: 'docChanged', id: m.id, doc: m.type, title: m.title, version: m.version, by: extra.by, roomId: m.roomId || null, deleted: !!extra.deleted };
    if (m.roomId) ctx.broadcast(msg, m.roomId); else ctx.toUser(m.ownerId, msg);
  };
  function handle(req, res, url, user) {
    if (!url.pathname.startsWith('/api/docs')) return false;
    if (!user) { json(res, 401, { error: 'Bitte anmelden.' }); return true; }
    const parts = url.pathname.split('/').filter(Boolean); // api docs [id] [share]
    const id = parts[2], sub = parts[3];
    if (!id) {
      if (req.method === 'GET') {
        const room = url.searchParams.get('room'), type = url.searchParams.get('type');
        const out = [];
        for (const f of fs.readdirSync(DIR)) {
          if (!f.endsWith('.json')) continue;
          const d = read(f.slice(0, -5)); if (!d) continue; const m = d.meta;
          if (type && m.type !== type) continue;
          if (room ? m.roomId !== room || !ctx.canAccess(user.id, room) : !canUse(user, m)) continue;
          out.push(m);
        }
        out.sort((a, b) => b.updatedAt - a.updatedAt); json(res, 200, { docs: out }); return true;
      }
      if (req.method === 'POST') {
        body(req, res, b => {
          const type = String(b.type || 'doc'); if (!TYPES.test(type)) throw new Error('Ungültiger Dokumenttyp.');
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''); if (content.length > MAX_CONTENT) throw new Error('Dokument ist zu groß.');
          const roomId = b.roomId ? String(b.roomId) : null; if (roomId && !ctx.canAccess(user.id, roomId)) throw new Error('Kein Zugriff auf diesen Raum.');
          const now = Date.now(), meta = { id: crypto.randomUUID(), type, title: String(b.title || 'Ohne Titel').slice(0, 120), ownerId: user.id, ownerName: user.displayName, roomId, version: 1, createdAt: now, updatedAt: now, size: content.length };
          write({ meta, content, history: [] }); notify(meta, { by: user.displayName }); json(res, 200, { meta });
        }); return true;
      }
      json(res, 405, { error: 'Nicht erlaubt.' }); return true;
    }
    if (!idOk(id)) { json(res, 404, { error: 'Dokument nicht gefunden.' }); return true; }
    const d = read(id);
    if (!d || !canUse(user, d.meta)) { json(res, 404, { error: 'Dokument nicht gefunden.' }); return true; }
    if (sub === 'share' && req.method === 'POST') {
      body(req, res, b => {
        const roomId = String(b.roomId || ''); if (!ctx.canAccess(user.id, roomId)) throw new Error('Kein Zugriff auf diesen Raum.');
        d.meta.roomId = roomId; d.meta.updatedAt = Date.now(); write(d);
        ctx.announce(roomId, user.displayName + ' hat „' + d.meta.title + '“ geteilt: ' + (b.link || ''), 'Office');
        notify(d.meta, { by: user.displayName }); json(res, 200, { meta: d.meta });
      }); return true;
    }
    if (sub === 'history' && req.method === 'GET') { json(res, 200, { history: (d.history || []).map(h => ({ v: h.v, at: h.at, by: h.by, size: h.content.length })) }); return true; }
    if (sub === 'history' && req.method === 'POST') {
      body(req, res, b => { const h = (d.history || []).find(x => x.v === Number(b.v)); if (!h) throw new Error('Version nicht gefunden.'); json(res, 200, { v: h.v, content: h.content }); }); return true;
    }
    if (req.method === 'GET') { json(res, 200, { meta: d.meta, content: d.content }); return true; }
    if (req.method === 'PUT') {
      body(req, res, b => {
        if (Number(b.baseVersion) !== d.meta.version) return json(res, 409, { error: 'Das Dokument wurde inzwischen geändert.', meta: d.meta, content: d.content });
        const content = b.content === undefined ? d.content : (typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
        if (content.length > MAX_CONTENT) throw new Error('Dokument ist zu groß.');
        d.history = d.history || []; d.history.push({ v: d.meta.version, at: d.meta.updatedAt, by: d.meta.lastEditor || d.meta.ownerName, content: d.content });
        while (d.history.length > KEEP) d.history.shift();
        d.content = content; d.meta.version++; d.meta.updatedAt = Date.now(); d.meta.size = content.length; d.meta.lastEditor = user.displayName;
        if (b.title) d.meta.title = String(b.title).slice(0, 120);
        write(d); notify(d.meta, { by: user.displayName }); json(res, 200, { ok: true, meta: d.meta });
      }); return true;
    }
    if (req.method === 'DELETE') {
      if (d.meta.ownerId !== user.id) { json(res, 403, { error: 'Nur der Besitzer kann löschen.' }); return true; }
      try { fs.unlinkSync(fileOf(id)); } catch {} notify(d.meta, { by: user.displayName, deleted: true }); json(res, 200, { ok: true }); return true;
    }
    json(res, 405, { error: 'Nicht erlaubt.' }); return true;
  }
  return { handle };
};
