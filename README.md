# AIDA Preisalarm

Beobachtet AIDA-Reisen: **wie viele Kabinen sind frei**, **was kostet es** — und gibt eine
begründete Einschätzung, ob man buchen oder noch warten sollte.

Läuft als einzelner Container auf dem VPS hinter Caddy, misst **alle vier Stunden** und
zusätzlich auf Knopfdruck. Mehrere Reisen gleichzeitig, jede mit eigenem Überwachungsende.

Live: <https://aida.weisser.dev>

---

## Was es misst

**Kabinen** — über dieselbe Abfrage, die die Kabinenwahl der Buchungsstrecke benutzt.
Gezählt wird, was dort tatsächlich wählbar ist, aufgeschlüsselt nach Unterkategorie und Deck.

**Preise** — die komplette Tabelle Kategorie × Tarif von euresa-reisen.de. Ein Seitenaufruf
liefert alle Zeilen auf einmal, deshalb wird die ganze Tafel mitgeschrieben, nicht nur die
Wunschzeile.

**Aktionen** — Name und Nachlass stehen an jeder Preiskachel („AIDA Herbst Deals",
„Preissenkung: −100 €"), der Gültigkeitszeitraum im Text der verlinkten Aktionsseite. Beides
wird gelesen, statt es von Hand in die Reisedatei zu tippen.

**Preisänderungs-Archiv** — euresa führt selbst Buch über jede Preisänderung (bei dieser
Reise über 2.500 seit dem 01.06.2025) und zeigt je Konstellation aus Kategorie, Tarif und
An-/Abreise die letzten zehn mit Datum, Betrag **und** Prozentwert. Das Programm holt sie
über die Livewire-Komponente der Reiseseite ab und führt sie in `aenderungen.csv` zusammen —
wer bei jedem Lauf abholt, sammelt mit der Zeit mehr als die zehn, die dort stehen.

**Vergleichstermine** — die Preistabellen der Nachbartermine derselben Reihe, vier Wochen
davor und danach.

Das Ergebnis landet als eine Zeile je Tag in `data/daten/<Reisecode>/`. Ein zweiter Lauf am
selben Tag **ersetzt** die Tageszeile, statt eine zweite anzuhängen — der Knopf verwässert
die Messreihe also nicht.

| Datei | Inhalt |
|---|---|
| `preise.csv` | eine Zeile je Tag, alle Kategorien × Tarife |
| `kabinen.csv` | freie Kabinen je Gruppe, nach Unterkategorie und Deck |
| `aenderungen.csv` | Preisänderungs-Archiv von euresa, je Konstellation und Datum |
| `vergleich.csv` | ein Datenpunkt je Lauf: wie viele Nachbartermine den Tarif noch haben |

### Das wichtigste Signal ist nicht die Kabinenzahl

Bei der AIDAcosma haben Meerblick, Verandakabine Deluxe und Junior-Suite schon jetzt keinen
LIGHT-Preis mehr — dort ist das Light-Kontingent aufgebraucht, obwohl die Kabinen physisch
frei sind. Das Kontingent eines Tarifs ist viel kleiner als die Zahl der freien Kabinen.
Verschwindet der Tarifpreis der Wunschkategorie, ist die Konstellation weg — lange bevor
das Schiff voll ist. Genau darauf zielt der Hauptalarm.

### Das Kontingent selbst ist nicht sichtbar

Es gibt **keine Zahl** dazu. Weder AIDA noch euresa weisen aus, wie viele Plätze ein Tarif
noch hat; die Kabinenabfrage liefert je Kabine nur Nummer, Kategoriecode, Deck und ob sie
wählbar ist — kein Tarif. Beobachtbar ist ausschließlich der Wegfall: wann eine Kategorie
ihren Tarifpreis verliert, und wie viele Nachbartermine ihn noch haben. Beides wird deshalb
als Zeitreihe geführt und in der Karte „Wie sich der Tarif zurückzieht" gezeigt. Alles
andere wäre geraten.

---

## Die Einschätzung

Oben auf der Seite steht „jetzt buchen", „bald entscheiden" oder „abwarten", darunter jedes
einzelne Signal mit seiner tatsächlichen Zahl. Bewertet werden:

| Signal | Wirkung |
|---|---|
| Preistrend (Ausgleichsgerade über die Messreihe), in € und % | steigend → buchen, fallend → warten |
| Richtung der Änderungen im euresa-Archiv | überwiegend nach oben → buchen, nach unten → warten |
| Kabinenabfluss pro Tag, hochgerechnet auf den Bestand | schneller Abfluss → buchen |
| Anzahl Kategorien, die den Tarif schon verloren haben | ≥ 3 → Kontingent zieht sich zurück |
| Kategorien, die den Tarif **während** der Beobachtung verloren haben | jede → buchen |
| Nachbartermine, die den Tarif seit Beobachtungsbeginn verloren haben | jeder → buchen |
| Tage bis Aktionsende | ≤ 7 → deutlich, ≤ 14 → leicht |
| Tage bis Abreise | < 60 → leicht |
| Preis auf dem bisherigen Tief | leicht (nur wenn der Preis sich überhaupt bewegt hat) |

Dazu zwei Zahlen, die das Warten beziffern statt es zu bewerten:

* **Rückfallrisiko** — fällt der Tarif weg, kostet dieselbe Kabine den nächstgünstigsten
  noch gelisteten Tarif. Der Unterschied wird in Euro und Prozent ausgewiesen. Das ist der
  Betrag, um den es beim Warten tatsächlich geht, und er ist oft kleiner als die Aufregung.
* **Drift** — was der Preis im Tempo der letzten Monate in 30 Tagen machen würde. Reine
  Fortschreibung des Archivs.

**Das ist ausdrücklich keine Vorhersage.** Die Regeln kennen weder AIDAs Kontingentplanung
noch die Nachfrage — sie fassen zusammen, was in der eigenen Messreihe und im euresa-Archiv
steht. Deshalb weist die Karte immer aus, wie viele Messungen über wie viele Tage
dahinterstehen, und warnt selbst, wenn die Datenlage dünn ist. Die Logik steckt in
`einschaetzung()` in `aida_watch.py` und ist in `selbsttest.py` mit Beispielreihen
abgesichert.

---

## Wie viele Abrufe ein Lauf kostet

| Aufruf | Anzahl | Ziel |
|---|---|---|
| Kabinenwahl | 1 | `cabins.php` (Buchungsstrecke) |
| Reiseseite | 1 | Preistafel, Aktionen, Livewire-Bausteine |
| Preisänderungs-Archiv | bis 14 | Livewire-Endpunkt derselben Seite |
| Vergleichstermine | 8 | Reiseseiten der Nachbartermine |
| Aktionsseite | höchstens alle 7 Tage 1 | Gültigkeitszeitraum |

Die Buchungsstrecke wird weiterhin **einmal** je Lauf angefasst. Alles andere sind Aufrufe
einer ganz normalen Website. Stellschrauben in `config.json` unter `verhalten`:

* `vergleich_alle_tage` — `0` = bei jedem Lauf (Voreinstellung), `n` = höchstens alle n Tage,
  `-1` = aus. Nachbartermine, die beim letzten Mal nicht gelesen werden konnten, erzwingen
  ohnehin einen neuen Versuch — sonst fehlen sie stillschweigend in jeder „X von Y"-Aussage.
* `archiv_konstellationen` — wie viele Kombinationen aus Kategorie und Tarif je Lauf aus dem
  Archiv geholt werden. `0` schaltet es ab.
* `aktion_pruefen_alle_tage` — wie oft der Gültigkeitszeitraum der Aktion nachgeschlagen wird.

---

## Deployment

Push auf `main` → GitHub Actions → Selbsttest → `scp` → `ssh` → `docker compose up -d --build`.
Genau wie vorher, nur ohne Node.

**Benötigte Secrets:** `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `SMTP_USER`,
`SMTP_PASS`, optional `MAIL_AN` (sonst geht die Mail an `SMTP_USER`), optional `NTFY_URL`
und `NTFY_TOKEN`.

Der Workflow sichert vor jedem Deploy `data/` nach `/opt/backups/aida/aida_<Zeitstempel>.tgz`
(die letzten zehn bleiben liegen), tauscht den Code aus, stellt `data/` zurück und wartet am
Ende darauf, dass der Container tatsächlich antwortet — sonst schlägt der Lauf fehl.

### Caddy

Der Container hängt im `caddy-net` und macht **kein** Port-Mapping. Caddy erreicht ihn also
unter seinem Containernamen. Die Datei gehört in den `sites/`-Ordner der Caddy-Installation:

```caddyfile
aida.weisser.dev {
    encode gzip zstd
    reverse_proxy aida-price-alarm:3000
}
```

Der Upstream heißt **`aida-price-alarm:3000`** — das ist der `container_name` aus der
`docker-compose.yml` und der Port aus `APP_PORT`. Zeigt der Block auf etwas anderes,
landet man auf dem falschen Dienst oder bekommt 502.

#### Optional: Passwortschutz

Die Anwendung selbst hat bewusst keine eigene Anmeldung. Wer die Seite nicht offen im Netz
haben will, lässt Caddy davorstehen:

```caddyfile
aida.weisser.dev {
    encode gzip zstd

    # Achtung: in Caddy 2.8.4 heisst die Direktive noch "basicauth".
    # Erst spaetere Versionen kennen "basic_auth" - 2.8.4 quittiert das
    # mit "unrecognized directive".
    basicauth {
        erik <bcrypt-hash>
    }

    reverse_proxy aida-price-alarm:3000
}
```

Hash erzeugen (fragt nach dem Passwort, statt es in der Shell-History zu hinterlassen):

```bash
docker run --rm -it caddy:2.8.4-alpine caddy hash-password
```

Ohne Schutz ist die Seite offen im Netz. Sie enthält nichts Geheimes, aber jeder Fremde
könnte den Aktualisieren-Knopf drücken und damit Abrufe auf der Buchungsstrecke auslösen.
Dagegen hilft auch ohne Passwort der Mindestabstand (`MINDESTABSTAND_SEKUNDEN`): mehr als
ein Abruf je Reise und Minute geht ohnehin nicht durch.

---

## Einstellungen

Alles über Umgebungsvariablen, siehe `.env.example`. Die wichtigsten:

| Variable | Bedeutung |
|---|---|
| `LAUF_INTERVALL_STUNDEN` | Messtakt in Stunden (4). Leer = kein Zeitplan, nur Knopf |
| `LAUF_OFFSET_MINUTEN` | Minute im Raster (7 → 00:07, 04:07, 08:07 …) |
| `MINDESTABSTAND_SEKUNDEN` | Sperre zwischen zwei Abrufen derselben Reise (60) |
| `AIDA_DATA_DIR` | wo die veränderlichen Daten liegen (im Container `/app/data`) |
| `APP_BASE_URL` | wird automatisch als erlaubter Hostname übernommen |
| `SMTP_*`, `MAIL_AN` | E-Mail-Meldung bei Alarm |
| `NTFY_URL`, `NTFY_TOKEN` | zusätzlich Push per ntfy |

Schwellen für die Alarme stehen in `config.json`. Liegt eine `config.json` im Datenverzeichnis,
gewinnt die — so überlebt eine Anpassung den nächsten Deploy.

---

## Reisen verwalten

Auf der Seite: Reisecode eintragen (steht in jeder AIDA-URL, z. B. `CO07261003`), „Reise
suchen". Der Server holt Titel, Termin, Preistabelle und probiert die Kabinencodes durch,
bis er weiß, welche Kategorien das Schiff hat — mitsamt freien Kabinen. Anhaken, Wunschkabine
und Flugkosten wählen, fertig. Die erste Messung passiert gleich mit.

Jede Reise ist danach eine Datei unter `data/reisen/<Code>.json`. Die Kabinencodes der
AIDAcosma:

| Kategorie | Codes |
|---|---|
| Innenkabine | `IA` `IB` `IC` |
| Meerblickkabine | `MA` |
| Balkonkabine | `BA` `BB` `BC` |
| Verandakabine Komfort | `VA` `VB` `VC` |
| Verandakabine Deluxe | `DA` `DB` |
| Junior-Suite | `JB` |

Balkonkabine und Verandakabine Komfort sind **verschiedene** Kategorien — im LIGHT-Tarif
zufällig gleich teuer (2.258 €), ab PREMIUM nicht mehr (2.900 € vs. 3.030 €).

---

## Die zwei Preisdarstellungen

Sie widersprechen sich nicht, sie messen Verschiedenes:

- **euresa-reisen.de** → Gesamtpreis **pro Kabine, ohne Flug**. Das misst dieses Werkzeug.
- **aida.de** → **pro Person, inklusive Flug**. Das sieht man beim Buchen.

```
p.P. inkl. Flug = (Kabinenpreis + Flugkosten für alle Reisenden) / Anzahl Reisende
```

Für die AIDAcosma: ERF 1.000 €, MUC 800 € (je 2 Personen), am 15.08.2026 dreifach gegen
aida.de belegt. **Die Flugkosten sind eine Annahme, kein gemessener Wert** — bewegt sich der
echte Flugpreis, bleibt das unsichtbar und der Check meldet fälschlich „unverändert".

---

## Von Hand

```bash
python3 selbsttest.py                    # Auswertung prüfen, ohne Netz
python3 aida_watch.py                    # alle aktiven Reisen messen
python3 aida_watch.py --code CO07261003  # nur eine
python3 aida_watch.py --trocken          # abrufen und anzeigen, nichts schreiben
python3 aida_watch.py --status           # kompletter Stand als JSON
python3 server.py --port 8777            # Oberfläche lokal
```

Im Container: `docker exec aida-price-alarm python3 aida_watch.py --status`

Es braucht **keine** Fremdbibliotheken — reine Standardbibliothek, Python ≥ 3.9.

---

## Anstand gegenüber den Quellen

`aida.euresa-reisen.de` ist eine fremde Buchungsstrecke und per robots.txt für automatisierte
Zugriffe gesperrt. Sechs Abrufe am Tag plus gelegentliches Nachsehen von Hand ist etwas
anderes als ein Crawler. Alle Kategorien einer Reise werden in **einem** Aufruf abgefragt,
und der Mindestabstand verhindert Klick-Gewitter. Bitte nicht enger takten und
`MINDESTABSTAND_SEKUNDEN` nicht auf 0 setzen.

---

## Wenn etwas nicht mehr geht

| Symptom | Ursache und Abhilfe |
|---|---|
| Seite lädt nicht | `docker compose -p aida-price-alarm logs -f aida-app` |
| Überall 403 | Host stimmt nicht — `APP_BASE_URL` prüfen oder `AIDA_ALLOWED_HOSTS` setzen |
| `Preisabschnitt nicht gefunden` | euresa hat das Layout geändert — Seite ansehen, `parse_preise()` nachziehen, `selbsttest.py` anpassen |
| `Kabinenabruf HTTP 403/404` | Buchungsstrecke geändert — Kabinenwahl im Browser öffnen, im Netzwerk-Tab `cabins.php` ansehen |
| Messreihe weg | `/opt/backups/aida/` — die letzten zehn Sicherungen liegen dort |
| Kategorien beim Anlegen nicht erkannt | Präfix fehlt in `config.json` → `kategorie_prefixe` |

---

## Aufbau

| Datei | Inhalt |
|---|---|
| `aida_watch.py` | Abruf, Auswertung, Einschätzung, Alarme. Auch als CLI |
| `server.py` | Oberfläche, API, Zeitplan |
| `selbsttest.py` | Prüfungen ohne Netz — Qualitätstor im Workflow |
| `config.json` | globale Einstellungen, Tarif- und Kategorienamen |
| `web/index.html` | die Seite, alles inline, keine Fremdskripte |
| `vorgaben/` | Startbestand: wird beim ersten Start in ein leeres `data/` kopiert |
| `data/` | die veränderlichen Daten (Volume, nicht im Repo) |
