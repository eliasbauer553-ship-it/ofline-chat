# Offline Chat – Office-Integration: Übergabe an den Nachtagenten

**Stand:** umgesetzt und gegen v6.2 getestet (`offline-chat-server-v6_3.zip`). Aufgabe des Nachtagenten: dieselben Änderungen in die **neueste Version** übernehmen, ohne Bestehendes zu brechen.

## 1. Was geliefert wird

| Datei | Inhalt |
|---|---|
| `offline-chat-server-v6_3.zip` | Fertige v6.3 (v6.2 + Office), startet mit `node index.js` |
| `office-integration.patch` | Unterschied v6.2 → v6.3 **ohne** Node-Module und ohne den gebauten Ordner `public/office/` (`diff -ruN`, Pfade `oc/…` → `v63/…`) |
| `office-build.zip` | Build-Kit für `public/office/` (Quellen der Editoren, Build-Skript, API-Test, README) |

**Neue Dateien:** `office.js`, `public/office-ui.js`, `public/office-ui.css`, `public/office/*` (gebaut).
**Geänderte Dateien (kleine Hooks):** `server.js`, `public/index.html`, `public/sw.js`, `package.json` (Version), `README.md`.

## 2. Übernahme in die neueste Version

1. Neueste Version sichern (ZIP-Kopie).
2. Neue Dateien kopieren (`office.js`, `public/office-ui.*`).
3. Hooks einbauen: zuerst `patch -p1 --dry-run` versuchen; schlägt etwas fehl, die Stellen **über Textanker** setzen (Zeilen können abweichen):
   - **server.js**
     - `db.wb=db.wb||{};` → danach `db.office=db.office||{nodes:{},links:[]};`
     - `const games = require('./games')({ PUBLIC, DATA, currentUser });` → danach `const office = require('./office')({ PUBLIC, DATA, currentUser, getDb: () => db, saveDb, canAccess, can, broadcast, rateOk });`
     - `if (games.handle(req,res,url)) return;` → danach `if (office.handle(req,res,url)) return;`
     - `function dropRoom(id){` → direkt dahinter `try{office.dropRoom(id)}catch(e){console.error(e.message)}`
     - In `/api/search`: Antwort um `office:office.search(user,q)` ergänzen (optional; die Oberfläche nutzt `/api/office/search`).
   - **public/index.html**: Rail-Knopf `#office-rail` vor `#games-divider`; Abschnitt `#office-panel` (Liste links, iframe `#of-frame` rechts) direkt vor `<section id="game-panel"`; `<link rel="stylesheet" href="/office-ui.css">` im `<head>`; `<script src="/office-ui.js">` **nach** `app.js`.
   - **public/sw.js**: `/office/` vom Cache ausnehmen (neben `/games/`), `/office-ui.js` und `/office-ui.css` in `SHELL`, Cache-Version erhöhen.
4. `office-build.zip` entpacken → `npm install && npm run build -- <Projektordner>` (Internet nur dafür nötig).
5. Tests (siehe 4.), `README.md`-Abschnitt „Neu in 6.3“ übernehmen, Version erhöhen.

`office-ui.js` hängt sich über **Globals von app.js** ein (`md`, `handleEvent`, `selectRoom`, `emit`, `toast`, `roomLabel`, `activeRoom`). Wurden diese in der neuesten Version umbenannt oder in ein Modul/IIFE verschoben, müssen die Hooks am Anfang von `office-ui.js` angepasst werden. Das ist die wahrscheinlichste Bruchstelle.

## 3. Funktionsumfang

- **Tabelle** (Univer Sheets) mit Filter, Sortieren, bedingter Formatierung, Datenprüfung, Hyperlinks, Notizen, Suchen/Ersetzen, Bildern, Tabellen-Objekten.
- **Dokument** (Univer Docs) mit Bildern und Links.
- **Präsentation** (eigener Editor): Layouts, Text, Formen, Linien, Bilder, Tabellen, Diagramme (Chart.js), Sprechernotizen, Rückgängig, Präsentationsmodus.
- **Verknüpfungen:** `[[office:<id>]]`-Karten im Chat, Teilen in den Raum, Tabelle ⇄ Board, Tabelle → Kalender, Notizen → Dokument, Board/Termine → Tabelle, Tabellenbereich → Dokument (Kopie) bzw. Folie (Tabelle/Diagramm), Folien aus Dokument-Gliederung, Rückverweise pro Datei, Office-Treffer unter der Chat-Suche.
- **Speichern:** Auto-Speichern mit Revisionsprüfung (Konflikt-Dialog), 20 Versionen, Papierkorb (30 Tage), Anzeige „X bearbeitet gerade“, Rechte = Raumrechte.
- **Import/Export:** xlsx, csv, docx, md, txt, pptx, PDF (Folien per Druckdialog).

## 4. Tests (alle gegen v6.2-Basis bestanden)

- Server-API: 25 von 25 (`tests/api-test.mjs` im Kit, mit **frischem** `DATA_DIR`).
- Konverter: xlsx/csv/docx/pptx-Rundläufe, Word-Rückimport (11 von 11).
- Folien-Editor und Chat-Oberfläche in einer simulierten Browser-Umgebung (jsdom): 15 von 15 bzw. 13 von 13.
- Univer-Tabelle und -Dokument starten in jsdom mit Canvas, Daten aus dem Import laden korrekt, Änderungen lösen Speichern aus.
- Auslieferung: gzip, ETag/304, kein Pfad-Ausbruch aus `/office/`.

## 5. Bekannte Grenzen (ehrlich)

1. **Nicht in einem echten Browser getestet** (weder iPad-Safari noch Android-Chrome). Bedienung per Touch, Layout, Speicherverbrauch und Druck/PDF sind ungeprüft. Das ist der erste Abnahmeschritt nach der Übernahme.
2. **Keine Echtzeit-Zusammenarbeit.** Bei gleichzeitigem Bearbeiten gibt es den Konflikt-Dialog. Univers Live-Kollaboration ist Pro-lizenzpflichtig; Yjs wurde nicht eingebaut.
3. **Univer-Pro-Funktionen fehlen:** Pivot, Diagramme **in Tabellen/Dokumenten** (nur Vorschau-Fenster mit PNG-Export und in Folien), Dokument-Tabellen/-Listen-Erweiterungen.
4. Einbettung in Dokumente ist eine **Kopie** mit Verweis, kein Live-Inhalt. Aktualisierung manuell.
5. Kein pptx-Import, kein PDF-Export für Tabellen/Dokumente, Office-Dateien sind nicht im Kanal-Export.
6. Erwähnungen (@) in Dokumenten lösen **keine** Push-Mitteilung aus; nur das Teilen im Chat ist verknüpft.
7. Das Board-Vollersetzen (`board`-Aktion im Client) verwirft das Feld `link` der Karten; erneutes Übertragen erkennt Karten dann am gleichen Text und legt keine Duplikate an.
8. Der Server nutzt nur Standardmodule (`node:fs`, `node:crypto`); die Node-Version der Android-App „Node JS Server“ ist unbekannt (benötigt ≥ 14.17 für `crypto.randomUUID`).
9. Gebautes Bundle: 15 MB, 3,7 MB komprimiert; `public/office/` enthält zusätzlich Silbentrennungs-Sprachdateien von Univer, die nur bei Bedarf geladen werden.

## 6. Vorschläge für die nächsten Schritte

Echtgeräte-Test und Fehlerbehebung → Push bei Erwähnungen → Yjs/Live-Zellen für Tabellen → pptx-Import → Office-Dateien in den Kanal-Export.
