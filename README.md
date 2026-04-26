# AIDA Preisalarm

Kleines Node.js Frontend + Backend, das täglich die AIDA-Preise abholt, alle Reisen anzeigt und Nutzer per E-Mail benachrichtigt, sobald ein Tarif für eine gemerkte Reise günstiger wird oder ein neuer, günstigerer Tarif freigeschaltet ist.

## Features

- **Express-Backend** mit SQLite (better-sqlite3) als Speicher
- **Täglicher Cron-Scrape** (`node-cron`) – Standard 06:15 Uhr
- **Austauschbarer AIDA-Adapter** (`src/services/aidaAdapter.js`)
- **Mock-Modus** mit täglich leicht schwankenden Preisen, damit das System sofort funktioniert (auch ohne Live-Endpoint)
- **Frontend** (Vanilla HTML/JS, keine Build-Tools) mit Filter, Suche und „Merken“-Dialog
- **Merkliste pro E-Mail-Adresse**, abrufbar via E-Mail (kein Login)
- **Mail-Benachrichtigung** über `nodemailer` (SMTP). Ohne SMTP werden Mails auf stdout geloggt.
- **Abmeldelink** in jeder Mail (`/unsubscribe/<token>`)

## Schnellstart

```bash
cp .env.example .env
npm install
npm start
```

Die App läuft danach auf <http://localhost:3000>. Beim ersten Start wird automatisch ein erster Scrape ausgeführt, damit die Übersicht nicht leer ist.

## Live-Modus (echte AIDA-Preise)

1. Den tatsächlichen JSON-Endpoint der AIDA „Reisefinder“-API ermitteln (Browser-DevTools, Tab Netzwerk).
2. In `.env` setzen:
   ```
   USE_MOCK=false
   AIDA_API_URL=https://...   # der ermittelte Endpoint
   ```
3. Falls die Antwortstruktur abweicht, die Funktion `normaliseAidaResponse` in `src/services/aidaAdapter.js` anpassen. Das ist die einzige Stelle, die das Live-Format kennt.

## Wichtige Routen

| Route | Beschreibung |
|-------|--------------|
| `GET  /` | Frontend |
| `GET  /api/cruises` | Liste aller Reisen, mit Filtern `q`, `ship`, `destination`, `limit`, `offset` |
| `GET  /api/cruises/filters` | Verfügbare Schiffe und Zielgebiete |
| `GET  /api/cruises/:id` | Detail inkl. Preisverlauf |
| `POST /api/watch` | `{ email, cruiseId }` – Reise merken |
| `GET  /api/watch?email=` | Merkliste für eine E-Mail |
| `DELETE /api/watch/:token` | Eintrag entfernen |
| `GET  /unsubscribe/:token` | Abmelde-Link aus den Mails |
| `GET  /api/status` | Diagnose (letzter Scrape, Counts) |

## CLI

```bash
npm run scrape   # einmaligen Scrape ausführen + ggf. Mails versenden
npm run notify   # nur Benachrichtigungen prüfen/versenden
```

## Datenmodell (SQLite)

- `cruises` – Stammdaten je Reise
- `prices` – Preis-Snapshot pro Tarif/Cabin und Zeitpunkt (append-only)
- `watchlist` – E-Mail + Cruise + Baseline-Preis + Unsubscribe-Token
- `scrape_runs` – Audit-Log

## E-Mail-Logik

Beim Anlegen eines Watchlist-Eintrags wird der aktuell günstigste Tarif als „Baseline“ gespeichert. Nach jedem Scrape wird der neue beste Tarif verglichen. Liegt er unter der Baseline, geht eine Mail raus und die Baseline wird aktualisiert (sodass nicht bei jedem Scrape erneut gemailt wird, solange der Preis gleich bleibt). Steigt der Preis wieder, bleibt die Baseline, sodass beim nächsten Drop wieder gemailt wird.

## Hinweis zum Scraping

Das Skript greift nur lesend auf öffentlich verfügbare Daten zu und schickt einen klar identifizierbaren User-Agent. Vor produktivem Einsatz `robots.txt`, AGB und Frequenz prüfen – ein Scrape pro Tag liegt deutlich unter typischen Limits.
