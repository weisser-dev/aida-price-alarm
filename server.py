#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py - kleiner lokaler Server fuer die AIDA-Ueberwachung.

Laeuft nur auf 127.0.0.1, ist also ausschliesslich von diesem Mac erreichbar.
Er liefert die Oberflaeche aus web/ und bietet die Knoepfe darin ein paar
Endpunkte an. Die eigentliche Arbeit macht aida_watch.py.

    python3 server.py                 # startet auf dem Port aus config.json
    python3 server.py --port 8888

Danach im Browser: http://127.0.0.1:8777

Endpunkte
---------
    GET  /                      Oberflaeche
    GET  /api/status            alle Reisen mit Messreihen
    POST /api/aktualisieren     {"code": "CO07261003"} oder {"code": "__alle"}
    POST /api/reise/pruefen     {"code": "..."}   - schaut nach, legt nichts an
    POST /api/reise/anlegen     {"code", "ueberwachen_bis", "gruppen", ...}
    POST /api/reise/aendern     {"code", ...Felder...}
    POST /api/reise/entfernen   {"code"}          - deaktiviert, loescht keine Daten

Nur die Standardbibliothek. Bricht der Prozess ab, startet launchd ihn neu.
"""

import argparse
import json
import os
import posixpath
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aida_watch as A  # noqa: E402

ORDNER = A.ORDNER
WEB = os.path.join(ORDNER, "web")

TYPEN = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
         ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png"}

SCHIFF_ICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    '<rect width="32" height="32" rx="7" fill="#2a78d6"/>'
    '<path d="M5 20h22l-3 6H8z" fill="#fff"/>'
    '<rect x="9" y="11" width="14" height="7" rx="1.5" fill="#fff"/>'
    '<rect x="14" y="6" width="4" height="5" rx="1" fill="#fff"/></svg>'
).encode("utf-8")

_letzter_abruf = {}
_abruf_sperre = threading.Lock()
_beenden = threading.Event()


def erlaubte_wirte():
    """
    Lokal reicht 127.0.0.1. Hinter einem Reverse Proxy kommt die echte Domain
    im Host-Kopf an - die muss zusaetzlich erlaubt sein, sonst antwortet der
    Server nur noch mit 403. Quellen: APP_BASE_URL und AIDA_ALLOWED_HOSTS.
    """
    erlaubt = {"127.0.0.1", "localhost", "::1", "", "aida-price-alarm"}
    basis = os.environ.get("APP_BASE_URL") or ""
    if basis:
        wirt = urllib.parse.urlparse(basis).hostname
        if wirt:
            erlaubt.add(wirt.lower())
    for w in (os.environ.get("AIDA_ALLOWED_HOSTS") or "").split(","):
        if w.strip():
            erlaubt.add(w.strip().lower())
    return erlaubt


# ------------------------------------------------------------------ Zeitplan

def intervall_stunden():
    try:
        return max(1, int(os.environ.get("LAUF_INTERVALL_STUNDEN") or 0))
    except ValueError:
        return 0


def naechster_lauf(jetzt, stunden, offset_minuten):
    """Naechster Termin auf dem Raster 00:MM, 04:MM, 08:MM ... (bei 4 Stunden)."""
    kandidat = jetzt.replace(minute=offset_minuten, second=0, microsecond=0)
    kandidat = kandidat.replace(hour=(jetzt.hour // stunden) * stunden)
    while kandidat <= jetzt:
        kandidat += timedelta(hours=stunden)
    return kandidat


def _merker_pfad():
    return os.path.join(A.wurzel(ORDNER), ".letzter_lauf.json")


def zeitplan_schleife():
    """
    Misst im festen Takt. Bewusst ein eigener Faden statt cron im Container:
    so gibt es genau einen Prozess, der schreibt, und die Dateisperre reicht.
    """
    stunden = intervall_stunden()
    if not stunden:
        print("Zeitplan aus (LAUF_INTERVALL_STUNDEN nicht gesetzt).", flush=True)
        return
    offset = int(os.environ.get("LAUF_OFFSET_MINUTEN") or 7)
    print("Zeitplan: alle %d Stunden zur Minute %02d." % (stunden, offset), flush=True)

    # Nach einem Neustart nicht sofort losrennen, aber auch keinen Takt verschlucken
    vorher = A.lade_json(_merker_pfad(), {}) or {}
    letzte = vorher.get("zeitpunkt")
    ziel = naechster_lauf(A.jetzt_lokal(), stunden, offset)
    if letzte:
        try:
            vergangen = A.jetzt_lokal() - datetime.fromisoformat(letzte)
            if vergangen > timedelta(hours=stunden):
                ziel = A.jetzt_lokal() + timedelta(seconds=90)
                print("Letzter Lauf ist %s her - hole ihn gleich nach." % vergangen, flush=True)
        except ValueError:
            pass
    else:
        ziel = A.jetzt_lokal() + timedelta(seconds=90)

    while not _beenden.is_set():
        if A.jetzt_lokal() >= ziel:
            try:
                takt_lauf()
            except Exception as e:
                print("Zeitplan-Lauf fehlgeschlagen: %r" % e, flush=True)
            ziel = naechster_lauf(A.jetzt_lokal(), stunden, offset)
            print("Naechster Lauf: %s" % ziel.strftime("%Y-%m-%d %H:%M"), flush=True)
        _beenden.wait(30)


def takt_lauf():
    glob = A.lade_global(ORDNER)
    reisen = [r for r in A.lade_reisen(ORDNER) if A.ueberwachung_laeuft(r)]
    A.schreib_json(_merker_pfad(), {"zeitpunkt": A.jetzt_lokal().isoformat(),
                                    "reisen": [r["code"] for r in reisen]})
    if not reisen:
        print("Zeitplan: keine aktive Reise - nichts zu tun.", flush=True)
        return
    with _abruf_sperre:
        with A.Sperre(ORDNER):
            for reise in reisen:
                erg = A.lauf_reise(reise, glob, ORDNER)
                _letzter_abruf[reise["code"]] = time.time()
                melde(erg, glob)
                print("Zeitplan: %s geprueft (%s)" % (reise["code"], erg["stand"]), flush=True)


def melde(erg, glob):
    """Meldet nur, wenn es etwas zu melden gibt - Stille ist der Normalfall."""
    lage, reise = erg["lage"], erg["reise"]
    kurz = "%s %s" % (reise.get("schiff", ""), reise["code"])
    if erg["fehler"]:
        A.mitteilung("AIDA-Check fehlgeschlagen (%s)" % kurz, erg["fehler"][0][:400], True)
        return
    ein = erg.get("einschaetzung") or {}
    if lage["alarm"]:
        text = "; ".join(lage["gruende"])
        if ein.get("titel"):
            text += "\n\nEinschaetzung: %s\n- %s" % (ein["titel"], "\n- ".join(ein.get("signale", [])))
        A.mitteilung("AIDA ALARM - %s" % kurz, text[:1500], True)
    elif lage["meldenswert"] and lage["preis_heute"] is not None:
        d = lage["preis_heute"] - (lage["preis_vortag"] or lage["preis_heute"])
        A.mitteilung("AIDA Preisaenderung - %s" % kurz,
                     "%s: %s EUR (%+d zum Vortag)\n\nEinschaetzung: %s"
                     % (lage["gruppen"][0]["name"], A.euro(lage["preis_heute"]), d,
                        ein.get("titel", "-")))


def mindestabstand(glob):
    return int(glob.get("server", {}).get("mindestabstand_sekunden", 60))


def darf_abrufen(code, glob, erzwingen=False):
    """Schuetzt die fremde Buchungsstrecke vor Klick-Gewittern."""
    if erzwingen:
        return True, 0
    abstand = mindestabstand(glob)
    letzter = _letzter_abruf.get(code, 0)
    rest = int(abstand - (time.time() - letzter))
    return (rest <= 0), max(0, rest)


class Handler(BaseHTTPRequestHandler):
    server_version = "aida-watch"
    protocol_version = "HTTP/1.1"

    # -------------------------------------------------- Grundlagen
    def log_message(self, format, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), format % args))

    def _host_ok(self):
        wirt = (self.headers.get("Host") or "").split(":")[0].lower()
        return wirt in erlaubte_wirte()

    def _sende(self, code, koerper, typ="application/json; charset=utf-8"):
        if isinstance(koerper, (dict, list)):
            koerper = json.dumps(koerper, ensure_ascii=False).encode("utf-8")
        elif isinstance(koerper, str):
            koerper = koerper.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(koerper)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(koerper)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _fehler(self, code, text):
        self._sende(code, {"ok": False, "fehler": text})

    def _koerper(self):
        laenge = int(self.headers.get("Content-Length") or 0)
        if laenge <= 0:
            return {}
        if laenge > 1_000_000:
            raise A.Fehler("Anfrage zu gross.")
        try:
            return json.loads(self.rfile.read(laenge).decode("utf-8"))
        except ValueError:
            raise A.Fehler("Ungueltiges JSON.")

    # -------------------------------------------------- GET
    def do_GET(self):
        if not self._host_ok():
            return self._fehler(403, "Nur lokal erreichbar.")
        pfad = self.path.split("?")[0]
        if pfad == "/api/status":
            try:
                return self._sende(200, A.status(ORDNER))
            except Exception as e:
                return self._fehler(500, str(e))
        if pfad == "/api/gesundheit":
            return self._sende(200, {"ok": True, "stand": A.jetzt_lokal().isoformat()})
        if pfad == "/favicon.ico":
            return self._sende(200, SCHIFF_ICON, "image/svg+xml")
        return self._datei(pfad)

    def _datei(self, pfad):
        if pfad in ("/", ""):
            pfad = "/index.html"
        sicher = posixpath.normpath(pfad).lstrip("/")
        if sicher.startswith("..") or os.path.isabs(sicher):
            return self._fehler(403, "Nein.")
        voll = os.path.join(WEB, sicher)
        if not os.path.isfile(voll):
            return self._fehler(404, "Nicht gefunden: %s" % pfad)
        with open(voll, "rb") as f:
            inhalt = f.read()
        endung = os.path.splitext(voll)[1].lower()
        return self._sende(200, inhalt, TYPEN.get(endung, "application/octet-stream"))

    # -------------------------------------------------- POST
    def do_POST(self):
        if not self._host_ok():
            return self._fehler(403, "Nur lokal erreichbar.")
        pfad = self.path.split("?")[0]
        try:
            daten = self._koerper()
            glob = A.lade_global(ORDNER)
            if pfad == "/api/aktualisieren":
                return self._aktualisieren(daten, glob)
            if pfad == "/api/reise/pruefen":
                return self._pruefen(daten, glob)
            if pfad == "/api/reise/anlegen":
                return self._anlegen(daten, glob)
            if pfad == "/api/reise/aendern":
                return self._aendern(daten, glob)
            if pfad == "/api/reise/entfernen":
                return self._entfernen(daten, glob)
            return self._fehler(404, "Unbekannter Endpunkt.")
        except A.Fehler as e:
            return self._fehler(400, str(e))
        except urllib.error.URLError as e:
            return self._fehler(502, "Quelle nicht erreichbar: %s" % e)
        except Exception as e:
            self.log_message("Ausnahme: %r", e)
            return self._fehler(500, "Unerwarteter Fehler: %s" % e)

    # -------------------------------------------------- Aktionen
    def _aktualisieren(self, daten, glob):
        code = (daten.get("code") or "__alle").strip()
        erzwingen = bool(daten.get("erzwingen"))
        if code == "__alle":
            reisen = [r for r in A.lade_reisen(ORDNER) if A.ueberwachung_laeuft(r)]
            if not reisen:
                raise A.Fehler("Keine aktive Reise zu pruefen.")
        else:
            reisen = [A.lade_reise(ORDNER, code)]

        wartend = []
        zu_pruefen = []
        for r in reisen:
            ok, rest = darf_abrufen(r["code"], glob, erzwingen)
            (zu_pruefen if ok else wartend).append((r, rest))

        if not zu_pruefen:
            rest = min(w[1] for w in wartend)
            raise A.Fehler("Gerade eben schon abgerufen. Bitte noch %d Sekunden warten "
                           "- die Buchungsstrecke soll nicht bombardiert werden." % rest)

        ergebnisse = []
        with _abruf_sperre:
            with A.Sperre(ORDNER, blockierend=False):
                for r, _ in zu_pruefen:
                    erg = A.lauf_reise(r, glob, ORDNER)
                    _letzter_abruf[r["code"]] = time.time()
                    if erg["lage"]["alarm"] or erg["fehler"]:
                        melde(erg, glob)
                    ergebnisse.append({"code": r["code"], "stand": erg["stand"],
                                       "fehler": erg["fehler"],
                                       "alarm": erg["lage"]["alarm"],
                                       "gruende": erg["lage"]["gruende"]})
        antwort = {"ok": True, "ergebnisse": ergebnisse, "status": A.status(ORDNER)}
        if wartend:
            antwort["hinweis"] = ("%d Reise(n) uebersprungen - erst vor Kurzem abgerufen."
                                  % len(wartend))
        return self._sende(200, antwort)

    def _pruefen(self, daten, glob):
        code = (daten.get("code") or "").strip().upper()
        ok, rest = darf_abrufen("__pruefen_" + code, glob, bool(daten.get("erzwingen")))
        if not ok:
            raise A.Fehler("Diesen Code gerade erst geprueft. Noch %d Sekunden." % rest)
        with _abruf_sperre:
            info = A.erkunde_reise(code, glob)
            _letzter_abruf["__pruefen_" + code] = time.time()
        info["bereits_angelegt"] = os.path.exists(A.reise_pfad(ORDNER, code))
        return self._sende(200, {"ok": True, "reise": info})

    def _anlegen(self, daten, glob):
        code = (daten.get("code") or "").strip().upper()
        if not re.match(r"^[A-Z0-9]{6,20}$", code):
            raise A.Fehler("Reisecode fehlt oder sieht falsch aus.")
        gruppen = daten.get("gruppen") or []
        if not gruppen:
            raise A.Fehler("Bitte mindestens eine Kabinenkategorie auswaehlen.")
        if not any(g.get("primaer") for g in gruppen):
            gruppen[0]["primaer"] = True

        ende = (daten.get("ueberwachen_bis") or "").strip()
        if ende and not re.match(r"^\d{4}-\d{2}-\d{2}$", ende):
            raise A.Fehler("Ueberwachungsende bitte als JJJJ-MM-TT.")

        kopf = daten.get("kopf") or {}
        standard = glob.get("standard", {})
        reise = {
            "code": code,
            "schiff": kopf.get("schiff", ""),
            "titel": kopf.get("titel", ""),
            "von": kopf.get("von", ""),
            "bis": kopf.get("bis", ""),
            "naechte": kopf.get("naechte"),
            "route": daten.get("route", ""),
            "aktiv": True,
            "ueberwachen_bis": ende,
            "tarif": daten.get("tarif") or standard.get("tarif", "LIGHT"),
            "reisende": daten.get("reisende") or standard.get("reisende", [2, 0, 0]),
            "preismodell": daten.get("preismodell") or standard.get("preismodell", "IND"),
            "gruppen": [{"name": g["name"], "codes": g["codes"],
                         "primaer": bool(g.get("primaer"))} for g in gruppen],
            "preisreihen": [g["name"] for g in gruppen][:3],
            "flug": daten.get("flug") or {},
            "notiz": daten.get("notiz", ""),
            "angelegt": A.heute(),
        }
        A.schreib_json(A.reise_pfad(ORDNER, code), reise)

        # Erste Messung gleich mit erledigen, damit die Reise nicht leer dasteht
        fehler = []
        try:
            with _abruf_sperre:
                with A.Sperre(ORDNER, blockierend=False):
                    erg = A.lauf_reise(reise, glob, ORDNER)
                    _letzter_abruf[code] = time.time()
                    fehler = erg["fehler"]
        except A.Fehler as e:
            fehler = [str(e)]
        return self._sende(200, {"ok": True, "code": code, "fehler": fehler,
                                 "status": A.status(ORDNER)})

    def _aendern(self, daten, glob):
        code = (daten.get("code") or "").strip().upper()
        reise = A.lade_reise(ORDNER, code)
        for feld in ("ueberwachen_bis", "aktiv", "tarif", "gruppen", "flug",
                     "preisreihen", "notiz", "route", "reisende"):
            if feld in daten:
                reise[feld] = daten[feld]
        if reise.get("ueberwachen_bis") and not re.match(
                r"^\d{4}-\d{2}-\d{2}$", reise["ueberwachen_bis"]):
            raise A.Fehler("Ueberwachungsende bitte als JJJJ-MM-TT.")
        A.schreib_json(A.reise_pfad(ORDNER, code), reise)
        return self._sende(200, {"ok": True, "status": A.status(ORDNER)})

    def _entfernen(self, daten, glob):
        code = (daten.get("code") or "").strip().upper()
        reise = A.lade_reise(ORDNER, code)
        reise["aktiv"] = False
        A.schreib_json(A.reise_pfad(ORDNER, code), reise)
        return self._sende(200, {"ok": True, "status": A.status(ORDNER)})


def main():
    p = argparse.ArgumentParser(description="Lokaler Server der AIDA-Ueberwachung.")
    p.add_argument("--port", type=int)
    p.add_argument("--host")
    args = p.parse_args()

    A.migriere(ORDNER)
    A.erstbefuellung(ORDNER)
    glob = A.lade_global(ORDNER)
    host = args.host or glob["server"].get("host", "127.0.0.1")
    port = args.port or int(glob["server"].get("port", 8777))

    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    print("AIDA-Ueberwachung laeuft auf http://%s:%d" % (host, port), flush=True)
    print("Code: %s   Daten: %s" % (ORDNER, A.wurzel(ORDNER)), flush=True)
    print("Erlaubte Hostnamen: %s" % ", ".join(sorted(x for x in erlaubte_wirte() if x)), flush=True)
    if intervall_stunden():
        threading.Thread(target=zeitplan_schleife, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        _beenden.set()
        print("beendet", flush=True)


if __name__ == "__main__":
    main()
