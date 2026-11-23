'use strict';
// Ein-Klick-Backup und Wiederherstellung des kompletten Datenordners (Datenbank, Uploads, Sitzungen,
// Push-Schlüssel, Zertifikate, Spielstände). Format: .tar.gz – ohne externe Programme, nur Node-Bordmittel.
// Gedacht für: Backup herunterladen → neuere Version installieren → Backup wieder einspielen.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Writable } = require('node:stream');

const FORMAT = 'offline-chat-backup-v1';
const MARKER = '.backup-info.json';
const MAX_RESTORE = 4 * 1024 * 1024 * 1024; // 4 GB

// ---------- TAR schreiben ----------
function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }
function tarHeader(name, size, mtime, type) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let nm = name;
  if (Buffer.byteLength(nm) > 100) {
    const i = nm.lastIndexOf('/', 155);
    if (i > 0 && Buffer.byteLength(nm.slice(i + 1)) <= 100) { prefix = nm.slice(0, i); nm = nm.slice(i + 1); }
  }
  h.write(nm, 0, 100, 'utf8');
  h.write(octal(type === '5' ? 0o755 : 0o644, 8), 100);
  h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.floor(mtime / 1000), 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(octal(sum, 7) + ' ', 148); // 6 Ziffern + NUL + Leerzeichen
  h[154] = 0; h[155] = 32;
  return h;
}

async function* walk(dir, base = '') {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.name.endsWith('.tmp') || d.name === 'backups' && !base || d.name === '.restore') continue;
    if (d.isDirectory()) { yield { rel, dir: true }; yield* walk(path.join(dir, d.name), rel); }
    else if (d.isFile()) yield { rel, dir: false };
  }
}

async function* tarStream(dataDir, info) {
  const meta = Buffer.from(JSON.stringify(info));
  yield tarHeader(MARKER, meta.length, Date.now(), '0'); yield meta;
  if (meta.length % 512) yield Buffer.alloc(512 - meta.length % 512);
  for await (const e of walk(dataDir)) {
    const full = path.join(dataDir, e.rel);
    let st; try { st = await fsp.stat(full); } catch { continue; }
    if (e.dir) { yield tarHeader(e.rel + '/', 0, st.mtimeMs, '5'); continue; }
    // Dateigröße einfrieren: wächst die Datei während des Lesens, wird nur die erfasste Größe geschrieben.
    const size = st.size;
    yield tarHeader(e.rel, size, st.mtimeMs, '0');
    let sent = 0;
    const fd = await fsp.open(full, 'r');
    try {
      const buf = Buffer.allocUnsafe(256 * 1024);
      while (sent < size) {
        const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, size - sent), sent);
        if (!bytesRead) break;
        yield Buffer.from(buf.subarray(0, bytesRead)); sent += bytesRead;
      }
    } finally { await fd.close(); }
    if (sent < size) yield Buffer.alloc(size - sent); // Datei wurde währenddessen gekürzt
    if (size % 512) yield Buffer.alloc(512 - size % 512);
  }
  yield Buffer.alloc(1024);
}

