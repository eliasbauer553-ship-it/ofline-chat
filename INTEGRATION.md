# Apps und Office-Suite einbinden (Offline Chat 6.3)

Jede App ist ein Ordner mit einer `index.html` (statische Dateien, kein eigener Server nötig). Sie läuft im Chat als iframe rechts neben der Serverleiste.

## 1. Eintragen

`public/apps/apps.json` (Office und andere Apps) bzw. `public/games/games.json` (Spiele) – gleiche Felder:

```json
[{
  "id": "office",
  "name": "Office",
  "short": "OF",
  "icon": "/apps/office/icon.svg",
  "color": "#2b7de9",
  "url": "/apps/office/",
  "desc": "Texte, Tabellen, Präsentationen",
  "storage": ["office."]
}]
```

- `icon`: SVG/PNG (weiß auf transparentem Grund, wird auf `color` gelegt).
- `storage`: Präfixe von `localStorage`-Schlüsseln, die automatisch pro Konto auf dem Server gesichert und auf neuen Geräten wiederhergestellt werden (Autosave). Sie landen auch im Backup.

Eine Beispiel-App liegt in `public/apps/_demo/` (nicht eingetragen). Zum Ausprobieren den Eintrag aus dem Beispiel oben mit `"url": "/apps/_demo/"` in `apps.json` setzen.

## 2. Schnittstelle `window.parent.OCAPP`

Same-Origin: Die App ruft sie direkt auf.

| Bereich | Funktionen |
|---|---|
| Nutzer & Kanäle | `OCAPP.user`, `OCAPP.users()`, `OCAPP.rooms()`, `OCAPP.activeRoom` |
| Dokumente | `docs.list({room,type})`, `docs.get(id)`, `docs.create({type,title,content,roomId})`, `docs.save(id,{content,title,baseVersion})`, `docs.remove(id)`, `docs.share(id, roomId)`, `docs.history(id)`, `docs.version(id,v)`, `docs.onChange(fn)` |
| Dateien | `OCAPP.uploadFile(blob, "Name.docx", roomId?)` – legt Exporte (docx/xlsx/pptx/pdf) als Datei in den Kanal |
| Live-Zusammenarbeit | `OCAPP.mp.setLevel(dokumentId)`, `mp.send(daten)`, `mp.onState(fn)`, `mp.players()`, `mp.onPlayers(fn)` – Nachrichten gehen nur an Personen im selben „Level“ (= Dokument), max. 8 KB je Nachricht |
| Navigation | `OCAPP.open(appId, "doc=…")`, `OCAPP.close()`, `OCAPP.link(appId, query)` |
| Sonstiges | `OCAPP.toast(text)` |

Dokumenttypen sind frei wählbar (`doc`, `sheet`, `slides` …). Der Inhalt ist ein String (z. B. JSON), bis 6 MB. `docs.save` verlangt `baseVersion`; bei Konflikt kommt ein Fehler mit `status 409` und `data.content` / `data.meta` der neueren Version. Je Dokument bleiben die letzten 20 Versionen.

## 3. Verknüpfungen im Chat

- `docs.share(id, roomId)` schreibt eine Nachricht mit Link `…/#app=<appId>&doc=<id>`. Ein Klick darauf öffnet die App mit `?doc=<id>`; die App liest das aus `location.search`.
- Dokumente mit `roomId` sehen alle Mitglieder des Kanals; ohne `roomId` nur der Besitzer.
- Änderungen melden sich über `docs.onChange` (`{id, version, by, deleted}`) – Grundlage für Live-Aktualisierung.
- Alles liegt in `data/docs/` (Dokumente), `data/gamedata/` (Autosave) und wird vom Backup erfasst.

## 4. Office (ab 7.0)

Die mitgelieferte Office-Suite hat einen eigenen Speicher (`/api/office/*`, `data/office/`) und braucht diese Schnittstelle nicht. Aus Apps öffnest du sie mit `OCAPP.openOffice(id)` oder dem Link `#office=<id>`.
