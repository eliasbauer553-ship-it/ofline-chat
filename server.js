'use strict';
const http = require('node:http');
const https = require('node:https');
const webpush = require('web-push');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { URL } = require('node:url');
const WebSocket = require('ws');
const { createEventBus } = require('./src/core/event-bus');
const schema = require('./src/core/schema');
const { createIndex, checkIntegrity } = require('./src/core/db-index');
const { runMigrations, CURRENT_VERSION } = require('./src/core/migrations');
const permsMod = require('./src/permissions/permissions');
const { createAudit } = require('./src/audit/audit');
const { createCommunity } = require('./src/community/community');
const { createRoutes } = require('./src/community/routes');
const APP_VERSION = '7.2';

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
function pickDataDir(){
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const os = require('node:os');
  const candidates = [path.join(ROOT, 'data'), path.join(process.env.HOME || os.homedir() || ROOT, 'offline-chat-data'), path.join(os.tmpdir(), 'offline-chat-data')];
  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); const t = path.join(dir, '.w'); fs.writeFileSync(t, '1'); fs.unlinkSync(t); return dir; } catch {}
  }
  return candidates[0];
}
const DATA = pickDataDir();
const UPLOADS = path.join(DATA, 'uploads');
const DB_FILE = path.join(DATA, 'database.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE = 25 * 1024 * 1024;
const MAX_MESSAGE = 8000;
const MAX_USERS = 50;

fs.mkdirSync(UPLOADS, { recursive: true });
let db = loadDb();
function normalizeDb(){
db.reads=db.reads||{};db.notes=db.notes||{};db.scheduled=db.scheduled||[];db.audit=db.audit||[];db.prefs=db.prefs||{};db.boards=db.boards||{};db.events=db.events||[];db.wb=db.wb||{};db.office=db.office||{nodes:{},links:[]};db.invites=db.invites||[];db.settings=db.settings||{registration:'open'};
db.servers=db.servers||[];
if(!db.servers.length)db.servers.push({id:'main',name:'Allgemein',color:'#5865f2',ownerId:(db.users.find(u=>u.role==='admin')||db.users[0]||{}).id||null,public:true,roles:defaultRoles(),members:{},invites:[]});
{const mn=db.servers.find(x=>x.id==='main');if(mn)for(const u of db.users)if(!mn.members[u.id])mn.members[u.id]={roles:u.role==='moderator'?['mod']:[]}}
for(const r of db.rooms)if(!r.dm&&!r.serverId)r.serverId='main';
}
normalizeDb();
// ---- Phase 2: Event-Bus, Indizes, Permission Engine, Audit-Kette, Migrationen ----
const bus = createEventBus();
const dbIndex = createIndex(() => db, schema);
const PE = permsMod.createEngine({ getDb: () => db, index: dbIndex, bus });
let auditReady = false;
const audit = createAudit({ getDb: () => db, dataDir: DATA, bus, save: () => { if (auditReady) saveDb(); } });
function flushDbNow() { try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) { console.error('Speichern fehlgeschlagen:', e); } }
function migrateDb() {
  auditReady = false;
  const r = runMigrations(db, { dbFile: DB_FILE, backupDir: path.join(DATA, 'backups'), audit, bus, log: m => console.log('[migration]', m) });
  dbIndex.invalidate();
  if (r.applied.length) { flushDbNow(); console.log(`[migration] Datenbank von Schema ${r.from} auf ${r.to} aktualisiert.` + (r.backup ? ' Sicherung: ' + path.basename(r.backup) : '')); }
  auditReady = true;
  return r;
}
migrateDb();
// ---- Phase 3: Community, Kanaltypen, Forum, Events, Stage ----
const comm = createCommunity({ getDb: () => db, bus, PE, index: dbIndex, saveDb: () => saveDb(), broadcast: (p, r) => broadcast(p, r), toUser: (u, o) => toUser(u, o), postSystem: (r, t, n) => postSystem(r, t, n), notifyPush: (u, p) => pushToUser(u, p), maxMessage: MAX_MESSAGE });
comm.init();
const SESS_FILE=path.join(DATA,'sessions.json');
const sessions=new Map((()=>{try{return Object.entries(JSON.parse(fs.readFileSync(SESS_FILE,'utf8'))).filter(([,x])=>x.expires>Date.now())}catch{return[]}})());
let sessTimer;function saveSessions(){clearTimeout(sessTimer);sessTimer=setTimeout(()=>{try{fs.writeFileSync(SESS_FILE+'.tmp',JSON.stringify(Object.fromEntries(sessions)));fs.renameSync(SESS_FILE+'.tmp',SESS_FILE)}catch(e){console.error(e.message)}},200)}
function dropSessions(uid){for(const [t,x] of sessions)if(x.userId===uid)sessions.delete(t);saveSessions()}

