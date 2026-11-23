# Offline Chat 7.1

## Neu in 7.0

- **Office-Suite integriert:** Tabellen (Univer Sheets), Dokumente (Univer Docs) und Präsentationen (eigener Editor). Symbol in der Serverleiste, Dateien pro Raum, Auto-Speichern mit Versionsverlauf (20 Versionen), Papierkorb, Import/Export (xlsx, csv, docx, md, txt, pptx, PDF-Druck).
- **Verknüpfungen:** `[[office:<id>]]`-Karten im Chat, Teilen in den Raum, Tabelle ⇄ Aufgaben-Board, Tabelle → Kalender, Notizen → Dokument, Tabellenbereich → Dokument/Folie, Office-Treffer in der Chat-Suche. Deep-Link `#office=<id>`.
- **Alle Symbole sind echte SVG-Icons – keine Emojis:** Office-Oberfläche, Editor, Folien-Werkzeugleiste, Nachrichtenleiste, Umfragen, Kanban, Spielkopf und Logo. (Emojis gibt es nur noch als Inhalt: Reaktionen und die Emoji-Auswahl für Nachrichten.)
- **Backup** enthält jetzt auch alle Office-Dateien (`data/office/`).
- Der gebaute Ordner `public/office/` ist fertig mitgeliefert. Wer ihn neu bauen will: `office-build/` (siehe dessen README, braucht Internet nur beim Bauen). Details und bekannte Grenzen: `OFFICE.md`.

---

## 6.3

## Neu in 6.3

- **Backup mit einem Klick:** Einstellungen → Datensicherung (nur Admins): Backup herunterladen / einspielen. Enthält Konten, Nachrichten, Dateien, Spielstände, Zertifikate. Bei frischer Installation gibt es auf der Login-Seite „Backup einspielen“. Beim ersten Start einer neuen Version wird der alte Stand automatisch als `vor-update-…tar.gz` unter `data/backups/` gesichert. Wichtig: `data/` liegt neben dem Programm – vor dem Ersetzen des Ordners Backup herunterladen.
- **Sprach-/Videoanrufe:** Telefon-Symbol im Kanalkopf (Mikrofon, Kamera, Bildschirm teilen, bis 8 Personen). Braucht HTTPS (`/zertifikat`).
- **Autosave für alle Spiele:** Spielstände werden pro Konto auf dem Server gesichert und auf neuen Geräten wiederhergestellt (`data/gamedata/`).
- **Mehrspieler:** Anzeige, wer gerade spielt (Zahl am Spiel-Symbol, Mitspielerliste, Einladung in den Chat). Geometry Dash: Mitspieler im selben Level als Live-Geister.
- **Sprachnachrichten:** Mikrofon-Symbol in der Eingabeleiste, Wiedergabe direkt im Verlauf (braucht HTTPS).
- **Office-Vorbereitung:** gemeinsame App-Registry (`public/apps/apps.json`), App-Schnittstelle `OCAPP`, versionierter Dokumentenspeicher, Deep-Links `#app=…&doc=…` – siehe `INTEGRATION.md`.
- **Spiel-Symbole** sind jetzt SVG-Icons (`public/games/icons/`, eingetragen in `games.json`).
- **Fixes:** Geometry-Dash-Menü sitzt wieder zentral; Grafikspeicher wird beim Spielwechsel freigegeben; Hofkönig lädt bei verlorenem Grafikkontext einmal neu; Ladeanzeige bleibt, bis Hofkönig das erste Bild zeichnet.

---

## 6.2

## Neu in 6.2 – Spiele in der Serverleiste

Unter den Servern (nach dem Trenner) erscheinen jetzt Spiele-Symbole. Ein Klick öffnet das Spiel im Hauptbereich, ein Klick auf einen Server, das ⌂ oder auf ✕ bringt den Chat zurück. Oben im Spiel gibt es „Neu laden“ und „Vollbild“ (Vollbild nur dort, wo der Browser es erlaubt, z. B. iPad).

Enthalten:

- **GH Arcade** – 17 Arcade-Spiele (Snake, Breakout, Pong, Pinball, Tetris-artiges „Stack“ …), Bestenlisten/Trophäen lokal im Browser
- **Geometry Dash** – Rhythmus-Platformer mit 22 Levels (Handy im Querformat halten)
- **Hofkönig** – 3D-Farm-Tycoon. Der Spielstand liegt im Browser und wird zusätzlich auf dem Chat-Server gesichert (`data/hofkoenig/`). Bestenliste funktioniert im lokalen Netz. Der **Kampfmodus** braucht den Cloudflare-Server und ist hier nicht verfügbar.