// ---------- TAR lesen (streamend) ----------
function untar(destDir) {
  let hdr = Buffer.alloc(0), cur = null, done = false;
  const files = [];
  const out = new Writable({
    async write(chunk, _enc, cb) {
      try {
        let buf = chunk;
        while (buf.length && !done) {
          if (!cur) {
            hdr = Buffer.concat([hdr, buf]); buf = Buffer.alloc(0);
            if (hdr.length < 512) break;
            const h = hdr.subarray(0, 512); buf = hdr.subarray(512); hdr = Buffer.alloc(0);
            if (h.every(b => b === 0)) { done = true; break; }
            const name = (h.toString('utf8', 345, 500).replace(/\0.*$/, '') ? h.toString('utf8', 345, 500).replace(/\0.*$/, '') + '/' : '') + h.toString('utf8', 0, 100).replace(/\0.*$/, '');
            const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
            const type = String.fromCharCode(h[156] || 48);
            const safe = path.normalize(name).replace(/^([/\\])+/, '');
            if (safe.startsWith('..') || path.isAbsolute(safe) || safe.split(path.sep).includes('..')) throw new Error('Ungültiger Pfad im Backup: ' + name);
            if (type === '5') { await fsp.mkdir(path.join(destDir, safe), { recursive: true }); continue; }
            if (type !== '0' && type !== '\0') { cur = { skip: true, left: size, pad: (512 - size % 512) % 512 }; continue; }
            const full = path.join(destDir, safe);
            await fsp.mkdir(path.dirname(full), { recursive: true });
            cur = { name: safe, left: size, pad: (512 - size % 512) % 512, fh: await fsp.open(full, 'w') };
            files.push(safe);
            if (size === 0) { await cur.fh.close(); if (!cur.pad) cur = null; else cur.left = 0; }
            continue;
          }
          if (cur.left > 0) {
            const n = Math.min(cur.left, buf.length);
            if (!cur.skip) await cur.fh.write(buf, 0, n);
            cur.left -= n; buf = buf.subarray(n);
            if (cur.left === 0 && !cur.skip) await cur.fh.close();
          }
          if (cur.left === 0) {
            const n = Math.min(cur.pad, buf.length); cur.pad -= n; buf = buf.subarray(n);
            if (cur.pad === 0) cur = null;
          }
        }
        cb();
      } catch (e) { cb(e); }
    },
    async final(cb) { try { if (cur && cur.fh) await cur.fh.close().catch(() => {}); cb(); } catch (e) { cb(e); } }
  });
  out.files = files;
  return out;
}

async function rmrf(p) { await fsp.rm(p, { recursive: true, force: true }); }
async function dirSize(dir) { let n = 0; for await (const e of walk(dir)) if (!e.dir) { try { n += (await fsp.stat(path.join(dir, e.rel))).size; } catch {} } return n; }

// Neue Daten in den Datenordner übernehmen; alte Dateien kommen vorher in <DATA>/backups/vor-wiederherstellung-<zeit>
async function applyRestore(dataDir, stage) {
  const safetyDir = path.join(dataDir, 'backups');
  await fsp.mkdir(safetyDir, { recursive: true });
  const safety = path.join(safetyDir, 'vor-wiederherstellung-' + new Date().toISOString().replace(/[:.]/g, '-') + '.tar.gz');
  try {
    await pipeline(Readable.from(tarStream(dataDir, { format: FORMAT, createdAt: Date.now(), reason: 'safety' })), zlib.createGzip({ level: 3 }), fs.createWriteStream(safety));
  } catch (e) { try { await fsp.unlink(safety); } catch {} throw new Error('Sicherheitskopie des aktuellen Stands fehlgeschlagen: ' + e.message); }
  // alte Inhalte entfernen (außer backups/ und Staging)
  for (const d of await fsp.readdir(dataDir)) {
    if (d === 'backups' || d === '.restore') continue;
    await rmrf(path.join(dataDir, d));
  }
  for (const d of await fsp.readdir(stage)) {
    if (d === MARKER || d === 'backups') continue;
    await fsp.rename(path.join(stage, d), path.join(dataDir, d));
  }
  return safety;
}

/**
 * ctx = { DATA, userCount(), isAdmin(user), reload(), version }
 * Gibt true zurück, wenn die Anfrage behandelt wurde.
 */
