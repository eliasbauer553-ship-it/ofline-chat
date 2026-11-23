'use strict';
// Spielstände pro Konto auf dem Server (Autosave für alle Spiele). Liegt im Datenordner und ist damit im Backup enthalten.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function createGameData({ DATA }) {
  const DIR = path.join(DATA, 'gamedata');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  const MAX_GAME = 900 * 1024, MAX_BODY = 1.2 * 1024 * 1024;
  const file = uid => path.join(DIR, String(uid).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  const load = uid => { try { return JSON.parse(fs.readFileSync(file(uid), 'utf8')); } catch { return { games: {} }; } };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  function handle(req, res, url, user) {
    if (url.pathname !== '/api/gamedata') return false;
    if (!user) { json(res, 401, { error: 'Bitte anmelden.' }); return true; }
    if (req.method === 'GET') { json(res, 200, load(user.id)); return true; }
    if (req.method === 'PUT') {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const gid = String(b.game || ''); if (!/^[a-z0-9_-]{1,32}$/.test(gid)) throw new Error('Ungültiges Spiel.');
          const keys = {}; let total = 0;
          for (const [k, v] of Object.entries(b.keys || {})) {
            if (typeof k !== 'string' || typeof v !== 'string' || k.length > 120) continue;
            total += k.length + v.length; keys[k] = v;
          }
          if (total > MAX_GAME) throw new Error('Spielstand ist zu groß.');
          const d = load(user.id); const at = Date.now();
          d.games = d.games || {}; d.games[gid] = { at, keys };
          const tmp = file(user.id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, file(user.id));
          json(res, 200, { ok: true, at });
        } catch (e) { json(res, 400, { error: e.message || 'Ungültige Daten.' }); }
      });
      return true;
    }
    json(res, 405, { error: 'Nicht erlaubt.' }); return true;
  }
  return { handle };
};