Alles läuft komplett offline (Schriften und three.js liegen lokal). Spielstände liegen im Browser des jeweiligen Geräts; beim Verlassen eines Spiels wird es beendet (der Fortschritt bleibt gespeichert, ein laufender Level nicht).

### Eigenes Spiel hinzufügen

1. Ordner `public/games/<name>/` mit einer `index.html` anlegen (alle Dateien müssen lokal liegen, keine CDN-Links; Pfade relativ oder mit `/games/<name>/…`).
2. In `public/games/games.json` einen Eintrag ergänzen: `{ "id": "name", "name": "Anzeigename", "icon": "🎲", "color": "#7a5cff", "url": "/games/name/", "desc": "Kurzbeschreibung" }`
3. Server neu starten bzw. die Seite neu laden.

Technik: `games.js` liefert `/games/` aus (Ordner-Index, Audio-Range für iPad, ETag-Cache) und enthält die Hofkönig-Schnittstelle. Der Service Worker legt Spiele nicht in den Chat-Cache.

---

# Offline Chat 6.1

## Neu in 6.1

- **Layout-Fix:** Eingabeleiste bleibt immer sichtbar, der Nachrichtenverlauf scrollt zuverlässig (auch mit iPad-Tastatur und Home-Indikator).
- **Keine flackernden Bilder mehr:** Nachrichten werden nicht mehr komplett neu aufgebaut, Bilder werden vom Browser dauerhaft zwischengespeichert, fehlgeschlagene Bilder laden sich selbst nach. Die Scroll-Position bleibt bei Updates erhalten.
- **Dialoge & Untermenüs:** Kopfzeile bleibt stehen, Inhalt scrollt, Rolleneditor (Name + Farbe), Farbfelder, Schalter und Knöpfe haben feste, passende Größen; auf dem Handy öffnen Dialoge als Sheet von unten; Seitenleisten lassen sich per Tipp daneben schließen.
- **Mitteilungen auf dem iPad:** Glocke → Einrichtungs-Assistent mit Statusliste und „Test senden“. Der Server erzeugt die Push-Schlüssel (VAPID) selbst und stellt automatisch ein HTTPS-Zertifikat aus – **auf demselben Port** (HTTP und HTTPS parallel). Anleitung für das iPad: `http://<Handy-IP>:<Port>/zertifikat`.
- **Synchronisation:** Aufgaben-Board arbeitet jetzt mit Einzel-Aktionen (zwei Personen können gleichzeitig Karten anlegen, nichts geht verloren), Notizen haben Versionen und werden bei gleichzeitigem Bearbeiten zeilenweise zusammengeführt, Kalender aktualisiert sich live, geplante Nachrichten/Kanal-Einstellungen/Gelesen-Status gelten auf allen eigenen Geräten, Verbindungs-Wächter erkennt „eingeschlafene“ Verbindungen (iPad im Standby) und verbindet neu.
- **QR-Code:** Auf der Login-Seite (und unter Einstellungen) „QR-Code für andere Geräte anzeigen“.

### Push auf dem iPad in Kürze
1. Auf dem iPad `http://<Handy-IP>:<Port>/zertifikat` öffnen, Zertifikat laden, installieren und unter *Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen* aktivieren (einmalig; bei IP-Wechsel nicht erneut nötig).
2. `https://<Handy-IP>:<Port>` öffnen, anmelden, *Teilen → Zum Home-Bildschirm*.
3. App vom Home-Bildschirm starten → Glocke → „Mitteilungen aktivieren“ → „Test senden“.

Das Handy braucht Internet (mobile Daten), damit Apple die Mitteilung zustellt. Mit `NO_TLS=1` lässt sich HTTPS abschalten.

---

Lokaler Mehrraum-Chat für einen Samsung-Android-Server (Node.js) und iPads mit Safari. Kein Cloudkonto, keine externen APIs, keine CDN-Ressourcen.

## Enthaltene Funktionen

