'use strict';
// Erzeugt ohne externe Programme (kein openssl nötig) ein lokales Zertifikat:
//  - ein Root-Zertifikat "Offline Chat CA" (einmalig, 10 Jahre) – das wird auf dem iPad installiert und als vertrauenswürdig markiert
//  - ein Server-Zertifikat für die aktuellen IP-Adressen des Handys (ändert sich die IP, wird es automatisch neu ausgestellt –
//    das iPad muss dem Root-Zertifikat nur ein einziges Mal vertrauen)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const len = n => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = s => { const a = s.split('.').map(Number); const b = [a[0] * 40 + a[1]]; for (const n of a.slice(2)) { const t = [n & 127]; let v = n >> 7; while (v) { t.unshift((v & 127) | 128); v >>= 7; } b.push(...t); } return tlv(0x06, Buffer.from(b)); };
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
const int = buf => { let b = Buffer.from(buf); while (b.length > 1 && b[0] === 0 && !(b[1] & 128)) b = b.subarray(1); if (b[0] & 128) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const bool = v => tlv(0x01, Buffer.from([v ? 255 : 0]));
const octets = b => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const ctx = (n, ...p) => tlv(0xa0 + n, ...p);
const utc = d => { const p = x => String(x).padStart(2, '0'); return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); };
const name = cn => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function keyId(pub) {
  const j = pub.export({ format: 'jwk' });
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')])).digest();
}
function pem(type, der) { return `-----BEGIN ${type}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${type}-----\n`; }

function issue({ subjectCn, issuerCn, pub, signKey, issuerPub, days, isCa, sans }) {
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const from = new Date(Date.now() - 24 * 3600 * 1000), to = new Date(Date.now() + days * 24 * 3600 * 1000);
  const exts = [
    ext('2.5.29.19', true, seq(...(isCa ? [bool(true)] : []))),
    ext('2.5.29.15', true, bits(Buffer.from([isCa ? 0x06 : 0x80]), isCa ? 1 : 7)),
    ext('2.5.29.14', false, octets(keyId(pub)))
  ];
  if (issuerPub) exts.push(ext('2.5.29.35', false, seq(tlv(0x80, keyId(issuerPub)))));
  if (!isCa) {
    exts.push(ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));
    exts.push(ext('2.5.29.17', false, seq(...sans.map(s => s.ip ? tlv(0x87, Buffer.from(s.ip.split('.').map(Number))) : tlv(0x82, Buffer.from(s.dns))))));
  }
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(serial), ECDSA_SHA256, name(issuerCn), seq(utc(from), utc(to)), name(subjectCn), pub.export({ type: 'spki', format: 'der' }), ctx(3, seq(...exts)));
  const sig = crypto.sign('sha256', tbs, signKey);
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sig));
}

function lanIps() {
  const ips = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.add(a.address);
  for (const x of String(process.env.HOST_IPS || '').split(',').map(s => s.trim()).filter(Boolean)) if (/^\d+\.\d+\.\d+\.\d+$/.test(x)) ips.add(x);
  return [...ips].sort();
}

// Liefert { key, cert, caPem, caDer, ips } oder wirft einen Fehler.
function ensureCerts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const F = n => path.join(dir, n);
  const read = n => { try { return fs.readFileSync(F(n)); } catch { return null; } };
  let caKeyPem = read('ca.key'), caDer = read('ca.der');
  let caKey, caPub;
  if (caKeyPem && caDer) {
    caKey = crypto.createPrivateKey(caKeyPem); caPub = crypto.createPublicKey(caKey);
  } else {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    caKey = kp.privateKey; caPub = kp.publicKey;
    caDer = issue({ subjectCn: 'Offline Chat CA', issuerCn: 'Offline Chat CA', pub: caPub, signKey: caKey, days: 3650, isCa: true });
    fs.writeFileSync(F('ca.key'), caKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(F('ca.der'), caDer);
    for (const old of ['server.key', 'server.pem', 'server.json']) try { fs.unlinkSync(F(old)); } catch {}
  }
  const ips = lanIps();
  let meta = null; try { meta = JSON.parse(read('server.json')); } catch {}
  const fresh = meta && JSON.stringify(meta.ips) === JSON.stringify(ips) && meta.until > Date.now() + 30 * 24 * 3600 * 1000 && read('server.key') && read('server.pem');
  if (!fresh) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = issue({ subjectCn: 'Offline Chat Server', issuerCn: 'Offline Chat CA', pub: kp.publicKey, signKey: caKey, issuerPub: caPub, days: 365, isCa: false, sans: [{ dns: 'localhost' }, ...ips.map(ip => ({ ip }))] });
    fs.writeFileSync(F('server.key'), kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(F('server.pem'), pem('CERTIFICATE', der) + pem('CERTIFICATE', caDer));
    fs.writeFileSync(F('server.json'), JSON.stringify({ ips, until: Date.now() + 365 * 24 * 3600 * 1000 }));
  }
  return { key: read('server.key'), cert: read('server.pem'), caDer, caPem: pem('CERTIFICATE', caDer), ips };
}

module.exports = { ensureCerts, lanIps };