function handle(req, res, url, user, ctx) {
  const p = url.pathname;
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (!p.startsWith('/api/backup')) return false;
  const fresh = ctx.userCount() === 0; // frische Installation: Wiederherstellung ohne Konto erlaubt
  const allowed = ctx.isAdmin(user) || (fresh && p === '/api/backup/restore' && req.method === 'POST');
  if (!allowed) { json(user ? 403 : 401, { error: user ? 'Nur Administratoren dürfen Backups erstellen oder einspielen.' : 'Bitte anmelden.' }); return true; }

  if (req.method === 'GET' && p === '/api/backup/list') {
    const dir = path.join(ctx.DATA, 'backups');
    let items = []; try { items = fs.readdirSync(dir).filter(f => f.endsWith('.tar.gz')).map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at); } catch {}
    json(200, { items }); return true;
  }
  if (req.method === 'GET' && p === '/api/backup/download') {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const info = { format: FORMAT, createdAt: Date.now(), app: 'Offline Chat', version: ctx.version || '', users: ctx.userCount() };
    if (ctx.flush) ctx.flush(); // ausstehende Schreibvorgänge sichern
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="OfflineChat-Backup-${stamp}.tar.gz"`, 'Cache-Control': 'no-store' });
    pipeline(Readable.from(tarStream(ctx.DATA, info)), zlib.createGzip({ level: 6 }), res).catch(e => { console.error('Backup:', e.message); try { res.destroy(); } catch {} });
    return true;
  }
  if (req.method === 'GET' && p.startsWith('/api/backup/file/')) {
    const name = path.basename(decodeURIComponent(p.slice('/api/backup/file/'.length)));
    const full = path.join(ctx.DATA, 'backups', name);
    if (!name.endsWith('.tar.gz') || !fs.existsSync(full)) { json(404, { error: 'Nicht gefunden.' }); return true; }
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"` });
    fs.createReadStream(full).pipe(res); return true;
  }
  if (req.method === 'POST' && p === '/api/backup/restore') {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_RESTORE) { json(413, { error: 'Backup-Datei ist zu groß.' }); return true; }
    const stage = path.join(ctx.DATA, '.restore');
    (async () => {
      try {
        await rmrf(stage); await fsp.mkdir(stage, { recursive: true });
        // Hochgeladene Bytes direkt entpacken (kein Zwischenspeichern der ganzen Datei nötig)
        const ut = untar(stage);
        await pipeline(req, zlib.createGunzip(), ut);
        const infoPath = path.join(stage, MARKER);
        let info; try { info = JSON.parse(await fsp.readFile(infoPath, 'utf8')); } catch {}
        if (!info || info.format !== FORMAT) throw new Error('Das ist kein gültiges Offline-Chat-Backup.');
        let dbOk = false;
        try { const d = JSON.parse(await fsp.readFile(path.join(stage, 'database.json'), 'utf8')); dbOk = Array.isArray(d.users) && Array.isArray(d.rooms); } catch {}
        if (!dbOk) throw new Error('Die Datenbank im Backup ist unlesbar oder unvollständig.');
        if (ctx.beforeRestore) ctx.beforeRestore();
        const safety = await applyRestore(ctx.DATA, stage);
        await rmrf(stage);
        const summary = ctx.reload();
        json(200, { ok: true, restoredFiles: ut.files.length, createdAt: info.createdAt, users: summary && summary.users, safetyCopy: path.basename(safety) });
      } catch (e) {
        await rmrf(stage).catch(() => {});
        if (!res.headersSent) json(400, { error: e.message || 'Wiederherstellung fehlgeschlagen.' });
      }
    })();
    return true;
  }
  json(404, { error: 'Unbekannte Backup-Funktion.' });
  return true;
}

// Beim ersten Start einer neuen Programmversion automatisch eine Komplettsicherung des alten Stands anlegen.
async function autoOnUpgrade(dataDir, version) {
  const vf = path.join(dataDir, '.app-version');
  let prev = ''; try { prev = fs.readFileSync(vf, 'utf8').trim(); } catch {}
  if (prev === version) return;
  if (prev && fs.existsSync(path.join(dataDir, 'database.json'))) {
    const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `vor-update-${prev}-auf-${version}-${new Date().toISOString().slice(0, 10)}.tar.gz`);
    await pipeline(Readable.from(tarStream(dataDir, { format: FORMAT, createdAt: Date.now(), reason: 'upgrade', from: prev, to: version })), zlib.createGzip({ level: 3 }), fs.createWriteStream(f));
    // nur die letzten 3 Update-Sicherungen behalten
    const old = fs.readdirSync(dir).filter(x => x.startsWith('vor-update-')).sort();
    for (const x of old.slice(0, -3)) try { fs.unlinkSync(path.join(dir, x)); } catch {}
  }
  fs.writeFileSync(vf, version);
}

module.exports = { autoOnUpgrade, handle, tarStream, untar, FORMAT, MARKER };