- Lokale Registrierung und Anmeldung mit Passwort-Hashing (`scrypt`)
- Erstes registriertes Konto wird Administrator
- Mehrere Textkanäle; Administrator/Moderator kann Kanäle erstellen
- Echtzeitnachrichten über WebSocket
- Threads / Antworten auf Nachrichten
- Emoji-Reaktionen
- Nachrichten löschen (eigene Nachrichten; Administratoren dürfen alle löschen)
- Nachrichten anheften/loslösen (Admin/Moderator)
- Umfragen mit Abstimmung
- Nachrichtensuche
- Benutzerprofile mit Anzeigename, Kurzinfo und Farbe
- Mitgliederübersicht; Administratoren können Mitglieder zu Moderatoren machen und zurückstufen
- Dateifreigabe bis 25 MB pro Datei; Speicherung im lokalen Datenordner
- Dateiübersicht pro Kanal und Download
- Echte Web-Push-Mitteilungen über Service Worker und VAPID, auch wenn die installierte Web-App im Hintergrund ist (HTTPS erforderlich)
- Dark-/Light-Ansicht, responsive iPad-Oberfläche, einklappbare Seitenleisten
- Push-Abonnement pro Benutzer/Gerät; abgelaufene Abonnements werden automatisch entfernt
- Verbesserte Thread-Navigation, klickbare Suchtreffer und Wiederverbindungs-/Sende-Fehlerbehandlung
- Wiederverbindung bei WLAN-/WebSocket-Unterbrechung

## Installation auf dem Samsung-Gerät

1. Installiere eine Node.js-Umgebung für Android, z. B. Termux aus einer vertrauenswürdigen Quelle, oder eine andere Node.js-Laufzeit.
2. Kopiere den gesamten Projektordner auf das Samsung-Gerät.
3. Öffne ein Terminal im Projektordner und führe aus:

   ```sh
   npm install
   npm start
   ```

4. Der Server lauscht standardmäßig auf Port `8080`.
5. Aktiviere den Samsung Mobile Hotspot oder verbinde Samsung und iPads mit demselben WLAN.

### Push-Mitteilungen einrichten (iPad)

Web-Push auf iPadOS benötigt iPadOS 16.4 oder neuer, die zum Home-Bildschirm hinzugefügte Web-App und HTTPS mit einem Zertifikat, dem das iPad vertraut. Reines `http://192.168.x.x:8080` reicht nicht. Ohne HTTPS kann die Chat-App weiterhin im geöffneten Vordergrund genutzt werden, aber keine zuverlässigen Push-Mitteilungen zustellen.

1. Installiere die Abhängigkeiten mit `npm install`.
2. Erzeuge VAPID-Schlüssel: `npm run vapid`. Kopiere `publicKey` und `privateKey` aus der Ausgabe sicher in die Umgebungsvariablen `VAPID_PUBLIC_KEY` und `VAPID_PRIVATE_KEY`. Als `VAPID_SUBJECT` z. B. `mailto:admin@offline-chat.local` setzen.
3. Ermittle die feste lokale IP des Samsung-Geräts (Beispiel `192.168.43.1`) und erzeuge ein lokales Zertifikat mit IP-SAN. Beispiel in Termux (ersetze die IP):

   ```sh
   IP=192.168.43.1
   openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
     -keyout server.key -out server.crt -subj "/CN=$IP" \
     -addext "subjectAltName=IP:$IP" \
     -addext "basicConstraints=critical,CA:TRUE" \
     -addext "keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment" \
     -addext "extendedKeyUsage=serverAuth"
   ```

   Übertrage nur `server.crt` auf jedes iPad, installiere es als Profil und aktiviere unter **Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen** das vollständige Vertrauen. `server.key` bleibt ausschließlich auf dem Samsung. Bei einer geänderten Samsung-IP muss das Zertifikat neu erstellt und erneut vertraut werden.
4. Starte den Server mit `TLS_KEY=/pfad/server.key TLS_CERT=/pfad/server.crt VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:admin@offline-chat.local npm start`. HTTPS verwendet denselben Port 8080.
5. Öffne `https://LOKALE-IP:8080` auf dem iPad, füge die App über **Teilen → Zum Home-Bildschirm** hinzu und starte sie über das neue Symbol.
6. Melde dich an und tippe auf das Glocken-Symbol. Erlaube Mitteilungen. Ohne VAPID-Konfiguration zeigt die App lokale Mitteilungen, solange iPadOS die Verbindung im Hintergrund weiterlaufen lässt; mit VAPID-Konfiguration kann Apple Web-Push auch nach dem Anhalten der App zustellen.

VAPID-Privatschlüssel und TLS-Schlüssel niemals weitergeben. Für echte Hintergrund-Push-Mitteilungen müssen Samsung-Server und iPad die Apple-/Browser-Push-Dienste über das Internet erreichen können. Nachrichten und Chat-Daten bleiben auf deinem lokalen Server; die Push-Zustellung selbst funktioniert jedoch nicht in einem vollständig vom Internet getrennten WLAN. Ohne Internet bleibt nur die lokale Mitteilung, solange die App aktiv genug ist.
6. Ermittle die lokale IP-Adresse des Samsung-Geräts. Öffne auf jedem iPad in Safari:

   `http://LOKALE-IP:8080`