const sockets = new Set();
const rate = new Map();
let vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
if (!(vapidPublicKey && vapidPrivateKey)) {
  // Schlüssel automatisch erzeugen und im Datenordner speichern – keine Umgebungsvariablen nötig.
  const VF = path.join(DATA, 'vapid.json');
  try { const v = JSON.parse(fs.readFileSync(VF, 'utf8')); if (v.publicKey && v.privateKey) { vapidPublicKey = v.publicKey; vapidPrivateKey = v.privateKey; } } catch {}
  if (!(vapidPublicKey && vapidPrivateKey)) {
    try { const k = webpush.generateVAPIDKeys(); vapidPublicKey = k.publicKey; vapidPrivateKey = k.privateKey; fs.writeFileSync(VF, JSON.stringify(k)); } catch (e) { console.warn('VAPID-Schlüssel konnten nicht erzeugt werden:', e.message); }
  }
}
const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@offline-chat.local', vapidPublicKey, vapidPrivateKey);
function toUser(uid, obj) { const t = JSON.stringify(obj); for (const w of sockets) if (w.userId === uid && w.readyState === 1) w.send(t); }
async function sendPushToRoom(message, author) {
  if (!pushConfigured || !db.subscriptions.length || !author) return;
  const room = db.rooms.find(r => r.id === message.roomId);
  if (room && room.type === 'forum' && message.parentId) return; // Forenantworten gehen nur an Abonnenten (pushToUser)
  const text = String(message.text || '').trim() || (message.fileId ? '📎 Datei geteilt' : '');
  const payload = JSON.stringify({
    title: room && room.dm ? author.displayName : `${author.displayName} · #${room?.name || 'Offline Chat'}`,
    body: text.slice(0, 160), roomId: message.roomId, url: `/?room=${encodeURIComponent(message.roomId)}`
  });
  const targets = db.subscriptions.filter(x => {
    if (x.userId === author.id || !canAccess(x.userId, message.roomId)) return false;
    const u = db.users.find(y => y.id === x.userId); if (!u || u.status === 'dnd') return false;
    const mode = (db.prefs[x.userId] || {})[message.roomId] || 'all';
    if (mode === 'mute') return false;
    if (mode === 'mentions' && !room?.dm) return text.includes('@' + u.username) || text.includes('@everyone');
    return true;
  });
  await Promise.allSettled(targets.map(async x => {
    try { await webpush.sendNotification(x.subscription, payload, { TTL: 3600, urgency: 'high' }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { db.subscriptions = db.subscriptions.filter(y => y.id !== x.id); saveDb(); } else console.error('Push-Versand fehlgeschlagen:', e.statusCode || '', e.message); }
  }));
}

// Einzelnes Push an alle Geräte einer Person (Event-Erinnerungen, Forenabos).
async function pushToUser(uid, { title, body, roomId, url }) {
  if (!pushConfigured) return;
  const u = db.users.find(x => x.id === uid); if (!u || u.status === 'dnd') return;
  const payload = JSON.stringify({ title, body: String(body || '').slice(0, 160), roomId: roomId || '', url: url || '/' });
  await Promise.allSettled(db.subscriptions.filter(x => x.userId === uid).map(async x => {
    try { await webpush.sendNotification(x.subscription, payload, { TTL: 3600, urgency: 'high' }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { db.subscriptions = db.subscriptions.filter(y => y.id !== x.id); saveDb(); } else console.error('Push-Versand fehlgeschlagen:', e.statusCode || '', e.message); }
  }));
}
// Nach einer Antwort in einem Forenbeitrag: Zähler, Abos, Benachrichtigung der Abonnenten.
function afterForumReply(m, rm, me) {
  if (!rm || comm.typeOf(rm) !== 'forum' || !m.parentId) return;
  const fr = comm.onForumReply(m); if (!fr.post) return;
  saveDb(); broadcast({ type: 'forumPost', post: comm.postView(fr.post) }, rm.id);
  for (const uid of fr.notify) {
    toUser(uid, { type: 'forumReply', postId: fr.post.id, roomId: rm.id, title: fr.post.title, by: me.displayName });
    pushToUser(uid, { title: 'Forum: ' + fr.post.title, body: me.displayName + ': ' + String(m.text || '[Datei]').slice(0, 120), roomId: rm.id, url: '/?room=' + encodeURIComponent(rm.id) }).catch(() => {});
  }
}
function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return { ...d, users: d.users || [], rooms: d.rooms || [], messages: d.messages || [], files: d.files || [], polls: d.polls || [], subscriptions: d.subscriptions || [] };
    } catch (e) { console.error('Datenbankdatei defekt:', e.message); }
  }
  const general = { id: crypto.randomUUID(), name: 'Allgemein', description: 'Der gemeinsame Hauptraum', createdAt: Date.now(), createdBy: 'system' };
  return { users: [], rooms: [general], messages: [], files: [], polls: [], subscriptions: [] };
}
let saveTimer;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
    catch (e) { console.error('Speichern fehlgeschlagen:', e); }
  }, 120);
}
function send(res, code, data, headers={}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return part ? decodeURIComponent(part.slice(name.length+1)) : '';
}
function currentUser(req) {
  const token = cookie(req, 'offlinechat');
  const s = sessions.get(token);
  if (!s || s.expires < Date.now()) { if (token) sessions.delete(token);saveSessions(); return null; }
  return db.users.find(u=>u.id===s.userId) || null;
}
function publicUser(u) {
  return { id:u.id, username:u.username, displayName:u.displayName, bio:u.bio||'', color:u.color||'#6478d0', role:u.role, createdAt:u.createdAt, avatar:u.avatar||'', status:u.status||'online', statusText:u.statusText||'', muted:!!u.muted };
}
function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function validName(s) { return typeof s==='string' && /^[A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF_-]{3,24}$/.test(s); }
function isLocal(req) {
  let ip = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  // Android-Hotspots/WLANs liefern je nach Gerät IPv4, IPv6-Link-Local oder ULA.
  const ipv4Local = ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const ipv6Local = ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  return ipv4Local || ipv6Local;
}
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === req.headers.host;
  } catch { return false; }
}
function rateOk(key, limit=30) {
  const now=Date.now(), arr=(rate.get(key)||[]).filter(t=>now-t<60000);
  if (arr.length>=limit) return false;
  arr.push(now); rate.set(key,arr); return true;
}
const lastPost=new Map();
function defaultRoles(){return permsMod.defaultRoles()}
function can(uid,sid,perm,rid){return PE.can(uid,sid,perm,rid)}
function inServer(uid,sid){return !!db.servers.find(x=>x.id===sid)?.members[uid]}
function vis(uid){return db.rooms.filter(r=>PE.canRead(uid,r))}
function roomsFor(uid){return vis(uid).map(r0=>{const r=comm.roomView(uid,r0);if(!r.overrides||PE.has(uid,r.serverId,'MANAGE_ROLES'))return r;const {overrides,...x}=r;return x})}
function mineFor(uid,sv){const p=PE.permList(uid,sv.id),h=x=>p.includes(x);return{manage:h('MANAGE_SERVER')||h('MANAGE_CHANNELS')||h('MANAGE_ROLES')||h('KICK_MEMBERS')||h('MANAGE_MEMBERS'),moderate:h('MANAGE_MESSAGES'),invite:h('CREATE_INVITE'),perms:p,super:PE.isSuper(uid,sv),rank:PE.isSuper(uid,sv)?9999:PE.topRank(uid,sv)}}
function serversFor(uid){return db.servers.filter(sv=>sv.members[uid]).map(sv=>{const mine=mineFor(uid,sv),mr=mine.perms.includes('MANAGE_ROLES');return{id:sv.id,name:sv.name,color:sv.color,ownerId:sv.ownerId,public:sv.public,categoryOrder:sv.categoryOrder||[],community:comm.publicInfo(sv,uid),roles:sv.roles,everyone:mr?sv.everyone:undefined,categoryOverrides:mr?sv.categoryOverrides:undefined,members:sv.members,mine,invites:mine.perms.includes('CREATE_INVITE')?sv.invites:[]}})}
function broadcastServers(){for(const w of sockets)if(w.readyState===1)w.send(JSON.stringify({type:'servers',servers:serversFor(w.userId)}));broadcastRooms()}
function dropServer(id){db.rooms.filter(r=>r.serverId===id).forEach(r=>dropRoom(r.id));comm.onServerDropped(id);db.servers=db.servers.filter(x=>x.id!==id)}
function wbClean(o){if(!o||typeof o!=='object')return null;if(!['pen','marker','line','arrow','rect','ellipse','text','note'].includes(o.t))return null;const n=(v,lo,hi,d=0)=>{v=Number(v);return Number.isFinite(v)?Math.max(lo,Math.min(hi,Math.round(v))):d},col=v=>/^#[0-9a-f]{6}$/i.test(v||'')?v:'';const r={id:String(o.id||'').slice(0,40)||crypto.randomUUID(),t:o.t,c:col(o.c)||'#ffffff',w:n(o.w,1,60,4)};if(o.t==='pen'||o.t==='marker')r.p=(Array.isArray(o.p)?o.p:[]).slice(0,1200).map(v=>n(v,-50000,50000));else{r.x=n(o.x,-50000,50000);r.y=n(o.y,-50000,50000);r.x2=n(o.x2,-50000,50000);r.y2=n(o.y2,-50000,50000);r.fill=col(o.fill)}if(o.t==='text'||o.t==='note'){r.text=String(o.text||'').slice(0,300);r.fs=n(o.fs,10,120,24)}return r}
function canAccess(uid,id){const r=dbIndex.get('rooms',id);return !!r&&PE.canRead(uid,r)}
function pruneCategories(sv){if(!sv||!sv.categoryOverrides)return;const used=new Set(db.rooms.filter(r=>r.serverId===sv.id&&r.category).map(r=>r.category));for(const k of Object.keys(sv.categoryOverrides))if(!used.has(k))delete sv.categoryOverrides[k]}
// Kanal-/Kategorie-Überschreibungen prüfen und setzen (Eskalationsschutz: nur Rechte, die man selbst hat; nur Ziele unterhalb des eigenen Rangs)
function applyOverrides(user,sv,roomId,old,input){const list=PE.sanitizeOverrides(input,sv),sup=PE.isSuper(user.id,sv),mine=PE.effective(user.id,sv.id,roomId),key=o=>o.type+':'+o.id,om=new Map((old||[]).map(o=>[key(o),JSON.stringify(o)]));if(!sup)for(const o of list){if(om.get(key(o))===JSON.stringify(o))continue;if(o.type==='role'&&o.id!=='everyone'){const r=sv.roles.find(x=>x.id===o.id);if(r&&!PE.outranksRole(user.id,sv,r))return{error:'Die Rolle „'+r.name+'“ steht nicht unter deiner höchsten Rolle.'}}if(o.type==='member'&&o.id!==user.id&&!PE.outranksMember(user.id,sv,o.id))return{error:'Dieses Mitglied steht in der Rangfolge nicht unter dir.'};const prev=old&&old.find(x=>key(x)===key(o));if(o.allow.some(q=>!mine.has(q)&&!(prev&&prev.allow.includes(q))))return{error:'Du kannst nur Rechte erlauben, die du selbst hast.'}}return{list}}
function broadcastRooms(){for(const s of sockets){if(s.readyState!==1)continue;const v=roomsFor(s.userId);s.rooms=new Set(v.map(r=>r.id));s.send(JSON.stringify({type:'rooms',rooms:v}))}}
function readJson(req,res,cb,limit=5000){let b='',big=false;req.on('data',c=>{b+=c;if(b.length>limit){big=true;req.destroy()}});req.on('end',()=>{if(big)return;try{cb(JSON.parse(b||'{}'))}catch{send(res,400,{error:'Ungültige Anfrage.'})}})}
function dropRoom(id){try{office.dropRoom(id)}catch(e){console.error(e.message)}try{comm.onRoomDropped(id)}catch(e){console.error(e.message)}db.rooms=db.rooms.filter(r=>r.id!==id);db.messages=db.messages.filter(m=>m.roomId!==id);db.polls=db.polls.filter(p=>p.roomId!==id);db.files.filter(f=>f.roomId===id).forEach(f=>{try{fs.unlinkSync(path.join(UPLOADS,f.id))}catch{}});db.files=db.files.filter(f=>f.roomId!==id);delete db.notes[id];db.scheduled=db.scheduled.filter(x=>x.roomId!==id)}
function postMessage(roomId,uid,text){const me=db.users.find(x=>x.id===uid);if(!me||me.muted||!canAccess(uid,roomId))return;{const rx=db.rooms.find(r=>r.id===roomId);if(!rx||!comm.canPost(uid,rx,{}).ok)return}const m={id:crypto.randomUUID(),roomId,userId:uid,text,createdAt:Date.now(),parentId:null,reactions:{}};db.messages.push(m);saveDb();broadcast({type:'message',message:{...m,author:publicUser(me)}},roomId);bus.emit('message.created',{message:m});try{sendPushToRoom(m,me)}catch{}}
setInterval(()=>{const now=Date.now(),due=db.scheduled.filter(x=>x.at<=now);if(!due.length)return;db.scheduled=db.scheduled.filter(x=>x.at>now);due.forEach(x=>postMessage(x.roomId,x.userId,x.text));saveDb();for(const w of sockets)if(w.readyState===1)w.send(JSON.stringify({type:'scheduled',list:db.scheduled.filter(x=>x.userId===w.userId)}))},15000);
function backup(){try{const dir=path.join(DATA,'backups');fs.mkdirSync(dir,{recursive:true});if(fs.existsSync(DB_FILE))fs.copyFileSync(DB_FILE,path.join(dir,'db-'+new Date().toISOString().slice(0,10)+'.json'));fs.readdirSync(dir).filter(f=>/^db-.*\.json$/.test(f)).sort().slice(0,-7).forEach(f=>fs.unlinkSync(path.join(dir,f)))}catch(e){console.error('Backup:',e.message)}}
setTimeout(backup,3000);setInterval(backup,6*3600*1000);
function pollFor(p,uid){return p.anon?{...p,options:p.options.map(o=>({...o,votes:o.votes.map(v=>v===uid?v:'?')}))}:p}
function sendPoll(type,p){for(const s of sockets)if(s.readyState===1&&s.rooms.has(p.roomId))s.send(JSON.stringify({type,poll:pollFor(p,s.userId)}))}
function postSystem(roomId,text,name='Erinnerung'){const m={id:crypto.randomUUID(),roomId,userId:'system',authorName:name,text,createdAt:Date.now(),parentId:null,reactions:{}};db.messages.push(m);saveDb();broadcast({type:'message',message:m},roomId)}
// Event-Erinnerungen, Serien und Aufräumen: routes.startTimers() (Phase 3)
function broadcast(payload, roomId=null) {
  const text=JSON.stringify(payload);
  for (const s of sockets) {
    if (s.readyState!==WebSocket.OPEN) continue;
    if (!roomId || s.rooms?.has(roomId) || payload.type==='presence') s.send(text);
  }
}
function roomExists(id) { return db.rooms.some(r=>r.id===id); }
function memberCount() { return new Set([...sockets].filter(s=>s.readyState===WebSocket.OPEN).map(s=>s.userId)).size; }
function mimeFromName(name) {
  const ext=path.extname(name).toLowerCase();
  if(ext==='.webm') return /^Sprachnachricht-/.test(name)?'audio/webm':'video/webm';
  return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.zip':'application/zip','.mp4':'video/mp4','.mov':'video/quicktime','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.oga':'audio/ogg','.wav':'audio/wav','.weba':'audio/webm'}[ext] || 'application/octet-stream');
}
function safeFileName(n) { return path.basename(String(n||'Datei')).replace(/[^A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF._ -]/g,'_').slice(0,100) || 'Datei'; }

const games = require('./games')({ PUBLIC, DATA, currentUser });
const office = require('./office')({ PUBLIC, DATA, currentUser, getDb: () => db, saveDb, canAccess, can, broadcast, rateOk });
const backupMod=require('./backup.js');
const gamedata=require('./gamedata.js')({DATA});
backupMod.autoOnUpgrade(DATA,APP_VERSION).catch(e=>console.error('Auto-Backup:',e.message));
const backupCtx={DATA,version:APP_VERSION,userCount:()=>db.users.length,isAdmin:u=>Boolean(u&&u.role==='admin'),
  flush(){clearTimeout(saveTimer);try{fs.writeFileSync(DB_FILE+'.tmp',JSON.stringify(db));fs.renameSync(DB_FILE+'.tmp',DB_FILE)}catch(e){console.error(e.message)}try{fs.writeFileSync(SESS_FILE+'.tmp',JSON.stringify(Object.fromEntries(sessions)));fs.renameSync(SESS_FILE+'.tmp',SESS_FILE)}catch{}},
  beforeRestore(){backupCtx.flush();clearTimeout(saveTimer);clearTimeout(sessTimer)},
  reload(){
    clearTimeout(saveTimer);clearTimeout(sessTimer);
    db=loadDb();normalizeDb();migrateDb();
    sessions.clear();try{for(const [k,v] of Object.entries(JSON.parse(fs.readFileSync(SESS_FILE,'utf8'))))if(v.expires>Date.now())sessions.set(k,v)}catch{}
    try{const v=JSON.parse(fs.readFileSync(path.join(DATA,'vapid.json'),'utf8'));if(v.publicKey&&v.privateKey&&!process.env.VAPID_PUBLIC_KEY){vapidPublicKey=v.publicKey;vapidPrivateKey=v.privateKey;webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@offline-chat.local',vapidPublicKey,vapidPrivateKey)}}catch{}
    for(const c of [...sockets]){try{c.close(4000,'restore')}catch{}}
    return {users:db.users.length,rooms:db.rooms.length,messages:db.messages.length};
  }};
// ---- Sprach-/Videoanrufe (WebRTC-Signalisierung über den vorhandenen WebSocket) ----
const calls=new Map(); // roomId -> Map(userId -> {ws,since})
const CALL_MAX=8;
function callUsers(roomId){const m=calls.get(roomId);return m?[...m.keys()]:[]}
function callBroadcast(roomId){broadcast({type:'callState',roomId,users:callUsers(roomId)},roomId);routes.stageChanged(roomId)}
function callLeave(uid,roomId,onlyWs){
  const m=calls.get(roomId);if(!m||!m.has(uid))return;
  if(onlyWs&&m.get(uid).ws!==onlyWs)return;
  m.delete(uid);comm.stageLeave(uid,roomId);
  for(const [k,v] of m)try{if(v.ws.readyState===1)v.ws.send(JSON.stringify({type:'call',op:'left',roomId,from:uid}))}catch{}
  if(!m.size){calls.delete(roomId);comm.stageClear(roomId);const rm=db.rooms.find(r=>r.id===roomId);if(rm)postSystem(roomId,'Der Anruf wurde beendet.','Anruf')}
  callBroadcast(roomId);
}
function callHandle(ws,me,b){
  const roomId=String(b.roomId||'');if(!canAccess(me.id,roomId))return;
  if(b.op==='join'){
    const rm0=db.rooms.find(r=>r.id===roomId);
    {if(rm0&&!rm0.dm&&!can(me.id,rm0.serverId,'CONNECT_VOICE',rm0.id)){ws.send(JSON.stringify({type:'notice',text:'Du darfst diesem Anruf nicht beitreten.'}));return}const g0=rm0&&comm.gate(me.id,rm0);if(g0){ws.send(JSON.stringify({type:'notice',text:g0}));return}}
    const lim=Math.min(CALL_MAX,(rm0&&rm0.userLimit)||CALL_MAX);
    let m=calls.get(roomId);const first=!m;if(!m)calls.set(roomId,m=new Map());
    if(!m.has(me.id)&&m.size>=lim){ws.send(JSON.stringify({type:'notice',text:'Der Anruf ist voll (max. '+lim+' Personen).'}));return}
    const old=m.get(me.id);if(old&&old.ws!==ws){try{old.ws.send(JSON.stringify({type:'call',op:'kicked',roomId}))}catch{}}
    const peers=[...m.keys()].filter(x=>x!==me.id);
    m.set(me.id,{ws,since:Date.now()});
    ws.send(JSON.stringify({type:'call',op:'joined',roomId,peers}));
    for(const p of peers){const t=m.get(p);try{if(t.ws.readyState===1)t.ws.send(JSON.stringify({type:'call',op:'peer',roomId,from:me.id}))}catch{}}
    bus.emit('voice.joined',{roomId,userId:me.id});
    if(first&&!old)postSystem(roomId,me.displayName+' hat einen Anruf gestartet.','Anruf');
    callBroadcast(roomId);
  } else if(b.op==='leave'){callLeave(me.id,roomId,ws)}
  else if(b.op==='signal'){
    const m=calls.get(roomId),to=String(b.to||'');if(!m||!m.has(me.id)||m.get(me.id).ws!==ws||!m.has(to))return;
    const raw=JSON.stringify(b.data||{});if(raw.length>30000)return;
    try{const t=m.get(to).ws;if(t.readyState===1)t.send(JSON.stringify({type:'call',op:'signal',roomId,from:me.id,data:b.data}))}catch{}
  }
}
// ---- Mehrspieler: Spiel-Präsenz und Live-Zustand (für alle Spiele nutzbar) ----
const gamePlay=new Map(); // gameId -> Map(userId -> {ws,name,level,since})
const GID=/^[a-z0-9_-]{1,32}$/;
function gpList(g){return [...(gamePlay.get(g)||new Map())].map(([id,v])=>({id,name:v.name,level:v.level||null}))}
function gpBroadcast(g){const m=JSON.stringify({type:'gamePresence',game:g,players:gpList(g)});for(const c of sockets)try{if(c.readyState===1)c.send(m)}catch{}}
function gpLeave(uid,g,onlyWs){const m=gamePlay.get(g);if(!m||!m.has(uid))return;if(onlyWs&&m.get(uid).ws!==onlyWs)return;m.delete(uid);if(!m.size)gamePlay.delete(g);gpBroadcast(g)}
function gameHandle(ws,b){
  const me=db.users.find(x=>x.id===ws.userId);if(!me)return;
  const g=String(b.game||'');if(!GID.test(g))return;
  if(!rateOk(ws.userId+':game',1500))return;
  if(b.op==='join'){let m=gamePlay.get(g);if(!m)gamePlay.set(g,m=new Map());const o=m.get(me.id);if(o&&o.ws!==ws){try{o.ws.send(JSON.stringify({type:'gamePresence',game:g,players:[],kicked:true}))}catch{}}m.set(me.id,{ws,name:me.displayName,level:b.level==null?null:String(b.level).slice(0,24),since:Date.now()});gpBroadcast(g)}
  else if(b.op==='level'){const m=gamePlay.get(g),v=m&&m.get(me.id);if(!v||v.ws!==ws)return;v.level=b.level==null?null:String(b.level).slice(0,24);gpBroadcast(g)}
  else if(b.op==='leave'){gpLeave(me.id,g,ws)}
  else if(b.op==='state'){const m=gamePlay.get(g),v=m&&m.get(me.id);if(!v||v.ws!==ws)return;const raw=JSON.stringify(b.data||{});if(raw.length>8000)return;const out=JSON.stringify({type:'gameState',game:g,from:me.id,name:me.displayName,level:v.level,data:b.data});for(const [id,p] of m){if(id===me.id||p.level!==v.level)continue;try{if(p.ws.readyState===1)p.ws.send(out)}catch{}}}
  else if(b.op==='invite'){const rid=String(b.roomId||'');if(!canAccess(me.id,rid)||!rateOk(ws.userId+':invite',10))return;postSystem(rid,me.displayName+' lädt zu „'+String(b.title||g).slice(0,40)+'“ ein – im Chat links auf das Spiel-Symbol tippen.','Spiele')}
}
const docsMod=require('./docs.js')({DATA,canAccess:(u,r)=>canAccess(u,r),broadcast:(o,r)=>broadcast(o,r),toUser:(u,o)=>toUser(u,o),announce:(r,t,n)=>postSystem(r,t,n)});
const routes=createRoutes({comm,PE,audit,bus,getDb:()=>db,saveDb:()=>saveDb(),send,readJson,broadcast:(p,r)=>broadcast(p,r),broadcastRooms:()=>broadcastRooms(),broadcastServers:()=>broadcastServers(),toUser:(u,o)=>toUser(u,o),rateOk,sendPushToRoom:(m,a)=>sendPushToRoom(m,a),publicUser,callUsers:r=>callUsers(r),canAccess:(u,r)=>canAccess(u,r),sockets});
routes.startTimers();
const requestHandler = (req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!isLocal(req)) return send(res,403,{error:'Nur lokale Netzwerkverbindungen sind erlaubt.'});
  if (!originOk(req)) return send(res,403,{error:'Ungültiger Origin.'});
  if (games.handle(req,res,url)) return;
  if (office.handle(req,res,url)) return;
  if (req.method==='GET' && url.pathname==='/ca.crt') {
    if(!tlsInfo) return send(res,404,{error:'Kein automatisch erzeugtes Zertifikat vorhanden.'});
    res.writeHead(200,{'Content-Type':'application/x-x509-ca-cert','Content-Disposition':'attachment; filename="OfflineChat-Zertifikat.crt"','Cache-Control':'no-store'}); return res.end(tlsInfo.caDer);
  }
  if (req.method==='GET' && url.pathname==='/zertifikat') {
    const host=req.headers.host||'', plain='http://'+host.replace(/:\d+$/,'')+(String(PORT)==='80'?'':':'+PORT), sec='https://'+host.replace(/:\d+$/,'')+':'+PORT;
    const page=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mitteilungen auf dem iPad einrichten</title><style>body{font:17px/1.55 -apple-system,system-ui,sans-serif;max-width:640px;margin:20px auto;padding:0 16px 40px;background:#1e1f22;color:#eee}h1{font-size:24px}code{background:#333;padding:2px 6px;border-radius:5px;word-break:break-all}ol{padding-left:22px}li{margin:12px 0}a.btn{display:inline-block;background:#5865f2;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700}small,.m{color:#aaa}</style></head><body><h1>Mitteilungen auf dem iPad einrichten</h1><p class="m">iPadOS verschickt Push-Mitteilungen nur an Web-Apps, die per HTTPS laufen und zum Home-Bildschirm hinzugefügt wurden (iPadOS 16.4 oder neuer). Das Handy braucht dafür Internet (mobile Daten).</p>${tlsInfo?`<ol><li><b>Zertifikat laden:</b> <a class="btn" href="/ca.crt">Zertifikat herunterladen</a><br><small>Safari fragt, ob das Profil geladen werden darf – „Zulassen“.</small></li><li><b>Installieren:</b> Einstellungen → oben erscheint „Profil geladen“ (oder Allgemein → VPN &amp; Geräteverwaltung) → <i>Offline Chat</i> → Installieren.</li><li><b>Vertrauen:</b> Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → „Offline Chat CA“ einschalten.</li><li><b>Chat sicher öffnen:</b> in Safari <code>${sec}</code> aufrufen und neu anmelden.</li><li><b>Zum Home-Bildschirm:</b> Teilen-Symbol → „Zum Home-Bildschirm“. Danach die App <u>vom Home-Bildschirm</u> starten.</li><li><b>Aktivieren:</b> im Chat oben auf die Glocke tippen → „Mitteilungen aktivieren“ → Erlauben. Mit „Test senden“ prüfen.</li></ol><p class="m">Das Zertifikat gilt für alle IP-Adressen des Handys. Ändert sich die Adresse (anderes WLAN/Hotspot), stellt der Server automatisch ein neues Server-Zertifikat aus – du musst nichts erneut installieren.</p>`:`<p>Auf diesem Server ist HTTPS nicht automatisch eingerichtet. Siehe README (Abschnitt „Push-Mitteilungen“).</p>`}<p><small>Normale Adresse: <code>${plain}</code></small></p></body></html>`;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(page);
  }
  if (req.method==='GET' && url.pathname==='/api/addresses') {
    const ips=[];for(const list of Object.values(require('node:os').networkInterfaces()))for(const a of list||[])if(a.family==='IPv4'&&!a.internal)ips.push(a.address);
    return send(res,200,{port:PORT,https:Boolean(httpsServer),ips});
  }
  if (req.method==='GET' && url.pathname==='/api/health') return send(res,200,{ok:true,online:memberCount(),maxUsers:MAX_USERS});
  if (req.method==='GET' && url.pathname==='/ip') {
    const addr=server.address()||{};
    const rows=[];
    for(const [name,list] of Object.entries(require('node:os').networkInterfaces()))for(const a of list||[])if(a.family==='IPv4'&&!a.internal)rows.push(`<li><b>${a.address}</b> <small>(${name})</small><br><code>http://${a.address}:${PORT}</code>${httpsServer?`<br><code>https://${a.address}:${PORT}</code> <small>(für Mitteilungen · Einrichtung: <a href="/zertifikat" style="color:#8ea1ff">/zertifikat</a>)</small>`:''}</li>`);
    const page=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adresse</title><style>body{font:18px/1.5 -apple-system,system-ui,sans-serif;max-width:600px;margin:24px auto;padding:0 16px;background:#1e1f22;color:#eee}code{background:#333;padding:3px 7px;border-radius:5px;font-size:17px}li{margin:14px 0}small{color:#aaa}</style></head><body><h2>Adresse für das iPad</h2><p>Server hört auf: <code>${addr.address||'?'}:${addr.port||PORT}</code><br><small>(0.0.0.0 oder :: = von anderen Geräten erreichbar, 127.0.0.1 = nur auf diesem Handy)</small></p><p>Diese Adressen hat das Handy gerade. Gib auf dem iPad die ein, die zum Hotspot passt (meist 192.168.… oder 10.…):</p>${rows.length?'<ul>'+rows.join('')+'</ul>':'<p><b>Keine Netzwerk-Adresse gefunden.</b> Ist der Hotspot an?</p>'}</body></html>`;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(page);
  }
  if (req.method==='GET' && url.pathname==='/api/config') return send(res,200,{registration:db.users.length?db.settings.registration:'open',fresh:db.users.length===0});
  if (req.method==='POST' && url.pathname==='/api/register') {
    if (!rateOk(req.socket.remoteAddress+':register',8)) return send(res,429,{error:'Zu viele Versuche. Bitte später erneut.'});
    let body=''; let tooLarge=false; req.on('data',c=>{body+=c;if(body.length>5000){tooLarge=true;req.destroy();}});
    req.on('end',()=>{
      if(tooLarge) return send(res,413,{error:'Anfrage zu groß.'});
      try {
        const b=JSON.parse(body); const username=String(b.username||'').trim().toLowerCase();
        const displayName=String(b.displayName||username).trim().slice(0,32);
        const password=String(b.password||'');
        if (!validName(username)) return send(res,400,{error:'Benutzername: 3–24 Zeichen, Buchstaben, Zahlen, _ oder -.'});
        if (password.length<10 || password.length>128) return send(res,400,{error:'Passwort muss mindestens 10 Zeichen haben.'});
        if (db.users.some(u=>u.username===username)) return send(res,409,{error:'Dieser Benutzername ist bereits vergeben.'});
        if (db.users.length>=MAX_USERS) return send(res,403,{error:'Die lokale Benutzergrenze ist erreicht.'});
        if(db.users.length>0){const mode=db.settings.registration;if(mode==='closed')return send(res,403,{error:'Die Registrierung ist geschlossen.'});if(mode==='invite'){const inv=db.invites.find(i=>i.code===String(b.invite||'').trim().toUpperCase());if(!inv||(inv.expires&&inv.expires<Date.now())||(inv.max&&inv.uses>=inv.max))return send(res,403,{error:'Einladungscode ungültig oder abgelaufen.'});inv.uses++}}
        const p=hashPassword(password);
        const u={id:crypto.randomUUID(),username,displayName:displayName||username,bio:'',color:'#6478d0',role:db.users.length===0?'admin':'member',salt:p.salt,passwordHash:p.hash,createdAt:Date.now()};
        db.users.push(u);{const mn=db.servers.find(x=>x.id==='main');if(mn){if(!mn.ownerId)mn.ownerId=u.id;mn.members[u.id]={roles:[],joinedAt:Date.now()}}} saveDb(); bus.emit('member.joined',{serverId:'main',userId:u.id}); createSession(u,res); return;
      } catch { return send(res,400,{error:'Ungültige Anfrage.'}); }
    }); return;
  }
  if (req.method==='POST' && url.pathname==='/api/login') {
    if (!rateOk(req.socket.remoteAddress+':login',20)) return send(res,429,{error:'Zu viele Anmeldeversuche.'});
    let body=''; let tooLarge=false; req.on('data',c=>{body+=c;if(body.length>5000){tooLarge=true;req.destroy();}});
    req.on('end',()=>{
      try {
        const b=JSON.parse(body), name=String(b.username||'').trim().toLowerCase(), pass=String(b.password||'');
        const u=db.users.find(x=>x.username===name);
        const candidate=u ? crypto.scryptSync(pass,u.salt,64).toString('hex') : '';
        if (!u || !crypto.timingSafeEqual(Buffer.from(candidate),Buffer.from(u.passwordHash))) return send(res,401,{error:'Benutzername oder Passwort falsch.'});
        createSession(u,res);
      } catch { send(res,400,{error:'Ungültige Anfrage.'}); }
    }); return;
  }
  if (req.method==='POST' && url.pathname==='/api/logout') {
    const token=cookie(req,'offlinechat'); sessions.delete(token);
    return send(res,200,{ok:true},{'Set-Cookie':'offlinechat=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
  }
  const user=currentUser(req);
  if (backupMod.handle(req,res,url,user,backupCtx)) return;
  if (url.pathname.startsWith('/api/') && !user) return send(res,401,{error:'Bitte anmelden.'});
  if (gamedata.handle(req,res,url,user)) return;
  if (docsMod.handle(req,res,url,user)) return;
  if (routes.handle(req,res,url,user)) return;
  if (req.method==='GET' && url.pathname==='/api/push/config') return send(res,200,{configured:pushConfigured,publicKey:pushConfigured?vapidPublicKey:null,secure: Boolean(req.socket.encrypted),httpsAvailable:Boolean(httpsServer),caAvailable:Boolean(tlsInfo),subscriptions:db.subscriptions.filter(x=>x.userId===user.id).length});
  if (req.method==='POST' && url.pathname==='/api/push/subscribe') {
    if (!pushConfigured) return send(res,503,{error:'Push ist auf dem Server noch nicht eingerichtet (VAPID-Schlüssel fehlen).'});
    let body=''; req.on('data',c=>{body+=c;if(body.length>12000)req.destroy()}); req.on('end',()=>{
      try { const sub=JSON.parse(body); if(!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return send(res,400,{error:'Ungültiges Push-Abonnement.'});
        db.subscriptions=db.subscriptions.filter(x=>x.subscription.endpoint!==sub.endpoint);
        db.subscriptions.push({id:crypto.randomUUID(),userId:user.id,subscription:sub,createdAt:Date.now()}); saveDb(); send(res,200,{ok:true});
      } catch { send(res,400,{error:'Ungültige Anfrage.'}); }
    }); return;
  }
  if (req.method==='POST' && url.pathname==='/api/push/unsubscribe') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{try{const b=JSON.parse(body||'{}'); if(b.endpoint) db.subscriptions=db.subscriptions.filter(x=>x.userId!==user.id||x.subscription.endpoint!==b.endpoint); else db.subscriptions=db.subscriptions.filter(x=>x.userId!==user.id); saveDb(); send(res,200,{ok:true});}catch{send(res,400,{error:'Ungültige Anfrage.'})}}); return;
  }
  if (req.method==='POST' && url.pathname==='/api/push/test') {
    if (!pushConfigured) return send(res,503,{error:'Push ist auf dem Server nicht eingerichtet.'});
    const mine=db.subscriptions.filter(x=>x.userId===user.id);
    if(!mine.length) return send(res,400,{error:'Dieses Konto hat noch kein Gerät für Push angemeldet.'});
    const payload=JSON.stringify({title:'Offline Chat',body:'Test erfolgreich – Mitteilungen funktionieren. 🎉',roomId:'test',url:'/'});
    Promise.allSettled(mine.map(x=>webpush.sendNotification(x.subscription,payload,{TTL:300,urgency:'high'}).catch(e=>{if(e.statusCode===404||e.statusCode===410){db.subscriptions=db.subscriptions.filter(y=>y.id!==x.id);saveDb()}throw e}))).then(r=>{
      const ok=r.filter(x=>x.status==='fulfilled').length,err=r.find(x=>x.status==='rejected');
      send(res,200,{ok,failed:r.length-ok,error:err?String(err.reason&&(err.reason.statusCode||err.reason.code||err.reason.message)||'Fehler'):null});
    }); return;
  }
  if (req.method==='GET' && url.pathname==='/api/me') return send(res,200,{user:publicUser(user),users:db.users.map(publicUser),rooms:roomsFor(user.id)});
  if (req.method==='GET' && url.pathname==='/api/search') {
    const q=(url.searchParams.get('q')||'').trim().toLowerCase().slice(0,100);
    if(q.length<2) return send(res,200,{results:[]});
    const results=db.messages.filter(m=>canAccess(user.id,m.roomId)&&m.text.toLowerCase().includes(q)).slice(-100).map(m=>({...m,author:db.users.find(u=>u.id===m.userId)?.displayName||'Unbekannt'}));
    return send(res,200,{results,office:office.search(user,q)});
  }
  if (req.method==='GET' && url.pathname==='/api/export') {
    const id=url.searchParams.get('room'); if(!canAccess(user.id,id)) return send(res,404,{error:'Raum nicht gefunden.'});
    const r=db.rooms.find(x=>x.id===id), nm=u=>db.users.find(x=>x.id===u)?.displayName||'Unbekannt';
    const t=db.messages.filter(m=>m.roomId===id).map(m=>`[${new Date(m.createdAt).toLocaleString('de-DE')}] ${nm(m.userId)}: ${m.fileId?'[Datei] '+(db.files.find(f=>f.id===m.fileId)?.name||''):m.text}`).join('\n');
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="chat-${(r.dm?'dm':r.name).replace(/[^\w-]/g,'_')}.txt"`}); return res.end(t||'(leer)');
  }
  if (req.method==='GET' && url.pathname==='/api/servers/browse') return send(res,200,comm.discover(user.id,url.searchParams.get('q'),url.searchParams.get('tag')));
  if (req.method==='GET' && url.pathname==='/api/admin/stats') {
    if(user.role!=='admin') return send(res,403,{error:'Nur Administratoren.'});
    let free=0,total=0;try{const st=fs.statfsSync(DATA);free=st.bavail*st.bsize;total=st.blocks*st.bsize}catch{}
    const up=fs.readdirSync(UPLOADS).reduce((n,f)=>{try{return n+fs.statSync(path.join(UPLOADS,f)).size}catch{return n}},0);
    let dbs=0;try{dbs=fs.statSync(DB_FILE).size}catch{}
    const cnt={};for(const m of db.messages)cnt[m.userId]=(cnt[m.userId]||0)+1;
    return send(res,200,{settings:db.settings,invites:db.invites,storage:{uploads:up,db:dbs,free,total},counts:{users:db.users.length,rooms:db.rooms.filter(r=>!r.dm).length,messages:db.messages.length},users:db.users.map(u=>({id:u.id,displayName:u.displayName,role:u.role,muted:!!u.muted,messages:cnt[u.id]||0,onlineMin:Math.round((u.onlineMs||0)/60000),lastSeen:u.lastSeen||0}))});
  }
  if (req.method==='GET' && url.pathname==='/api/permissions/meta') return send(res,200,{perms:PE.ALL.map(k=>({key:k,...PE.PERMS[k]})),groups:PE.GROUPS,channelScoped:PE.CHANNEL_SCOPED,everyoneDefault:PE.EVERYONE_DEFAULT});
  if (req.method==='GET' && url.pathname==='/api/permissions/me') {
    const sid=url.searchParams.get('server')||'',rid=url.searchParams.get('room')||'';
    if(!inServer(user.id,sid)) return send(res,404,{error:'Server nicht gefunden.'});
    return send(res,200,{perms:PE.permList(user.id,sid,rid||undefined)});
  }
  if (req.method==='GET' && url.pathname==='/api/admin/integrity') {
    if(user.role!=='admin') return send(res,403,{error:'Nur Administratoren.'});
    const issues=checkIntegrity(db,schema),by={};for(const i of issues)by[i.kind+':'+i.coll]=(by[i.kind+':'+i.coll]||0)+1;
    return send(res,200,{schemaVersion:db.schemaVersion,current:CURRENT_VERSION,migrations:db.migrationLog||[],issues:by,sample:issues.slice(0,20),quarantine:Object.fromEntries(Object.entries(db.quarantine||{}).map(([k,v])=>[k,v.length]))});
  }
  if (req.method==='GET' && url.pathname==='/api/audit/verify') {
    if(user.role!=='admin') return send(res,403,{error:'Nur Administratoren.'});
    return send(res,200,audit.verify());
  }
  if (req.method==='GET' && url.pathname==='/api/audit') {
    const sid=url.searchParams.get('server');
    if(sid){if(!inServer(user.id,sid)||!can(user.id,sid,'VIEW_AUDIT_LOG')) return send(res,403,{error:'Keine Berechtigung.'});return send(res,200,{audit:audit.list({serverId:sid,limit:100})});}
    if(user.role!=='admin') return send(res,403,{error:'Nur Administratoren.'});
    return send(res,200,{audit:audit.list({limit:100})});
  }
  if (req.method==='POST' && ['/api/dm','/api/avatar','/api/rooms/update','/api/rooms/delete','/api/users/reset','/api/users/remove','/api/servers/create','/api/servers/join','/api/servers/leave','/api/servers/delete','/api/servers/update','/api/servers/invite','/api/servers/role','/api/servers/member','/api/servers/category-overrides','/api/rooms/overrides','/api/status','/api/users/mute','/api/admin/settings','/api/admin/invite','/api/admin/invite/delete'].includes(url.pathname)) {
    return readJson(req,res,b=>{
      const p=url.pathname, adm=user.role==='admin', mod=adm||user.role==='moderator', no=send.bind(null,res,403,{error:'Keine Berechtigung.'});
      const log=(t,x)=>{x=x||{};audit.append({serverId:x.serverId,actorId:user.id,actorName:user.displayName,action:x.action||'admin',targetType:x.targetType,targetId:x.targetId,text:t,meta:x.meta})};
      if(p==='/api/dm'){const t=db.users.find(x=>x.id===b.userId);if(!t||t.id===user.id)return send(res,400,{error:'Ungültige Person.'});let r=db.rooms.find(x=>x.dm&&x.dm.includes(t.id)&&x.dm.includes(user.id));if(!r){r={id:crypto.randomUUID(),name:'dm',description:'',dm:[user.id,t.id],createdAt:Date.now(),createdBy:user.id};db.rooms.push(r);saveDb();broadcastRooms()}return send(res,200,{room:r})}
      if(p==='/api/avatar'){const d=String(b.data||'');if(d&&(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(d)||d.length>40000))return send(res,400,{error:'Bild ungültig oder zu groß.'});user.avatar=d;saveDb();broadcast({type:'users',users:db.users.map(publicUser)});return send(res,200,{})}
      if(p==='/api/rooms/update'){const r=db.rooms.find(x=>x.id===b.roomId);if(!r||r.dm)return send(res,404,{error:'Raum nicht gefunden.'});if(!can(user.id,r.serverId,'MANAGE_CHANNELS'))return no();const name=String(b.name||'').trim().slice(0,32);if(name.length<2)return send(res,400,{error:'Raumname zu kurz.'});const ck0=comm.catKey(r);r.name=name;r.description=String(b.description||'').slice(0,120);r.category=String(b.category||'').trim().slice(0,24);comm.applyRoomSettings(r,b);if(comm.catKey(r)!==ck0)r.position=comm.nextPosition(r.serverId,comm.catKey(r));r.slow=Math.max(0,Math.min(3600,parseInt(b.slow)||0));r.private=!!b.private;r.readOnly=!!b.readOnly;r.members=r.private?(Array.isArray(b.members)?b.members.filter(id=>db.users.some(u=>u.id===id)):[]):undefined;if(r.private&&!r.members.includes(user.id))r.members.push(user.id);log('Kanal bearbeitet: #'+r.name,{serverId:r.serverId,action:'channel.update',targetType:'room',targetId:r.id});bus.emit('channel.updated',{serverId:r.serverId,roomId:r.id,by:user.id});pruneCategories(db.servers.find(x=>x.id===r.serverId));saveDb();broadcastRooms();return send(res,200,{room:r})}
      if(p==='/api/rooms/overrides'){const r=db.rooms.find(x=>x.id===b.roomId);if(!r||r.dm)return send(res,404,{error:'Raum nicht gefunden.'});const sv=db.servers.find(x=>x.id===r.serverId);if(!sv||!sv.members[user.id]&&!adm)return no();if(!can(user.id,sv.id,'MANAGE_ROLES')||!can(user.id,sv.id,'MANAGE_CHANNELS'))return no();const a=applyOverrides(user,sv,r.id,r.overrides,b.overrides);if(a.error)return send(res,403,{error:a.error});if(a.list.length)r.overrides=a.list;else delete r.overrides;log('Kanalrechte geändert: #'+r.name,{serverId:sv.id,action:'channel.overrides',targetType:'room',targetId:r.id});bus.emit('channel.overrides.updated',{serverId:sv.id,roomId:r.id,by:user.id});saveDb();broadcastRooms();return send(res,200,{room:r})}
      if(p==='/api/rooms/delete'){const r=db.rooms.find(x=>x.id===b.roomId);if(r&&!r.dm&&!can(user.id,r.serverId,'MANAGE_CHANNELS'))return no();if(!r||r.dm||db.rooms.filter(x=>x.serverId===r.serverId).length<2)return send(res,400,{error:'Der letzte Kanal kann nicht gelöscht werden.'});dropRoom(r.id);log('Kanal gelöscht: #'+r.name,{serverId:r.serverId,action:'channel.delete',targetType:'room',targetId:r.id});bus.emit('channel.deleted',{serverId:r.serverId,roomId:r.id,by:user.id});pruneCategories(db.servers.find(x=>x.id===r.serverId));saveDb();broadcastRooms();return send(res,200,{})}
      if(p.startsWith('/api/servers/')){
        const sid=String(b.serverId||''),SV=db.servers.find(x=>x.id===sid),okc=v=>/^#[0-9a-f]{6}$/i.test(v||'');
        if(p==='/api/servers/create'){const name=String(b.name||'').trim().slice(0,32);if(name.length<2)return send(res,400,{error:'Servername zu kurz.'});if(db.servers.filter(x=>x.ownerId===user.id).length>=5)return send(res,400,{error:'Maximal 5 eigene Server.'});const id=crypto.randomUUID();db.servers.push({id,name,color:okc(b.color)?b.color:'#5865f2',ownerId:user.id,public:!!b.public,roles:defaultRoles(),members:{[user.id]:{roles:[],joinedAt:Date.now()}},invites:[]});db.rooms.push({id:crypto.randomUUID(),serverId:id,name:'allgemein',description:'Willkommen!',type:'text',position:1,createdAt:Date.now(),createdBy:user.id});log('Server erstellt: '+name,{serverId:id,action:'server.create'});bus.emit('server.created',{serverId:id,by:user.id});saveDb();broadcastServers();return send(res,200,{server:{id}})}
        if(p==='/api/servers/join'){let sv=SV;if(b.code){const c=String(b.code).trim().toUpperCase();sv=db.servers.find(x=>x.invites.some(i=>i.code===c));const inv=sv&&sv.invites.find(i=>i.code===c);if(!inv||(inv.expires&&inv.expires<Date.now())||(inv.max&&inv.uses>=inv.max))return send(res,400,{error:'Einladungscode ungültig oder abgelaufen.'});if(!sv.members[user.id])inv.uses++}else if(!sv||!sv.public)return send(res,403,{error:'Dieser Server ist nicht öffentlich.'});if(!sv.members[user.id]){sv.members[user.id]={roles:[]};bus.emit('member.joined',{serverId:sv.id,userId:user.id})}saveDb();broadcastServers();return send(res,200,{server:{id:sv.id}})}
        if(!SV)return send(res,404,{error:'Server nicht gefunden.'});
        if(p==='/api/servers/leave'){if(SV.ownerId===user.id)return send(res,400,{error:'Als Besitzer kannst du den Server nur löschen.'});delete SV.members[user.id];bus.emit('member.left',{serverId:SV.id,userId:user.id});saveDb();broadcastServers();return send(res,200,{})}
        if(p==='/api/servers/delete'){if(SV.ownerId!==user.id&&!adm)return no();if(SV.id==='main')return send(res,400,{error:'Der Hauptserver kann nicht gelöscht werden.'});dropServer(SV.id);log('Server gelöscht: '+SV.name,{serverId:SV.id,action:'server.delete'});bus.emit('server.deleted',{serverId:SV.id,by:user.id});saveDb();broadcastServers();return send(res,200,{})}
        if(!SV.members[user.id]&&!adm)return no();
        if(p==='/api/servers/update'){if(!can(user.id,SV.id,'MANAGE_SERVER'))return no();const name=String(b.name||'').trim().slice(0,32);if(name.length>=2)SV.name=name;SV.public=!!b.public;if(okc(b.color))SV.color=b.color;bus.emit('server.updated',{serverId:SV.id,by:user.id});saveDb();broadcastServers();return send(res,200,{})}
        if(p==='/api/servers/category-overrides'){if(!can(user.id,SV.id,'MANAGE_ROLES')||!can(user.id,SV.id,'MANAGE_CHANNELS'))return no();const cat=String(b.category||'');if(!cat||!db.rooms.some(r=>r.serverId===SV.id&&r.category===cat))return send(res,404,{error:'Kategorie nicht gefunden.'});SV.categoryOverrides=SV.categoryOverrides||{};const a=applyOverrides(user,SV,undefined,SV.categoryOverrides[cat],b.overrides);if(a.error)return send(res,403,{error:a.error});if(a.list.length)SV.categoryOverrides[cat]=a.list;else delete SV.categoryOverrides[cat];log('Kategorierechte geändert: '+cat,{serverId:SV.id,action:'category.overrides'});bus.emit('channel.overrides.updated',{serverId:SV.id,category:cat,by:user.id});saveDb();broadcastServers();return send(res,200,{})}
        if(p==='/api/servers/invite'){if(!can(user.id,SV.id,'invite'))return no();if(b.del)SV.invites=SV.invites.filter(i=>i.code!==b.del);else{let code=crypto.randomBytes(4).toString('hex').toUpperCase();if(b.code){if(!comm.canVanity(SV.id))return send(res,403,{error:'Eigene Einladungscodes brauchen Boost-Stufe 3.'});const c=String(b.code).trim().toUpperCase();if(!/^[A-Z0-9-]{4,16}$/.test(c))return send(res,400,{error:'Code: 4–16 Zeichen, nur Buchstaben, Zahlen und Bindestrich.'});if(db.invites.some(i=>i.code===c)||db.servers.some(s2=>s2.invites.some(i=>i.code===c)))return send(res,400,{error:'Dieser Code ist schon vergeben.'});code=c}SV.invites.push({code,uses:0,max:Math.max(0,Math.min(100,parseInt(b.max)||0)),expires:b.days?Date.now()+Math.min(90,parseInt(b.days)||7)*864e5:0})}saveDb();broadcastServers();return send(res,200,{})}
        if(p==='/api/servers/role'){if(!can(user.id,SV.id,'MANAGE_ROLES'))return no();
          const act=String(b.action||'save'),sup=PE.isSuper(user.id,SV),x=b.role||{},meta=r=>({serverId:SV.id,action:'role.'+act,targetType:'role',targetId:r&&r.id}),deny=(m)=>send(res,403,{error:m});
          if(act==='everyone'){const perms=PE.cleanPerms(b.perms);if(perms.includes('ADMINISTRATOR'))return deny('Administrator kann nicht für alle Mitglieder gelten.');const old=(SV.everyone&&SV.everyone.perms)||[];if(!PE.canGrant(user.id,SV,perms.filter(q=>!old.includes(q))))return deny('Du kannst nur Rechte vergeben, die du selbst hast.');SV.everyone={perms};log('Rechte für alle Mitglieder geändert',{serverId:SV.id,action:'role.everyone'})}
          else if(act==='delete'){const r=SV.roles.find(y=>y.id===x.id);if(!r)return send(res,404,{error:'Rolle nicht gefunden.'});if(!PE.outranksRole(user.id,SV,r))return deny('Diese Rolle steht nicht unter deiner höchsten Rolle.');SV.roles=SV.roles.filter(y=>y!==r);for(const m of Object.values(SV.members))m.roles=(m.roles||[]).filter(i=>i!==r.id);PE.normalizePositions(SV);for(const rm of db.rooms)if(rm.serverId===SV.id&&rm.overrides)rm.overrides=rm.overrides.filter(o=>!(o.type==='role'&&o.id===r.id));for(const k of Object.keys(SV.categoryOverrides||{}))SV.categoryOverrides[k]=SV.categoryOverrides[k].filter(o=>!(o.type==='role'&&o.id===r.id));log('Rolle gelöscht: '+r.name,meta(r));bus.emit('role.deleted',{serverId:SV.id,roleId:r.id,by:user.id})}
          else if(act==='move'){const r=SV.roles.find(y=>y.id===x.id);if(!r)return send(res,404,{error:'Rolle nicht gefunden.'});if(!PE.outranksRole(user.id,SV,r))return deny('Diese Rolle steht nicht unter deiner höchsten Rolle.');const so=[...SV.roles].sort((a,c)=>a.position-c.position),i=so.indexOf(r),j=b.dir==='up'?i+1:i-1;if(j>=0&&j<so.length){const o=so[j];if(!sup&&!PE.outranksRole(user.id,SV,o))return deny('Die Rolle kann nicht über deine eigene verschoben werden.');const t=r.position;r.position=o.position;o.position=t;log('Rolle verschoben: '+r.name,meta(r));bus.emit('role.updated',{serverId:SV.id,roleId:r.id,by:user.id})}}
          else{const name=String(x.name||'').trim().slice(0,24);if(!name)return send(res,400,{error:'Rollenname fehlt.'});const perms=PE.cleanPerms(x.perms);let r=SV.roles.find(y=>y.id===x.id);const old=r?r.perms:[];
            if(r&&!PE.outranksRole(user.id,SV,r))return deny('Diese Rolle steht nicht unter deiner höchsten Rolle.');
            if(!PE.canGrant(user.id,SV,perms.filter(q=>!old.includes(q))))return deny('Du kannst nur Rechte vergeben, die du selbst hast.');
            if(!r){{const lim=comm.roleLimit(SV.id);if(SV.roles.length>=lim)return send(res,400,{error:'Maximal '+lim+' Rollen'+(lim<25?' (mehr mit Server-Boost).':'.')})};r={id:crypto.randomUUID().slice(0,8),name,color:'#99aab5',perms:[],position:0};SV.roles.push(r)}
            r.name=name;if(okc(x.color))r.color=x.color;r.perms=perms;PE.normalizePositions(SV);log((x.id?'Rolle geändert: ':'Rolle erstellt: ')+name,meta(r));bus.emit(x.id?'role.updated':'role.created',{serverId:SV.id,roleId:r.id,by:user.id})}
          saveDb();broadcastServers();return send(res,200,{})}
        if(p==='/api/servers/member'){const tid=String(b.userId||'');if(!db.users.some(x=>x.id===tid))return send(res,404,{error:'Nutzer nicht gefunden.'});
          if(b.action==='add'){if(!can(user.id,SV.id,'CREATE_INVITE'))return no();if(!SV.members[tid]){SV.members[tid]={roles:[]};bus.emit('member.joined',{serverId:SV.id,userId:tid,by:user.id})}}
          else{const m=SV.members[tid];if(!m)return send(res,404,{error:'Kein Mitglied.'});if(tid===SV.ownerId)return no();const tn=db.users.find(x=>x.id===tid).username;
            if(b.action==='kick'){if(!can(user.id,SV.id,'KICK_MEMBERS'))return no();if(!PE.outranksMember(user.id,SV,tid))return send(res,403,{error:'Dieses Mitglied steht in der Rangfolge nicht unter dir.'});delete SV.members[tid];log('Mitglied entfernt: @'+tn,{serverId:SV.id,action:'member.kick',targetType:'user',targetId:tid});bus.emit('member.left',{serverId:SV.id,userId:tid,by:user.id,kicked:true})}
            else if(b.action==='setRoles'){if(!can(user.id,SV.id,'MANAGE_ROLES'))return no();const nr=(Array.isArray(b.roles)?b.roles:[]).filter(i=>SV.roles.some(r=>r.id===i)),err=PE.checkAssign(user.id,SV,tid,m.roles||[],nr);if(err)return send(res,403,{error:err});m.roles=[...new Set(nr)];log('Rollen von @'+tn+' geändert',{serverId:SV.id,action:'member.roles',targetType:'user',targetId:tid});bus.emit('role.assigned',{serverId:SV.id,userId:tid,roles:m.roles,by:user.id})}
            else return send(res,400,{error:'Unbekannte Aktion.'})}
          saveDb();broadcastServers();return send(res,200,{})}
        return send(res,404,{error:'Unbekannt.'});
      }
      if(p==='/api/status'){user.status=['online','away','dnd'].includes(b.status)?b.status:'online';user.statusText=String(b.statusText||'').slice(0,40);saveDb();broadcast({type:'users',users:db.users.map(publicUser)});return send(res,200,{})}
      if(!adm)return no();
      const t=db.users.find(x=>x.id===b.userId);
      if(p==='/api/users/mute'){if(!t||t.role==='admin')return send(res,400,{error:'Nicht möglich.'});t.muted=!!b.muted;log((t.muted?'Stummgeschaltet: ':'Stumm aufgehoben: ')+t.username);saveDb();broadcast({type:'users',users:db.users.map(publicUser)});return send(res,200,{})}
      if(p==='/api/admin/settings'){if(['open','invite','closed'].includes(b.registration))db.settings.registration=b.registration;log('Registrierung: '+db.settings.registration);saveDb();return send(res,200,{})}
      if(p==='/api/admin/invite'){db.invites.push({code:crypto.randomBytes(4).toString('hex').toUpperCase(),uses:0,max:Math.max(0,Math.min(100,parseInt(b.max)||1)),expires:b.days?Date.now()+Math.min(90,parseInt(b.days)||7)*864e5:0});log('Einladungscode erstellt');saveDb();return send(res,200,{})}
      if(p==='/api/admin/invite/delete'){db.invites=db.invites.filter(i=>i.code!==b.code);saveDb();return send(res,200,{})}
      if(p==='/api/users/reset'){const pw=String(b.password||'');if(!t||t.id===user.id||pw.length<10||pw.length>200)return send(res,400,{error:'Ungültig (Passwort mind. 10 Zeichen).'});const h=hashPassword(pw);t.salt=h.salt;t.passwordHash=h.hash;dropSessions(t.id);log('Passwort zurückgesetzt: '+t.username);saveDb();return send(res,200,{})}
      if(p==='/api/users/remove'){if(!t||t.role==='admin'||t.id===user.id)return send(res,400,{error:'Nicht möglich.'});db.users=db.users.filter(x=>x!==t);for(const sv of [...db.servers]){delete sv.members[t.id];if(sv.ownerId===t.id){if(sv.id==='main')sv.ownerId=user.id;else dropServer(sv.id)}}db.rooms.filter(r=>r.dm?.includes(t.id)).forEach(r=>dropRoom(r.id));comm.onUserRemoved(t.id);db.subscriptions=(db.subscriptions||[]).filter(x=>x.userId!==t.id);delete db.reads[t.id];dropSessions(t.id);for(const w of sockets)if(w.userId===t.id)try{w.close()}catch{};log('Mitglied entfernt: '+t.username);saveDb();broadcast({type:'users',users:db.users.map(publicUser)});broadcastRooms();return send(res,200,{})}
    });
  }
  if (req.method==='POST' && url.pathname==='/api/rooms') {
    return readJson(req,res,b=>{
      const out=comm.createRoom(user.id,b); if(out.error) return send(res,out.status||400,{error:out.error});
      audit.append({serverId:out.room.serverId,actorId:user.id,actorName:user.displayName,action:'channel.create',targetType:'room',targetId:out.room.id,text:'Kanal erstellt: #'+out.room.name+' ('+comm.ROOM_TYPES[out.room.type].label+')'});
      saveDb();broadcastRooms();send(res,200,{room:out.room});
    },5000);
  }
  if (req.method==='POST' && url.pathname==='/api/users/role') {
    if(user.role!=='admin') return send(res,403,{error:'Nur Administratoren dürfen Rollen ändern.'});
    let body='';req.on('data',c=>{body+=c;if(body.length>2000)req.destroy()});req.on('end',()=>{
      try { const b=JSON.parse(body), target=db.users.find(x=>x.id===b.userId), role=String(b.role||'');
        if(!target || target.role==='admin' || !['member','moderator'].includes(role)) return send(res,400,{error:'Ungültige Rollenänderung.'});
        target.role=role;saveDb();broadcast({type:'users',users:db.users.map(publicUser)});send(res,200,{user:publicUser(target)});
      } catch { send(res,400,{error:'Ungültige Anfrage.'}); }
    }); return;
  }
  if (req.method==='POST' && url.pathname==='/api/profile') {
    let body='';let tooLarge=false;req.on('data',c=>{body+=c;if(body.length>5000){tooLarge=true;req.destroy();}});req.on('end',()=>{
      if(tooLarge)return send(res,413,{error:'Anfrage zu groß.'});
      try { const b=JSON.parse(body);user.displayName=String(b.displayName||user.username).trim().slice(0,32)||user.username;user.bio=String(b.bio||'').slice(0,160);user.color=/^#[0-9a-f]{6}$/i.test(b.color)?b.color:'#6478d0';saveDb();broadcast({type:'users',users:db.users.map(publicUser)});send(res,200,{user:publicUser(user)}); }
      catch{send(res,400,{error:'Ungültige Anfrage.'});}
    }); return;
  }
  if (req.method==='POST' && url.pathname==='/api/upload') {
    const roomId=url.searchParams.get('room');
    if(!canAccess(user.id,roomId)) return send(res,404,{error:'Raum nicht gefunden.'});
    if(user.muted) return send(res,403,{error:'Du wurdest stummgeschaltet.'});
    const parentQ=url.searchParams.get('parent')||'',parentId=parentQ&&db.messages.some(x=>x.id===parentQ&&x.roomId===roomId)?parentQ:null;
    {const cs=comm.canPost(user.id,db.rooms.find(x=>x.id===roomId),{files:true,upload:true,parentId});if(!cs.ok) return send(res,403,{error:cs.reason});}
    const name=safeFileName(url.searchParams.get('name')||'Datei');
    const id=crypto.randomUUID(), temp=path.join(UPLOADS,id+'.part'), dest=path.join(UPLOADS,id);
    let size=0, failed=false;
    const out=fs.createWriteStream(temp,{flags:'wx'});
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_FILE){failed=true;req.destroy();}});
    req.pipe(out);
    out.on('finish',()=>{
      if(failed||size===0){try{fs.unlinkSync(temp)}catch{};return send(res,413,{error:'Datei leer oder größer als 25 MB.'});}
      fs.renameSync(temp,dest);
      const f={id,name,size,mime:mimeFromName(name),roomId,userId:user.id,createdAt:Date.now()};
      db.files.push(f);const fm={id:crypto.randomUUID(),roomId,userId:user.id,text:'',fileId:id,createdAt:Date.now(),parentId,reactions:{}};db.messages.push(fm);saveDb();broadcast({type:'file',file:{...f,author:user.displayName}},roomId);broadcast({type:'message',message:{...fm,author:publicUser(user)}},roomId);bus.emit('message.created',{message:fm});afterForumReply(fm,db.rooms.find(x=>x.id===roomId),user);try{sendPushToRoom(fm,user)}catch{}send(res,200,{file:f});
    });
    out.on('error',()=>send(res,500,{error:'Upload fehlgeschlagen.'})); return;
  }
  if (req.method==='GET' && url.pathname.startsWith('/api/files/')) {
    if(!user) return send(res,401,{error:'Bitte anmelden.'});
    const id=path.basename(url.pathname.slice('/api/files/'.length));
    const f=db.files.find(x=>x.id===id);
    if(!f) return send(res,404,{error:'Datei nicht gefunden.'});
    const p=path.join(UPLOADS,id);
    let st; try{st=fs.statSync(p)}catch{return send(res,404,{error:'Datei fehlt auf dem Server.'})}
    const inline=url.searchParams.get('inline')==='1'&&/^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.mime);
    const etag='"'+id+'-'+st.size+'"';
    const hdr={'Content-Type':f.mime,'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','ETag':etag,'Cache-Control':'private, max-age=31536000, immutable'};
    if(req.headers['if-none-match']===etag){res.writeHead(304,{ETag:etag,'Cache-Control':hdr['Cache-Control']});return res.end()}
    let start=0,end=st.size-1,code=200;
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
    if(m&&(m[1]||m[2])){ if(m[1]===''){start=Math.max(0,st.size-Number(m[2]));}else{start=Number(m[1]);if(m[2]!=='')end=Math.min(end,Number(m[2]));}
      if(start>end||start>=st.size){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end()}
      code=206;hdr['Content-Range']=`bytes ${start}-${end}/${st.size}`; }
    hdr['Content-Length']=end-start+1;
    res.writeHead(code,hdr);
    const rs=fs.createReadStream(p,{start,end});rs.on('error',()=>res.destroy());res.on('close',()=>rs.destroy());rs.pipe(res); return;
  }
  if (req.method==='GET' && url.pathname==='/') return serveFile(res,path.join(PUBLIC,'index.html'));
  if (req.method==='GET' && url.pathname.startsWith('/')) {
    const rel=decodeURIComponent(url.pathname).replace(/^\/+/,'');
    const target=path.resolve(PUBLIC,rel);
    if(!target.startsWith(PUBLIC+path.sep)) return send(res,403,{error:'Verboten.'});
    try{if(fs.statSync(target).isDirectory()){if(!url.pathname.endsWith('/')){res.writeHead(301,{Location:url.pathname+'/'});return res.end()}return serveFile(res,path.join(target,'index.html'))}}catch{}
    return serveFile(res,target);
  }
  send(res,404,{error:'Nicht gefunden.'});
};
const tlsKey = process.env.TLS_KEY, tlsCert = process.env.TLS_CERT;
// Ein Port für beides: HTTP (z. B. zum Laden des Zertifikats) und HTTPS (nötig für Push auf dem iPad).
// Die erste Verbindungs-Byte entscheidet (TLS beginnt immer mit 0x16).
const httpServer = http.createServer(requestHandler);
let httpsServer = null, tlsInfo = null;
if (tlsKey && tlsCert) {
  try { httpsServer = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, requestHandler); console.log('HTTPS mit eigenem Zertifikat aktiviert.'); } catch (e) { console.warn('TLS_KEY/TLS_CERT nicht lesbar:', e.message); }
}
if (!httpsServer && process.env.NO_TLS !== '1') {
  try { tlsInfo = require('./cert').ensureCerts(path.join(DATA, 'tls')); httpsServer = https.createServer({ key: tlsInfo.key, cert: tlsInfo.cert }, requestHandler); console.log('HTTPS mit automatisch erzeugtem Zertifikat aktiviert (Einrichtung auf dem iPad: /zertifikat).'); }
  catch (e) { console.warn('HTTPS-Zertifikat konnte nicht erzeugt werden – es läuft nur HTTP:', e.message); }
}
const server = net.createServer(sock => {
  sock.on('error', () => {});
  sock.once('data', buf => {
    sock.pause(); sock.unshift(buf);
    (httpsServer && buf[0] === 0x16 ? httpsServer : httpServer).emit('connection', sock);
    process.nextTick(() => sock.resume());
  });
});
function createSession(u,res) {
  const token=crypto.randomBytes(32).toString('hex');
  sessions.set(token,{userId:u.id,expires:Date.now()+30*24*3600*1000});saveSessions();
  send(res,200,{user:publicUser(u)},{'Set-Cookie':`offlinechat=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`});
}
function serveFile(res,p) {
  if(!fs.existsSync(p)||!fs.statSync(p).isFile()) return send(res,404,{error:'Datei nicht gefunden.'});
  const ext=path.extname(p).toLowerCase(), types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.png':'image/png'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.png'?'public, max-age=86400':'no-store','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(p).pipe(res);
}

const wss=new WebSocket.Server({noServer:true,maxPayload:64*1024});
setInterval(()=>{for(const c of wss.clients){if(c.alive===false){c.terminate();continue}c.alive=false;try{c.ping()}catch{}}},25000);
const onUpgrade=(req,socket,head)=>{
  if(!isLocal(req)||!originOk(req)){socket.destroy();return;}
  const token=cookie(req,'offlinechat'), sess=sessions.get(token);
  if(!sess||sess.expires<Date.now()){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req,sess));
};
httpServer.on('upgrade',onUpgrade);if(httpsServer)httpsServer.on('upgrade',onUpgrade);
wss.on('connection',(ws,req,sess)=>{
  ws.userId=sess.userId;ws.alive=true;ws.on('pong',()=>ws.alive=true);ws.rooms=new Set(vis(ws.userId).map(r=>r.id));sockets.add(ws);ws.since=Date.now();ws.on('close',()=>{const x=db.users.find(y=>y.id===ws.userId);if(x){x.onlineMs=(x.onlineMs||0)+Date.now()-ws.since;x.lastSeen=Date.now();saveDb()}});
  const u=db.users.find(x=>x.id===ws.userId);
  {const vr=roomsFor(ws.userId),ok=new Set(vr.map(r=>r.id));ws.send(JSON.stringify({type:'init',user:publicUser(u),rooms:vr,users:db.users.map(publicUser),messages:db.messages.filter(m=>ok.has(m.roomId)).slice(-500),files:db.files.filter(f=>ok.has(f.roomId)).slice(-100),polls:db.polls.filter(p=>ok.has(p.roomId)).map(p=>pollFor(p,ws.userId)),reads:db.reads[ws.userId]||{},notes:Object.fromEntries(Object.entries(db.notes).filter(([k])=>ok.has(k))),scheduled:db.scheduled.filter(x=>x.userId===ws.userId),prefs:db.prefs[ws.userId]||{},servers:serversFor(ws.userId),boards:Object.fromEntries(Object.entries(db.boards).filter(([k])=>ok.has(k))),events:db.events.filter(e=>ok.has(e.roomId)).map(comm.eventView),...routes.initExtras(ws.userId)}))}
  broadcast({type:'presence',online:memberCount(),onlineIds:[...new Set([...sockets].filter(s=>s.readyState===1).map(s=>s.userId))],users:db.users.map(publicUser)});
  for(const g of gamePlay.keys())try{ws.send(JSON.stringify({type:'gamePresence',game:g,players:gpList(g)}))}catch{}
  for(const [rid,m] of calls)if(canAccess(ws.userId,rid))try{ws.send(JSON.stringify({type:'callState',roomId:rid,users:[...m.keys()]}))}catch{}
  ws.on('message',raw=>{
    let b;try{b=JSON.parse(raw.toString())}catch{return}
    if(b&&b.type==='ping'){try{ws.send('{"type":"pong"}')}catch{}return}
    if(b&&b.type==='game'){gameHandle(ws,b);return}
    if(!rateOk(ws.userId,1500)) return;
    const me=db.users.find(x=>x.id===ws.userId); if(!me)return;
    if(routes.wsHandle(ws,me,b))return;
    if(b.type==='message'){
      const text=String(b.text||'').trim();
      if(me.muted){ws.send(JSON.stringify({type:'notice',text:'Du wurdest stummgeschaltet.'}));return}
      if(!rateOk(ws.userId+':msg',60))return;
      if(!text||text.length>MAX_MESSAGE||!canAccess(me.id,b.roomId))return;
      const rm=db.rooms.find(r=>r.id===b.roomId);{const cs=comm.canPost(me.id,rm,{parentId:typeof b.parentId==='string'?b.parentId:null});if(!cs.ok){ws.send(JSON.stringify({type:'notice',text:cs.reason}));return}}if(rm?.slow&&!can(me.id,rm.serverId,'MANAGE_MESSAGES',rm.id)){const k=me.id+rm.id;if(Date.now()-(lastPost.get(k)||0)<rm.slow*1000){ws.send(JSON.stringify({type:'notice',text:'Langsamer Modus: bitte kurz warten.'}));return}lastPost.set(k,Date.now())}
      const parent=typeof b.parentId==='string'?db.messages.find(x=>x.id===b.parentId&&x.roomId===b.roomId):null;
      const m={id:crypto.randomUUID(),roomId:b.roomId,userId:me.id,text,createdAt:Date.now(),parentId:parent?parent.id:null,replyTo:db.messages.find(x=>x.id===b.replyTo&&x.roomId===b.roomId)?.id||null,reactions:{}};
      db.messages.push(m);comm.trimMessages();
      saveDb();broadcast({type:'message',message:{...m,author:publicUser(me)}},m.roomId);sendPushToRoom(m,me);bus.emit('message.created',{message:m});afterForumReply(m,rm,me);
    } else if(b.type==='deleteMessage'){
      const target=db.messages.find(x=>x.id===b.messageId);
      if(!target || (target.userId!==me.id && !can(me.id,db.rooms.find(r=>r.id===target.roomId)?.serverId,'MANAGE_MESSAGES',target.roomId)))return;
      const removed=new Set([target.id]);
      for(const m of db.messages)if(m.parentId===target.id)removed.add(m.id);
      db.messages=db.messages.filter(m=>!removed.has(m.id));saveDb();
      broadcast({type:'deleteMessages',ids:[...removed],roomId:target.roomId},target.roomId);bus.emit('message.deleted',{messageId:target.id,roomId:target.roomId,by:me.id});
      {const rm2=db.rooms.find(r=>r.id===target.roomId);if(rm2&&comm.typeOf(rm2)==='forum'){const fr=comm.onMessagesRemoved(removed,rm2.id);saveDb();if(fr.gone.length)broadcast({type:'forumPostDelete',postIds:fr.gone,roomId:rm2.id},rm2.id);for(const pv of fr.changed)broadcast({type:'forumPost',post:pv},rm2.id)}}
    } else if(b.type==='pref'){
      (db.prefs[me.id]=db.prefs[me.id]||{})[b.roomId]=['all','mentions','mute'].includes(b.mode)?b.mode:'all';saveDb();toUser(me.id,{type:'prefs',prefs:db.prefs[me.id]});
    } else if(b.type==='board'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;
      const cols=(Array.isArray(b.cols)?b.cols:[]).slice(0,6).map(c=>({id:String(c.id||'').slice(0,40)||crypto.randomUUID(),title:String(c.title||'').slice(0,30),cards:(Array.isArray(c.cards)?c.cards:[]).slice(0,60).map(k=>({id:String(k.id||'').slice(0,40)||crypto.randomUUID(),text:String(k.text||'').slice(0,200),by:String(k.by||'').slice(0,32)}))}));
      db.boards[b.roomId]=cols;saveDb();broadcast({type:'board',roomId:b.roomId,cols},b.roomId);
    } else if(b.type==='boardOp'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;
      const mk=(t)=>({id:crypto.randomUUID(),title:t,cards:[]});
      if(!Array.isArray(db.boards[b.roomId])||!db.boards[b.roomId].length)db.boards[b.roomId]=[mk('Offen'),mk('In Arbeit'),mk('Erledigt')];
      const cols=db.boards[b.roomId],col=id=>cols.find(c=>c.id===id),clip=(x,n)=>String(x||'').slice(0,n);
      if(b.op==='addCard'){const c=col(b.col),t=clip(b.text,200).trim();if(!c||!t||c.cards.length>=60)return;c.cards.push({id:crypto.randomUUID(),text:t,by:me.displayName})}
      else if(b.op==='moveCard'){const from=cols.find(c=>c.cards.some(k=>k.id===b.card)),to=col(b.to);if(!from||!to||(from!==to&&to.cards.length>=60))return;const [k]=from.cards.splice(from.cards.findIndex(k=>k.id===b.card),1);to.cards.push(k)}
      else if(b.op==='delCard'){let hit=false;for(const c of cols){const i=c.cards.findIndex(k=>k.id===b.card);if(i>=0){c.cards.splice(i,1);hit=true}}if(!hit)return}
      else if(b.op==='renameCol'){const c=col(b.col);if(!c)return;c.title=clip(b.title,30)}
      else if(b.op==='addCol'){if(cols.length>=6)return;cols.push(mk(clip(b.title,30)||'Neu'))}
      else if(b.op==='delCol'){if(cols.length<2)return;const i=cols.findIndex(c=>c.id===b.col);if(i<0)return;cols.splice(i,1)}
      else if(b.op!=='init')return;
      saveDb();broadcast({type:'board',roomId:b.roomId,cols},b.roomId);
    } else if(b.type==='wbget'){
      if(!canAccess(me.id,b.roomId))return;ws.send(JSON.stringify({type:'wb',roomId:b.roomId,objs:db.wb[b.roomId]||[]}));
    } else if(b.type==='wbadd'){
      const o=wbClean(b.o);if(!o||!canAccess(me.id,b.roomId)||me.muted)return;const a=(db.wb[b.roomId]=db.wb[b.roomId]||[]);if(a.some(x=>x.id===o.id))return;o.by=me.id;a.push(o);if(a.length>1500)a.shift();saveDb();broadcast({type:'wbadd',roomId:b.roomId,o,from:me.id},b.roomId);
    } else if(b.type==='wbupd'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;const o=(db.wb[b.roomId]||[]).find(x=>x.id===b.id);if(!o)return;const c=wbClean({...o,...(b.patch||{}),id:o.id,t:o.t});if(!c)return;Object.assign(o,c);saveDb();broadcast({type:'wbupd',roomId:b.roomId,o,from:me.id},b.roomId);
    } else if(b.type==='wbdel'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;const ids=new Set((Array.isArray(b.ids)?b.ids:[]).slice(0,300).map(String));db.wb[b.roomId]=(db.wb[b.roomId]||[]).filter(x=>!ids.has(x.id));saveDb();broadcast({type:'wbdel',roomId:b.roomId,ids:[...ids],from:me.id},b.roomId);
    } else if(b.type==='wblive'){
      if(!canAccess(me.id,b.roomId))return;const o=wbClean(b.o);if(o)broadcast({type:'wblive',roomId:b.roomId,o,from:me.id},b.roomId);
    } else if(b.type==='wbclear'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;db.wb[b.roomId]=[];saveDb();broadcast({type:'wbclear',roomId:b.roomId,from:me.id},b.roomId);
    } else if(b.type==='history'){
      if(!canAccess(me.id,b.roomId))return;const o=db.messages.filter(x=>x.roomId===b.roomId&&x.createdAt<Number(b.before)).slice(-50);
      ws.send(JSON.stringify({type:'history',roomId:b.roomId,messages:o,more:o.length===50}));
    } else if(b.type==='read'){
      if(!canAccess(me.id,b.roomId))return;(db.reads[me.id]=db.reads[me.id]||{})[b.roomId]=Date.now();saveDb();toUser(me.id,{type:'reads',reads:db.reads[me.id]});
    } else if(b.type==='notes'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;const text=String(b.text||'').slice(0,4000),prev=db.notes[b.roomId],cur=(prev&&prev.rev)||0;
      if(b.base!==undefined&&Number(b.base)!==cur){ws.send(JSON.stringify({type:'notes',roomId:b.roomId,text:(prev&&prev.text)||'',by:(prev&&prev.by)||'',rev:cur,conflict:true}));return}
      db.notes[b.roomId]={text,by:me.displayName,at:Date.now(),rev:cur+1};saveDb();broadcast({type:'notes',roomId:b.roomId,text,by:me.displayName,rev:cur+1,from:me.id,cid:String(b.cid||'').slice(0,16)},b.roomId);
    } else if(b.type==='schedule'){
      const text=String(b.text||'').trim(),at=Number(b.at);if(!text||text.length>MAX_MESSAGE||!canAccess(me.id,b.roomId)||!(at>Date.now())||at>Date.now()+30*864e5||db.scheduled.filter(x=>x.userId===me.id).length>=20)return;
      db.scheduled.push({id:crypto.randomUUID(),userId:me.id,roomId:b.roomId,text,at});saveDb();toUser(me.id,{type:'scheduled',list:db.scheduled.filter(x=>x.userId===me.id)});
    } else if(b.type==='unschedule'){
      db.scheduled=db.scheduled.filter(x=>!(x.id===b.id&&x.userId===me.id));saveDb();toUser(me.id,{type:'scheduled',list:db.scheduled.filter(x=>x.userId===me.id)});
    } else if(b.type==='edit'){
      const m=db.messages.find(x=>x.id===b.messageId),t=String(b.text||'').trim();
      if(!m||m.userId!==me.id||m.fileId||!t||t.length>MAX_MESSAGE)return;
      (m.history=m.history||[]).push({text:m.text,at:m.editedAt||m.createdAt});m.history=m.history.slice(-10);m.text=t;m.edited=true;m.editedAt=Date.now();saveDb();broadcast({type:'updateMessage',message:m},m.roomId);
    } else if(b.type==='call'){
      callHandle(ws,me,b);
    } else if(b.type==='typing'){
      if(canAccess(me.id,b.roomId))broadcast({type:'typing',roomId:b.roomId,userId:me.id},b.roomId);
    } else if(b.type==='reaction'){
      const m=db.messages.find(x=>x.id===b.messageId);const emoji=String(b.emoji||'').slice(0,8);if(!m||!emoji||!canAccess(me.id,m.roomId))return;{const rm=db.rooms.find(r=>r.id===m.roomId);if(rm&&!rm.dm&&(!can(me.id,rm.serverId,'ADD_REACTIONS',rm.id)||comm.gate(me.id,rm)))return}
      m.reactions=m.reactions||{};m.reactions[emoji]=m.reactions[emoji]||[];
      const a=m.reactions[emoji],i=a.indexOf(me.id);if(i>=0)a.splice(i,1);else a.push(me.id);
      saveDb();broadcast({type:'updateMessage',message:m},m.roomId);
    } else if(b.type==='pin'){
      const m=db.messages.find(x=>x.id===b.messageId);if(!m||!canAccess(me.id,m.roomId)||!can(me.id,db.rooms.find(r=>r.id===m.roomId)?.serverId,'MANAGE_MESSAGES',m.roomId))return;m.pinned=!m.pinned;saveDb();broadcast({type:'updateMessage',message:m},m.roomId);
    } else if(b.type==='poll'){
      if(!canAccess(me.id,b.roomId)||me.muted)return;{const pr=db.rooms.find(r=>r.id===b.roomId);if(!pr||!comm.canPost(me.id,pr,{}).ok)return}
      const question=String(b.question||'').trim().slice(0,180), rawOptions=Array.isArray(b.options)?b.options:[], options=[...new Set(rawOptions.slice(0,20).map(x=>String(x).trim().slice(0,60)).filter(Boolean))].slice(0,8);
      if(question.length<3||options.length<2)return;
      const p={id:crypto.randomUUID(),roomId:b.roomId,userId:me.id,question,options:options.map((label,i)=>({id:String(i),label,votes:[]})),multi:!!b.multi,anon:!!b.anon,endsAt:Number(b.hours)>0?Date.now()+Math.min(720,Number(b.hours))*3600000:0,createdAt:Date.now()};
      db.polls.push(p);saveDb();sendPoll('poll',p);
    } else if(b.type==='vote'){
      const p=db.polls.find(x=>x.id===b.pollId);if(!p||!canAccess(me.id,p.roomId)||(p.endsAt&&Date.now()>p.endsAt))return;
      const o=p.options.find(x=>x.id===b.optionId);if(!o)return;const had=o.votes.includes(me.id);
      if(!p.multi)for(const q of p.options)q.votes=q.votes.filter(id=>id!==me.id);else o.votes=o.votes.filter(id=>id!==me.id);
      if(!had)o.votes.push(me.id);
      saveDb();sendPoll('updatePoll',p);
    }
  });
  ws.on('close',()=>{sockets.delete(ws);for(const [g,m] of [...gamePlay])for(const [uid,v] of [...m])if(v.ws===ws)gpLeave(uid,g,ws);for(const [rid,m] of [...calls])for(const [uid,v] of [...m])if(v.ws===ws)callLeave(uid,rid,ws);broadcast({type:'presence',online:memberCount(),onlineIds:[...new Set([...sockets].filter(s=>s.readyState===1).map(s=>s.userId))],users:db.users.map(publicUser)});});
});
server.listen(PORT,'0.0.0.0',()=>{console.log(`Offline Chat ${APP_VERSION} läuft auf Port ${PORT}`);console.log(`  Datenordner: ${DATA}`);for(const l of Object.values(require('node:os').networkInterfaces()))for(const a of l||[])if(a.family==='IPv4'&&!a.internal)console.log(`  → Auf dem iPad öffnen: http://${a.address}:${PORT}`)});
const bye=()=>{clearTimeout(saveTimer);try{fs.writeFileSync(DB_FILE,JSON.stringify(db))}catch{};try{fs.writeFileSync(SESS_FILE,JSON.stringify(Object.fromEntries(sessions)))}catch{};setTimeout(()=>process.exit(0),1500);server.close(()=>process.exit(0))};process.on('SIGINT',bye);process.on('SIGTERM',bye);
