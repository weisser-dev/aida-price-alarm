# AIDA Price Alarm

A small self-hosted watcher for AIDA cruises: it tracks **how many cabins are still free** and **what they cost**, and gives a reasoned hint whether to book now or wait. Single container with a web UI, German interface, standard-library Python only.

> Status: **no longer maintained / switched off** (the hosted instance was shut down in 2026). Kept as a reference; the booking-site scraping depends on third-party markup and will likely need fixes.

## What it measures

- **Cabins** - the same query the booking flow uses for cabin selection, counted per sub-category and deck
- **Prices** - the full category x tariff table of the travel agency page

One row per day is stored in `data/`; a second run on the same day replaces that day's row, so manual refreshes do not skew the series.

## The assessment

The page shows "book now", "decide soon" or "wait", plus every signal with its actual number: price trend (fitted line), cabin outflow per day, number of categories that lost the cheap tariff, days until the offer ends, days until departure, price at its historical low. It is explicitly **not a forecast**; it only summarises the own measurements and warns when data is thin. Logic: `einschaetzung()` in `aida_watch.py`, covered by `selbsttest.py`.

## Run

```bash
python3 selbsttest.py                    # offline self-test
python3 aida_watch.py                    # measure all active trips
python3 aida_watch.py --code <tripcode>  # a single trip
python3 aida_watch.py --trocken          # dry run
python3 aida_watch.py --status           # full state as JSON
python3 server.py --port 8777            # web UI
```

Or in a container: `docker compose up -d --build` (the container exposes its port on a Docker network only, put a reverse proxy in front). Requires Python 3.9+, no third-party packages.

## Configuration

Environment variables (see `.env.example`): `LAUF_INTERVALL_STUNDEN` (measurement interval, default 4), `LAUF_OFFSET_MINUTEN`, `MINDESTABSTAND_SEKUNDEN` (minimum gap between fetches per trip), `AIDA_DATA_DIR`, `APP_BASE_URL`, `SMTP_*` / `MAIL_AN` (mail alerts), `NTFY_URL` / `NTFY_TOKEN` (push). Alert thresholds are in `config.json`. The app has no login of its own; protect it at the reverse proxy.

## Layout

| Path | Content |
|---|---|
| `aida_watch.py` | fetching, evaluation, assessment, alerts; also a CLI |
| `server.py` | web UI, API, scheduler |
| `selbsttest.py` | offline tests (quality gate in the workflow) |
| `web/index.html` | the page, all inline |
| `vorgaben/` | seed data copied into an empty `data/` on first start |

## Please be polite to the source

The upstream booking site disallows automated access in its robots.txt. This tool fetches a handful of times per day and enforces a minimum gap; do not tighten the interval.