7. Lege das erste Konto an. Dieses Konto erhält Administratorrechte. Weitere Personen registrieren eigene Konten.

### Daten und Sicherung

Alle dauerhaften Daten liegen im Ordner `data/`:
- `data/database.json`: Benutzer, Räume, Nachrichten, Umfragen und Dateimetadaten
- `data/uploads/`: hochgeladene Dateien

Server vor dem Kopieren/Backup sauber mit `Ctrl+C` beenden. Den gesamten Ordner `data/` regelmäßig sichern. Wer Zugriff auf den Server-Dateispeicher hat, kann dort auch die Daten lesen; die Datenbankdatei ist nicht verschlüsselt.

## Sicherheitshinweise

- Nur für ein vertrauenswürdiges privates LAN verwenden.
- Passwörter werden mit Node.js `scrypt` gehasht; sie werden nicht im Klartext gespeichert.
- Die Sitzung wird in einem HttpOnly-Cookie gehalten.
- Der Server prüft lokale IP-Bereiche und den Origin. Das ist eine zusätzliche Hürde, aber kein Ersatz für ein abgesichertes WLAN und ein aktuelles Gerät.
- Verwende ein starkes, individuelles Passwort. Teile den Hotspot-Schlüssel nur mit den gewünschten Teilnehmern.
- Die App nutzt HTTP im lokalen Netz. Verwende sie nicht über öffentliches WLAN oder Portweiterleitung ins Internet.
- Datei-Upload ist auf 25 MB begrenzt. Uploads werden unter zufälligen Server-Dateinamen gespeichert.
- Benutzerkonten sind lokal; ein vergessenes Passwort kann in dieser Version nicht selbst zurückgesetzt werden. Der Administrator muss bei Bedarf den lokalen Datenbestand verwalten.

## Grenzen von Android und iPadOS

- Android-Hotspot-Verfügbarkeit und Hintergrundbetrieb hängen von Android-Version, Hersteller und Laufzeitumgebung ab. Der Server muss im Vordergrund bzw. mit geeigneter Akku-Ausnahme laufen.
- iPadOS kann Safari-Tabs im Hintergrund anhalten. Echtzeit und Browser-Benachrichtigungen sind daher nicht garantiert, wenn Safari geschlossen oder stark inaktiv ist.
- Web-Push benötigt HTTPS, eine Home-Bildschirm-Web-App und iPadOS 16.4+. Die Zustellung über Apples Push-Infrastruktur benötigt Internetzugang; bei vollständig offline betriebenem WLAN sind Hintergrund-Push-Mitteilungen nicht garantiert.
- Voice-/Videochat ist nicht enthalten. WebRTC-Mikrofonzugriff ist auf lokalen HTTP-IP-Adressen in Safari eingeschränkt und benötigt typischerweise einen sicheren Kontext.
- Die Zielgröße von 50 Teilnehmern hängt von Samsung-Hardware, WLAN-Qualität, Nachrichtendichte und Node.js-Laufzeit ab. Vor produktivem Einsatz mit der tatsächlichen Gerätezahl testen.

## Architektur

- Node.js HTTP-/optional HTTPS-Server für UI, Anmeldung, Profile, Suche, Push und Upload/Download
- `ws` für Echtzeitnachrichten
- `web-push` für verschlüsselte Web-Push-Zustellung (VAPID)
- JSON-Datei als persistenter lokaler Datenspeicher (keine native Datenbankkompilierung auf Android erforderlich)
- Dateispeicher auf dem Samsung-Gerät

## Startoptionen

Port ändern:

```sh
PORT=8090 npm start
```

Die Anwendung benötigt nach der Installation keine Internetverbindung. `npm install` muss allerdings vor dem Offline-Betrieb ausgeführt werden; alternativ das fertige Projekt samt `node_modules` auf das Gerät übertragen.

## Neu in 3.0

Discord-Look (Farben, Hover-/Tipp-Werkzeugleiste, gruppierte Nachrichten, Tagesseparatoren), Nachrichten bearbeiten, "schreibt …"-Anzeige, Ungelesen-Zähler pro Kanal, Online-Status der Mitglieder, Emoji-Picker statt Texteingabe, eigener Lösch-Dialog, Markdown-Light (`**fett**`, `*kursiv*`, `` `code` ``, Links), @Erwähnungen, Bilder/Dateien erscheinen als Nachricht (Bildvorschau; Upload per Button, Einfügen oder Drag & Drop), Enter sendet / Shift+Enter neue Zeile.

