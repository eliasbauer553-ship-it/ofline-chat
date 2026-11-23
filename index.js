// Einstiegspunkt für die "Node JS Server"-App (erwartet Port 3000).
// Wenn server.js beim Start abstürzt, zeigt eine kleine Fehlerseite den Grund
// unter http://127.0.0.1:3000 an (statt nur "Server did not start").
process.env.PORT = process.env.PORT || '3000';
const http = require('node:http');
let listening = false;
function errorPage(err) {
  if (listening) return;
  listening = true;
  const text = 'Offline Chat konnte nicht starten:\n\n' + (err && err.stack || err);
  console.error(text);
  try {
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    }).listen(Number(process.env.PORT), '0.0.0.0');
  } catch (e) { console.error(e); }
}
process.on('uncaughtException', (err) => {
  console.error('Fehler:', err && err.stack || err);
  if (!global.__chatUp) errorPage(err);
});
process.on('unhandledRejection', (err) => console.error('Unhandled:', err && err.stack || err));
try {
  require('./server.js');
  setTimeout(() => { global.__chatUp = true; }, 3000);
} catch (err) {
  errorPage(err);
}
