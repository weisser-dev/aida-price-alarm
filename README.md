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

## Docker

```bash
docker compose --profile prod up -d --build
```

Das Image wird aus dem `Dockerfile` gebaut, die SQLite-Datei liegt im Bind-Mount `./data`. Konfiguration via `.env` (optional) oder direkt über `environment:` im Compose.

## Deployment (GitHub Actions)

Der Workflow `.github/workflows/deploy.yml` ist an das aus dem Beispiel angelehnt:

- **Trigger:** Push auf `main` oder beliebige Branches (mit relevanten Pfaden) sowie `workflow_dispatch`. `claude/*`-Branches werden vom Auto-Deploy ausgenommen.
- **Targets:** `main` → Profil `prod` (Port 3000), alle anderen Branches → Profil `dev` (Port 3001). Beide laufen auf dem gleichen Server unter `/opt/aida-price-alarm/{prod,dev}`.
- **Übertragung:** Tar-Bundle via `appleboy/scp-action`, Deploy via `appleboy/ssh-action`.
- **Datenpersistenz:** `data/` und eine optionale operator-gepflegte `.env` werden bei jedem Redeploy in einem Staging-Verzeichnis zwischengespeichert und nach dem Entpacken zurückgelegt – das Compose-Verzeichnis selbst wird sauber neu aufgesetzt.
- **Backup auf `main`:** Vor dem prod-Deploy wird ein Online-Backup der SQLite-Datei erzeugt (`sqlite3 .backup` aus einem Wegwerf-Container, gzipped) nach `/opt/backups/aida/aida_<timestamp>.db.gz`. Es werden die letzten 10 Backups aufbewahrt.
- **Healthcheck:** Compose hat einen `wget` auf `/api/status` als Healthcheck.

### Benötigte GitHub-Secrets

| Secret | Zweck |
|--------|-------|
| `DEPLOY_HOST` | Hostname/IP des Zielservers |
| `DEPLOY_USER` | SSH-User mit `sudo` und Docker-Rechten |
| `DEPLOY_SSH_KEY` | Privater SSH-Key (PEM) für diesen User |

### Server-Vorbereitung (einmalig)

```bash
sudo mkdir -p /opt/aida-price-alarm/{prod,dev} /opt/backups/aida
# Caddy-Netz muss existieren und extern markiert sein:
docker network inspect caddy-net >/dev/null 2>&1 || docker network create caddy-net
# SMTP- und Live-API-Konfig anlegen (optional, sonst Mock + Mail-Log auf stdout):
sudo vi /opt/aida-price-alarm/prod/.env
```

Beim ersten Deploy wird das Compose-Stack gebaut, ein leeres Volume `data/` angelegt und die App startet im Mock-Modus, sofern die `.env` keinen Live-Endpoint setzt.

### Caddy

Der Container exponiert nur intern Port 3000 und hängt im externen Netz `caddy-net`. Der Container-Name ist deterministisch (`aida-price-alarm-prod` bzw. `aida-price-alarm-dev`), sodass Caddy direkt darauf proxen kann:

```caddy
aida.weisser.dev {
    reverse_proxy aida-price-alarm-prod:3000
    encode gzip zstd
}

# optional, parallel das Dev-Stack:
aida-dev.weisser.dev {
    reverse_proxy aida-price-alarm-dev:3000
    encode gzip zstd
}
```

## Hinweis zum Scraping

Das Skript greift nur lesend auf öffentlich verfügbare Daten zu und schickt einen klar identifizierbaren User-Agent. Vor produktivem Einsatz `robots.txt`, AGB und Frequenz prüfen – ein Scrape pro Tag liegt deutlich unter typischen Limits.