## Neu in 3.1

**Speicherung:** Konten, Kanäle, Nachrichten, Notizen, Lesestatus und geplante Nachrichten liegen in `data/database.json`, Anmeldungen in `data/sessions.json` (30 Tage gültig). Nach einem Neustart ist alles wieder da, auch die Anmeldung auf dem iPad. Täglich wird automatisch ein Backup in `data/backups/` angelegt (die letzten 7 bleiben). Beim Beenden (Strg+C / SIGTERM) wird sofort gespeichert.

**Neu:** Direktnachrichten, Kanäle umbenennen/löschen, Kategorien, private Kanäle, Langsamer Modus, Mitglieder entfernen, Passwort durch Admin zurücksetzen, Admin-Protokoll, Profilbilder (auf den eigenen Avatar tippen), ältere Nachrichten nachladen, Ungelesen-Zähler und Entwürfe bleiben erhalten, gemeinsame Kanal-Notizen, geplante Nachrichten, Dateibrowser mit Filter, Export als Textdatei, Bild-Vollansicht, "Zu neuesten springen", Ton/Vibration bei @Erwähnung, @everyone, WebSocket-Ping und automatisches Wiederverbinden. Das X der rechten Leiste schließt sie jetzt auch auf großen Bildschirmen; alle Symbole sind SVG-Icons.

**Betrieb auf dem Handy (Termux):** `termux-wake-lock` ausführen, dann `npm start`. Die Adresse für das iPad steht beim Start im Terminal.

## Neu in 4.0

Aufgaben-Board, Kalender mit Chat-Erinnerung (15 Min. vorher), Whiteboard, Umfragen (Mehrfachauswahl, Ablaufzeit, anonym), Einladungscodes und Registrierungsmodus, Admin-Dashboard, "Neu"-Linie, Erwähnungen-Übersicht, Kanal-Benachrichtigungen (alle / nur Erwähnungen / stumm), schreibgeschützte Kanäle, Nutzer stummschalten, Status (Online/Abwesend/Nicht stören + Text), Profil-Popup, Zitate/Spoiler/Listen/Durchgestrichen, Bearbeitungsverlauf, Weiterleiten, echte Antworten mit Zitat, PDF-/Text-Vorschau, Bildergalerie, Akzentfarben, kompakter Modus, Offline-Start der Oberfläche (Service Worker).

Wichtig: Version 3.1 hat Lesestatus, Notizen, geplante Nachrichten und das Admin-Protokoll beim Neustart verworfen. In 4.0 ist das behoben (alle Felder der Datenbank bleiben erhalten).

## Neu in 5.0

**Eigene Server:** Jede Person kann bis zu 5 eigene Server mit Kanälen erstellen (Plus-Button in der linken Leiste). Server sind privat (Einladungscode oder direktes Hinzufügen) oder öffentlich (erscheinen in der Liste, jeder kann beitreten). Der bisherige Chat ist der Hauptserver „Allgemein“; neue Konten treten ihm automatisch bei.

**Rollen pro Server:** Auf Tipp auf den Servernamen öffnen sich die Server-Einstellungen: Name, Farbe, Sichtbarkeit, Einladungscodes, Nutzer hinzufügen, eigene Rollen mit den Rechten *Verwalten* (Kanäle, Rollen, Mitglieder), *Moderieren* (fremde Nachrichten löschen, anheften, Schreibschutz umgehen) und *Einladen*. Rollen werden in der Mitgliederliste zugewiesen. Der Besitzer hat immer alle Rechte, der Seiten-Admin ebenfalls.

**Whiteboard 2.0:** Vollbild, unendliche Fläche (zoomen mit zwei Fingern oder Strg+Scrollen), Stift mit Druckempfindlichkeit, Textmarker, Radierer, Linie, Pfeil, Rechteck, Ellipse (optional gefüllt), Text, Haftnotizen, Auswahl zum Verschieben, Duplizieren und Löschen, Rückgängig/Wiederholen, 12 Farben plus freie Farbe, 4 Strichstärken, Raster, heller/dunkler Hintergrund, Live-Striche der anderen, Export als PNG. Apple Pencil: Der Pencil zeichnet, der Finger verschiebt die Ansicht (schaltbar über „Nur Pencil“). Auf dem iPad wandelt Scribble Handschrift in Textfeldern in Text um.
