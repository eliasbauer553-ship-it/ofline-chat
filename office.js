'use strict';
// Office-Modul für den Offline Chat (v6.3)
//  - Tabellen (Univer Sheets), Dokumente (Univer Docs), Folien (eigener Editor)
//  - Speicherung: Metadaten in db.office, Inhalte als Dateien in DATA/office/ (database.json bleibt klein)
//  - Rechte = Raumrechte (canAccess); stumme Nutzer dürfen nur lesen
//  - Verknüpfungen: Referenzen [[office:<id>]], Rückverweise, Tabelle <-> Board, Tabelle <-> Kalender, Notizen -> Dokument
//  - Ausgeliefert wird /office/ (vorkomprimierte .gz-Dateien, ETag), API unter /api/office/*
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KINDS = ['sheet', 'doc', 'slide'];
const MAX_BODY = 25 * 1024 * 1024;
const MAX_NODES_PER_ROOM = 300;
const MAX_VERSIONS = 20;
const VERSION_GAP = 2 * 60 * 1000;
const TRASH_DAYS = 30;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

module.exports = function createOffice({ PUBLIC, DATA, currentUser, getDb, saveDb, canAccess, can, broadcast, rateOk }) {
  const OFFICE_PUBLIC = path.join(PUBLIC, 'office');
  const STORE = path.join(DATA, 'office');
  try { fs.mkdirSync(STORE, { recursive: true }); } catch {}

  // ---------- Hilfsfunktionen ----------
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const writeJson = (f, o) => { const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
  const dbo = () => { const db = getDb(); db.office = db.office || {}; db.office.nodes = db.office.nodes || {}; db.office.links = db.office.links || []; return db.office; };
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; } parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }
  async function body(req, limit = 2 * 1024 * 1024) { try { return JSON.parse((await readBody(req, limit)) || '{}'); } catch (e) { if (e && e.code === 413) throw e; return null; } }
  const fileOf = id => path.join(STORE, id + '.json');
  const verDir = id => path.join(STORE, id);
  const room = id => getDb().rooms.find(r => r.id === id);
  const nameOf = uid => getDb().users.find(u => u.id === uid)?.displayName || 'Unbekannt';
  const audit = (user, text) => { const db = getDb(); db.audit = db.audit || []; db.audit.push({ at: Date.now(), by: user.displayName, text }); if (db.audit.length > 500) db.audit.shift(); };
  const meta = n => ({ id: n.id, kind: n.kind, title: n.title, roomId: n.roomId, ownerId: n.ownerId, owner: nameOf(n.ownerId), rev: n.rev, created: n.created, updated: n.updated, updatedBy: n.updatedBy ? nameOf(n.updatedBy) : '', trashed: n.trashed || 0 });
  function nodeFor(user, id, needWrite) {
    if (!ID_RE.test(String(id || ''))) return { err: [400, 'Ungültige ID.'] };
    const n = dbo().nodes[id];
    if (!n) return { err: [404, 'Nicht gefunden.'] };
    if (!canAccess(user.id, n.roomId)) return { err: [404, 'Nicht gefunden.'] };
    if (needWrite && user.muted) return { err: [403, 'Du bist stummgeschaltet.'] };
    return { n };
  }
  const canManage = (user, n) => user.role === 'admin' || n.ownerId === user.id || can(user.id, room(n.roomId)?.serverId, 'moderate');

  // ---------- Leere Vorlagen ----------
  function uid() { return crypto.randomUUID(); }
  function makeSheet(rows, title) {
    const cellData = {}; let cols = 0;
    (rows || []).forEach((r, i) => { cellData[i] = {}; r.forEach((v, j) => { if (v !== '' && v != null) cellData[i][j] = { v }; cols = Math.max(cols, j + 1); }); });
    const sid = 'sheet-01';
    return { id: uid(), name: title || 'Tabelle', appVersion: '3.0.0-alpha', locale: 'deDE', styles: {}, sheetOrder: [sid],
      sheets: { [sid]: { id: sid, name: 'Tabelle1', rowCount: Math.max(100, (rows || []).length + 50), columnCount: Math.max(20, cols + 5), cellData } } };
  }
  function makeDoc(paras, title) {
    const list = (paras && paras.length ? paras : ['']).map(s => String(s).replace(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '));
    let ds = '', pr = [];
    for (const p of list) { ds += p; pr.push({ startIndex: ds.length }); ds += '\r'; }
    ds += '\n';
    return { id: uid(), title: title || 'Dokument', documentStyle: {}, body: { dataStream: ds, textRuns: [], paragraphs: pr, sectionBreaks: [{ startIndex: ds.length - 1 }] } };
  }
  function makeSlides(title) {
    return { v: 1, w: 1280, h: 720, slides: [{ id: uid(), bg: '#ffffff', notes: '', objs: [
      { id: uid(), t: 'text', x: 90, y: 230, w: 1100, h: 120, text: title || 'Titel', fs: 64, bold: 1, color: '#1f2430', align: 'left' },
      { id: uid(), t: 'text', x: 90, y: 370, w: 1100, h: 60, text: 'Untertitel', fs: 30, color: '#667085', align: 'left' }] }] };
  }

  // ---------- Textauszug (Suche, Verknüpfungen) ----------
  function sheetSheets(snap) { const s = snap && snap.sheets ? snap.sheets : {}; const order = Array.isArray(snap && snap.sheetOrder) && snap.sheetOrder.length ? snap.sheetOrder : Object.keys(s); return order.map(k => s[k]).filter(Boolean); }
  function cellText(c) { if (!c) return ''; const v = c.v != null ? c.v : (c.p && c.p.body && c.p.body.dataStream) || ''; return String(v).replace(/[\r\n]+/g, ' '); }
  function sheetRows(snap, idx = 0) {
    const sh = sheetSheets(snap)[idx]; if (!sh || !sh.cellData) return [];
    const rows = []; let maxC = 0;
    const keys = Object.keys(sh.cellData).map(Number).sort((a, b) => a - b);
    for (const r of keys) { for (const c of Object.keys(sh.cellData[r] || {})) maxC = Math.max(maxC, Number(c) + 1); }
    for (const r of keys) { const row = new Array(maxC).fill(''); const cd = sh.cellData[r] || {}; for (const c of Object.keys(cd)) { const cell = cd[c]; row[Number(c)] = cell && cell.v != null ? cell.v : cellText(cell); } rows[r] = row; }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = new Array(maxC).fill('');
    return rows;
  }
  function extractText(kind, data) {
    try {
      if (kind === 'sheet') { const out = []; for (const sh of sheetSheets(data)) { out.push(sh.name || ''); for (const r of Object.values(sh.cellData || {})) for (const c of Object.values(r || {})) { const t = cellText(c); if (t) out.push(t); } } return out.join(' ').slice(0, 200000); }
      if (kind === 'doc') return String((data.body && data.body.dataStream) || '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 200000);
      if (kind === 'slide') return (data.slides || []).map(s => (s.objs || []).map(o => o.text || '').join(' ') + ' ' + (s.notes || '')).join(' ').replace(/\s+/g, ' ').slice(0, 200000);
    } catch {}
    return '';
  }
  const textIdx = new Map();
  function indexNode(n, data) { textIdx.set(n.id, extractText(n.kind, data || readJson(fileOf(n.id))).toLowerCase()); }
  function reindexAll() { for (const n of Object.values(dbo().nodes)) { try { indexNode(n); } catch {} } }

  // ---------- Verknüpfungen ----------
  const REF_RE = /\[\[office:([a-f0-9-]{36})(?:#([^\]\s]{1,40}))?\]\]/g;
  function scanRefs(kind, data) {
    const text = kind === 'doc' ? String((data.body && data.body.dataStream) || '') : extractText(kind, data);
    const out = new Set(); let m; REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text))) out.add(m[1]);
    return [...out];
  }
  function setRefLinks(n, data) {
    const o = dbo();
    o.links = o.links.filter(l => !(l.from === 'office:' + n.id && l.kind === 'ref'));
    for (const t of scanRefs(n.kind, data)) if (t !== n.id && o.nodes[t]) o.links.push({ from: 'office:' + n.id, to: 'office:' + t, kind: 'ref', at: Date.now() });
  }
  function addLink(from, to, kind) {
    const o = dbo(); if (o.links.some(l => l.from === from && l.to === to && l.kind === kind)) return;
    o.links.push({ from: clip(from, 120), to: clip(to, 120), kind: clip(kind, 20), at: Date.now() }); if (o.links.length > 5000) o.links.shift();
  }

  // ---------- Presence ----------
  const presence = new Map(); // id -> Map(userId -> ts)
  function touch(id, uidv, open) { let m = presence.get(id); if (!m) presence.set(id, m = new Map()); if (open === false) m.delete(uidv); else m.set(uidv, Date.now()); }
  function editors(id, except) { const m = presence.get(id); if (!m) return []; const now = Date.now(), out = []; for (const [u, t] of m) { if (now - t > 45000) { m.delete(u); continue; } if (u !== except) out.push({ id: u, name: nameOf(u) }); } return out; }

  // ---------- Versionen ----------
  function pushVersion(n, oldData) {
    try {
      const d = verDir(n.id); fs.mkdirSync(d, { recursive: true });
      const list = fs.readdirSync(d).filter(f => /^v\d+\.json$/.test(f)).map(f => ({ f, rev: Number(f.slice(1, -5)) })).sort((a, b) => a.rev - b.rev);
      const last = list.length ? fs.statSync(path.join(d, list[list.length - 1].f)).mtimeMs : 0;
      if (Date.now() - last < VERSION_GAP) return;
      writeJson(path.join(d, 'v' + n.rev + '.json'), oldData);
      list.push({ f: 'v' + n.rev + '.json', rev: n.rev });
      while (list.length > MAX_VERSIONS) { try { fs.unlinkSync(path.join(d, list.shift().f)); } catch {} }
    } catch {}
  }
  function listVersions(id) { try { const d = verDir(id); return fs.readdirSync(d).filter(f => /^v\d+\.json$/.test(f)).map(f => ({ rev: Number(f.slice(1, -5)), at: Math.round(fs.statSync(path.join(d, f)).mtimeMs) })).sort((a, b) => b.rev - a.rev); } catch { return []; } }

  // ---------- Anlegen / Speichern ----------
  function createNode(user, roomId, kind, title, data) {
    const o = dbo(); const n = { id: uid(), kind, title: clip(title, 80).trim() || ({ sheet: 'Neue Tabelle', doc: 'Neues Dokument', slide: 'Neue Präsentation' })[kind], roomId, ownerId: user.id, rev: 1, created: Date.now(), updated: Date.now(), updatedBy: user.id };
    if (data == null) data = kind === 'sheet' ? makeSheet([[]], n.title) : kind === 'doc' ? makeDoc([''], n.title) : makeSlides(n.title);
    if (kind === 'sheet' || kind === 'doc') { data.id = n.id; if (kind === 'doc') data.title = n.title; else data.name = n.title; }
    o.nodes[n.id] = n; writeJson(fileOf(n.id), data); indexNode(n, data); setRefLinks(n, data); saveDb();
    audit(user, `Office: „${n.title}“ (${kind}) angelegt`);
    broadcast({ type: 'office', op: 'create', roomId, id: n.id, by: user.id }, roomId);
    return n;
  }
  function validData(kind, d) {
    if (!d || typeof d !== 'object') return false;
    if (kind === 'sheet') return d.sheets && typeof d.sheets === 'object';
    if (kind === 'doc') return d.body && typeof d.body.dataStream === 'string';
    if (kind === 'slide') return Array.isArray(d.slides);
    return false;
  }
  function saveNode(user, n, data, quiet) {
    const old = readJson(fileOf(n.id));
    if (old) pushVersion(n, old);
    n.rev += 1; n.updated = Date.now(); n.updatedBy = user.id;
    writeJson(fileOf(n.id), data); indexNode(n, data); setRefLinks(n, data); saveDb();
    if (!quiet) broadcast({ type: 'office', op: 'update', roomId: n.roomId, id: n.id, rev: n.rev, by: user.id }, n.roomId);
  }

  // ---------- Tabelle <-> Board / Kalender ----------
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 20000 && v < 90000) return Math.round((v - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 9), +(m[5] || 0)).getTime();
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1], +(m[4] || 9), +(m[5] || 0)).getTime(); }
    return null;
  }
  function sheetToBoard(user, n, data, opt) {
    const db = getDb(); const rows = sheetRows(data, Number(opt.sheet) || 0);
    const hdr = opt.header === false ? 0 : 1;
    const tc = Number(opt.titleCol) || 0, sc = opt.statusCol === '' || opt.statusCol == null ? -1 : Number(opt.statusCol);
    const mk = t => ({ id: uid(), title: t, cards: [] });
    if (!Array.isArray(db.boards[n.roomId]) || !db.boards[n.roomId].length) db.boards[n.roomId] = [mk('Offen'), mk('In Arbeit'), mk('Erledigt')];
    const cols = db.boards[n.roomId]; let added = 0, moved = 0, skipped = 0;
    const find = t => cols.find(c => c.title.toLowerCase() === String(t || '').trim().toLowerCase());
    for (let i = hdr; i < rows.length; i++) {
      const r = rows[i] || []; const text = clip(r[tc], 200).trim(); if (!text) continue;
      const link = 'office:' + n.id + '#r' + (i + 1);
      const target = (sc >= 0 && find(r[sc])) || cols[0];
      let from = null, card = null;
      for (const c of cols) { const k = c.cards.find(x => x.link === link); if (k) { from = c; card = k; break; } }
      if (!card) for (const c of cols) { const k = c.cards.find(x => !x.link && x.text === text); if (k) { from = c; card = k; k.link = link; break; } }
      if (card) { if (sc >= 0 && from !== target && target.cards.length < 60) { from.cards.splice(from.cards.indexOf(card), 1); target.cards.push(card); moved++; } else skipped++; continue; }
      if (target.cards.length >= 60) { skipped++; continue; }
      target.cards.push({ id: uid(), text, by: user.displayName, link }); added++;
    }
    saveDb(); broadcast({ type: 'board', roomId: n.roomId, cols }, n.roomId);
    addLink('office:' + n.id, 'board:' + n.roomId, 'board');
    return { added, moved, skipped };
  }
  function boardToRows(roomId) {
    const cols = getDb().boards[roomId] || []; const rows = [['Aufgabe', 'Status', 'Von']];
    for (const c of cols) for (const k of c.cards) rows.push([k.text, c.title, k.by || '']);
    return rows;
  }
  function sheetToEvents(user, n, data, opt) {
    const db = getDb(); const rows = sheetRows(data, Number(opt.sheet) || 0); const hdr = opt.header === false ? 0 : 1;
    const tc = Number(opt.titleCol) || 0, dc = Number(opt.dateCol) || 0; let added = 0, updated = 0, past = 0;
    for (let i = hdr; i < rows.length; i++) {
      const r = rows[i] || []; const title = clip(r[tc], 80).trim(); const at = parseDate(r[dc]); if (!title || at == null) continue;
      if (at <= Date.now()) { past++; continue; }
      const link = 'office:' + n.id + '#r' + (i + 1); const ex = db.events.find(e => e.link === link);
      if (ex) { if (ex.at !== at || ex.title !== title) { ex.at = at; ex.title = title; ex.r15 = 0; ex.r0 = 0; updated++; } continue; }
      if (db.events.length >= 200) break;
      db.events.push({ id: uid(), roomId: n.roomId, title, at, by: user.id, link }); added++;
    }
    saveDb(); broadcast({ type: 'events', roomId: n.roomId, list: db.events.filter(e => e.roomId === n.roomId) }, n.roomId);
    addLink('office:' + n.id, 'cal:' + n.roomId, 'calendar');
    return { added, updated, past };
  }

  // ---------- Suche ----------
  function search(user, q) {
    q = String(q || '').trim().toLowerCase().slice(0, 100); if (q.length < 2) return [];
    const out = [];
    for (const n of Object.values(dbo().nodes)) {
      if (n.trashed || !canAccess(user.id, n.roomId)) continue;
      const t = textIdx.get(n.id) || ''; const inTitle = n.title.toLowerCase().includes(q); const at = t.indexOf(q);
      if (!inTitle && at < 0) continue;
      let snip = ''; if (at >= 0) { const raw = extractText(n.kind, readJson(fileOf(n.id))); const i = raw.toLowerCase().indexOf(q); snip = raw.slice(Math.max(0, i - 40), i + 80).trim(); }
      out.push({ ...meta(n), snippet: snip, score: inTitle ? 2 : 1 });
    }
    return out.sort((a, b) => b.score - a.score || b.updated - a.updated).slice(0, 30);
  }

  // ---------- Statische Dateien (/office/) ----------
  function serveStatic(req, res, url) {
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    let target = path.resolve(PUBLIC, '.' + rel);
    if (target !== OFFICE_PUBLIC && !target.startsWith(OFFICE_PUBLIC + path.sep)) { res.writeHead(403); return res.end('Verboten.'); }
    let st; try { st = fs.statSync(target); } catch { res.writeHead(404); return res.end('Nicht gefunden.'); }
    if (st.isDirectory()) { target = path.join(target, 'editor.html'); try { st = fs.statSync(target); } catch { res.writeHead(404); return res.end('Nicht gefunden.'); } }
    const ext = path.extname(target).toLowerCase();
    const gz = (req.headers['accept-encoding'] || '').includes('gzip') && fs.existsSync(target + '.gz');
    const file = gz ? target + '.gz' : target; const fst = gz ? fs.statSync(file) : st;
    const etag = '"' + fst.size.toString(16) + '-' + Math.round(fst.mtimeMs).toString(16) + (gz ? 'z' : '') + '"';
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'ETag': etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
    if (gz) h['Content-Encoding'] = 'gzip';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
    h['Content-Length'] = fst.size; res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ---------- API ----------
  async function api(req, res, url) {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Bitte anmelden.' });
    const p = url.pathname.slice('/api/office'.length) || '/'; const m = req.method;
    const o = dbo();
    try {
      if (m === 'GET' && p === '/list') {
        const rid = url.searchParams.get('roomId'); const trash = url.searchParams.get('trash') === '1';
        const list = Object.values(o.nodes).filter(n => (!rid || n.roomId === rid) && !!n.trashed === trash && canAccess(user.id, n.roomId)).sort((a, b) => b.updated - a.updated).map(meta);
        return json(res, 200, { list });
      }
      if (m === 'GET' && p === '/search') return json(res, 200, { results: search(user, url.searchParams.get('q')) });
      if (m === 'GET' && p.startsWith('/doc/')) {
        const { n, err } = nodeFor(user, p.slice(5)); if (err) return json(res, err[0], { error: err[1] });
        const data = readJson(fileOf(n.id)); if (!data) return json(res, 404, { error: 'Inhalt fehlt.' });
        touch(n.id, user.id, true);
        return json(res, 200, { id: n.id, kind: n.kind, title: n.title, rev: n.rev, data, readOnly: !!(user.muted || n.trashed), trashed: !!n.trashed, roomId: n.roomId, editors: editors(n.id, user.id) });
      }
      if (m === 'GET' && p.startsWith('/versions/')) {
        const { n, err } = nodeFor(user, p.slice(10)); if (err) return json(res, err[0], { error: err[1] });
        return json(res, 200, { versions: listVersions(n.id) });
      }
      if (m === 'GET' && p.startsWith('/version/')) {
        const [id, rev] = p.slice(9).split('/'); const { n, err } = nodeFor(user, id); if (err) return json(res, err[0], { error: err[1] });
        if (!/^\d+$/.test(rev || '')) return json(res, 400, { error: 'Ungültige Version.' });
        const d = readJson(path.join(verDir(n.id), 'v' + rev + '.json')); if (!d) return json(res, 404, { error: 'Version nicht gefunden.' });
        return json(res, 200, { rev: Number(rev), data: d, kind: n.kind });
      }
      if (m === 'GET' && p.startsWith('/links/')) {
        const { n, err } = nodeFor(user, p.slice(7)); if (err) return json(res, err[0], { error: err[1] });
        const me = 'office:' + n.id; const vis = x => { if (!x.startsWith('office:')) return true; const t = o.nodes[x.slice(7, 43)]; return !!t && !t.trashed && canAccess(user.id, t.roomId); };
        const label = x => { if (x.startsWith('office:')) { const t = o.nodes[x.slice(7, 43)]; return t ? t.title : x; } return x; };
        const out = o.links.filter(l => l.from === me && vis(l.to)).map(l => ({ to: l.to, kind: l.kind, title: label(l.to) }));
        const inn = o.links.filter(l => l.to.startsWith(me) && vis(l.from)).map(l => ({ from: l.from, kind: l.kind, title: label(l.from) }));
        const db = getDb(); const tok = '[[office:' + n.id; const msgs = db.messages.filter(x => x.text && x.text.includes(tok) && canAccess(user.id, x.roomId)).slice(-20).map(x => ({ id: x.id, roomId: x.roomId, by: nameOf(x.userId), at: x.createdAt, text: clip(x.text.replace(/\[\[office:[^\]]+\]\]/g, '').trim(), 80) }));
        const boards = []; for (const [rid, cols] of Object.entries(db.boards || {})) if (canAccess(user.id, rid)) for (const c of cols) for (const k of c.cards) if (k.link && k.link.startsWith(me)) boards.push({ roomId: rid, text: k.text, col: c.title });
        const events = db.events.filter(e => e.link && e.link.startsWith(me) && canAccess(user.id, e.roomId)).map(e => ({ roomId: e.roomId, title: e.title, at: e.at }));
        return json(res, 200, { out, in: inn, messages: msgs, cards: boards, events });
      }
      if (m === 'GET' && p === '/rooms') return json(res, 200, { rooms: getDb().rooms.filter(r => canAccess(user.id, r.id)).map(r => ({ id: r.id, name: r.dm ? 'Direktnachricht' : r.name })) });

      if (m !== 'POST') return json(res, 405, { error: 'Methode nicht erlaubt.' });
      if (!rateOk('office:' + user.id, 240)) return json(res, 429, { error: 'Zu viele Anfragen.' });
      const b = await body(req, p === '/save' || p === '/copy' || p === '/create' || p === '/restore-version' ? MAX_BODY : 200000);
      if (!b) return json(res, 400, { error: 'Ungültige Anfrage.' });

      if (p === '/create') {
        if (user.muted) return json(res, 403, { error: 'Du bist stummgeschaltet.' });
        if (!KINDS.includes(b.kind) || !canAccess(user.id, b.roomId)) return json(res, 400, { error: 'Ungültige Angaben.' });
        if (Object.values(o.nodes).filter(x => x.roomId === b.roomId && !x.trashed).length >= MAX_NODES_PER_ROOM) return json(res, 400, { error: 'Zu viele Office-Dateien in diesem Raum.' });
        if (b.data != null && !validData(b.kind, b.data)) return json(res, 400, { error: 'Inhalt ungültig.' });
        const n = createNode(user, b.roomId, b.kind, b.title, b.data == null ? null : b.data);
        return json(res, 200, { node: meta(n) });
      }
      if (p === '/save') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        if (n.trashed) return json(res, 400, { error: 'Im Papierkorb.' });
        if (!validData(n.kind, b.data)) return json(res, 400, { error: 'Inhalt ungültig.' });
        if (Number(b.rev) !== n.rev) return json(res, 409, { error: 'Zwischenzeitlich geändert.', rev: n.rev, by: n.updatedBy ? nameOf(n.updatedBy) : '' });
        if (n.kind === 'sheet' || n.kind === 'doc') b.data.id = n.id;
        saveNode(user, n, b.data); touch(n.id, user.id, true);
        return json(res, 200, { rev: n.rev, editors: editors(n.id, user.id) });
      }
      if (p === '/presence') { const { n, err } = nodeFor(user, b.id); if (err) return json(res, err[0], { error: err[1] }); touch(n.id, user.id, b.open !== false); return json(res, 200, { rev: n.rev, editors: editors(n.id, user.id) }); }
      if (p === '/rename') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        const t = clip(b.title, 80).trim(); if (!t) return json(res, 400, { error: 'Titel fehlt.' });
        n.title = t; n.updated = Date.now(); saveDb(); broadcast({ type: 'office', op: 'rename', roomId: n.roomId, id: n.id, by: user.id }, n.roomId); return json(res, 200, { node: meta(n) });
      }
      if (p === '/delete' || p === '/restore' || p === '/purge') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        if (!canManage(user, n)) return json(res, 403, { error: 'Keine Berechtigung.' });
        if (p === '/delete') { n.trashed = Date.now(); audit(user, `Office: „${n.title}“ in den Papierkorb`); }
        else if (p === '/restore') { delete n.trashed; }
        else { if (!n.trashed) return json(res, 400, { error: 'Nur aus dem Papierkorb.' }); dropNode(n.id); }
        saveDb(); broadcast({ type: 'office', op: p.slice(1), roomId: n.roomId, id: n.id, by: user.id }, n.roomId); return json(res, 200, { ok: true });
      }
      if (p === '/copy') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        const data = b.data != null ? b.data : readJson(fileOf(n.id)); if (!validData(n.kind, data)) return json(res, 400, { error: 'Inhalt ungültig.' });
        const c = createNode(user, n.roomId, n.kind, clip(b.title || n.title + ' (Kopie)', 80), data); addLink('office:' + c.id, 'office:' + n.id, 'copy');
        return json(res, 200, { node: meta(c) });
      }
      if (p === '/restore-version') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        const d = readJson(path.join(verDir(n.id), 'v' + String(b.rev).replace(/\D/g, '') + '.json')); if (!d) return json(res, 404, { error: 'Version nicht gefunden.' });
        const cur = readJson(fileOf(n.id)); if (cur) { try { fs.mkdirSync(verDir(n.id), { recursive: true }); writeJson(path.join(verDir(n.id), 'v' + n.rev + '.json'), cur); } catch {} }
        saveNode(user, n, d); audit(user, `Office: „${n.title}“ auf Version ${b.rev} zurückgesetzt`); return json(res, 200, { rev: n.rev });
      }
      if (p === '/link') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        const to = String(b.to || ''); if (!/^office:[a-f0-9-]{36}$/.test(to) || !o.nodes[to.slice(7)] || !canAccess(user.id, o.nodes[to.slice(7)].roomId)) return json(res, 400, { error: 'Ziel ungültig.' });
        addLink('office:' + n.id, to, 'link'); saveDb(); return json(res, 200, { ok: true });
      }
      if (p === '/to-board' || p === '/to-calendar') {
        const { n, err } = nodeFor(user, b.id, true); if (err) return json(res, err[0], { error: err[1] });
        if (n.kind !== 'sheet') return json(res, 400, { error: 'Nur für Tabellen.' });
        const data = readJson(fileOf(n.id)); const r = p === '/to-board' ? sheetToBoard(user, n, data, b) : sheetToEvents(user, n, data, b);
        return json(res, 200, r);
      }
      if (p === '/from-note') {
        if (!canAccess(user.id, b.roomId)) return json(res, 404, { error: 'Raum nicht gefunden.' });
        const note = getDb().notes[b.roomId]; if (!note || !note.text) return json(res, 400, { error: 'Keine Notiz in diesem Raum.' });
        const lines = String(note.text).split(/\r?\n/); const n = createNode(user, b.roomId, 'doc', clip(b.title || 'Notizen ' + new Date().toLocaleDateString('de-DE'), 80), makeDoc(lines));
        addLink('office:' + n.id, 'note:' + b.roomId, 'note'); saveDb(); return json(res, 200, { node: meta(n) });
      }
      if (p === '/from-board') {
        if (!canAccess(user.id, b.roomId)) return json(res, 404, { error: 'Raum nicht gefunden.' });
        const n = createNode(user, b.roomId, 'sheet', clip(b.title || 'Aufgaben', 80), makeSheet(boardToRows(b.roomId), 'Aufgaben'));
        addLink('office:' + n.id, 'board:' + b.roomId, 'board'); saveDb(); return json(res, 200, { node: meta(n) });
      }
      if (p === '/from-events') {
        if (!canAccess(user.id, b.roomId)) return json(res, 404, { error: 'Raum nicht gefunden.' });
        const rows = [['Termin', 'Datum', 'Uhrzeit']]; for (const e of getDb().events.filter(x => x.roomId === b.roomId).sort((a, c) => a.at - c.at)) { const d = new Date(e.at); const pad = x => String(x).padStart(2, '0'); rows.push([e.title, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, `${pad(d.getHours())}:${pad(d.getMinutes())}`]); }
        const n = createNode(user, b.roomId, 'sheet', clip(b.title || 'Termine', 80), makeSheet(rows, 'Termine')); addLink('office:' + n.id, 'cal:' + b.roomId, 'calendar'); saveDb(); return json(res, 200, { node: meta(n) });
      }
      return json(res, 404, { error: 'Unbekannt.' });
    } catch (e) {
      if (e && e.code === 413) return json(res, 413, { error: 'Zu groß.' });
      console.error('Office-Fehler:', e && e.stack || e);
      return json(res, 500, { error: 'Serverfehler.' });
    }
  }

  function dropNode(id) {
    const o = dbo(); delete o.nodes[id]; o.links = o.links.filter(l => !l.from.startsWith('office:' + id) && !l.to.startsWith('office:' + id)); textIdx.delete(id); presence.delete(id);
    try { fs.unlinkSync(fileOf(id)); } catch {} try { fs.rmSync(verDir(id), { recursive: true, force: true }); } catch {}
  }
  // Wird von server.js aufgerufen, wenn ein Raum gelöscht wird.
  function dropRoom(roomId) {
    const o = dbo(); for (const n of Object.values(o.nodes)) if (n.roomId === roomId) dropNode(n.id);
    o.links = o.links.filter(l => !l.from.endsWith(':' + roomId) && !l.to.endsWith(':' + roomId));
  }
  // Papierkorb nach 30 Tagen leeren
  function purgeOld() { const o = dbo(); const lim = Date.now() - TRASH_DAYS * 86400000; let ch = false; for (const n of Object.values(o.nodes)) if (n.trashed && n.trashed < lim) { dropNode(n.id); ch = true; } if (ch) saveDb(); }
  setTimeout(() => { try { reindexAll(); purgeOld(); } catch (e) { console.error('Office-Start:', e.message); } }, 500);
  setInterval(() => { try { purgeOld(); } catch {} }, 6 * 3600000).unref?.();

  // Gibt true zurück, wenn die Anfrage hier bearbeitet wurde.
  function handle(req, res, url) {
    if (url.pathname === '/office') { res.writeHead(301, { Location: '/office/editor.html' }); res.end(); return true; }
    if (url.pathname.startsWith('/office/')) { if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; } serveStatic(req, res, url); return true; }
    if (url.pathname === '/api/office' || url.pathname.startsWith('/api/office/')) { api(req, res, url); return true; }
    return false;
  }
  return { handle, search, dropRoom, makeSheet, makeDoc, makeSlides };
};
