#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
aida_watch.py - Ueberwachung von AIDA-Reisen: freie Kabinen UND Preise.

Kann mehrere Reisen gleichzeitig beobachten. Jede Reise ist eine Datei unter
reisen/<Reisecode>.json; die Messwerte landen in daten/<Reisecode>/.

Wird sowohl von der Kommandozeile als auch von server.py benutzt - die
eigentliche Arbeit steckt in den Funktionen, das CLI ist nur eine Huelle.

Aufrufe
-------
    python3 aida_watch.py                    # alle aktiven Reisen pruefen
    python3 aida_watch.py --code CO07261003  # nur eine Reise
    python3 aida_watch.py --alle-auch-beendete
    python3 aida_watch.py --trocken          # abrufen, anzeigen, nichts schreiben
    python3 aida_watch.py --html             # zusaetzlich dashboard.html schreiben
    python3 aida_watch.py --leise            # ohne macOS-Mitteilung

Braucht nur die Python-Standardbibliothek - laeuft mit dem /usr/bin/python3 von macOS.

Bitte hoechstens ein paar Mal am Tag laufen lassen. Das ist eine fremde
Buchungsstrecke, kein oeffentliches API. Ein Abruf pro Lauf ist unauffaellig,
eine Schleife nicht. Der Mindestabstand aus config.json wird erzwungen.
"""

import argparse
import csv
import errno
import fcntl
import html as html_mod
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, OrderedDict
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------
# Konstanten
# --------------------------------------------------------------------------

ORDNER = os.path.dirname(os.path.abspath(__file__))


def wurzel(ordner=None):
    """
    Wo die veraenderlichen Daten liegen: reisen/, daten/, raw/, dashboard.html.

    Im Container zeigt AIDA_DATA_DIR auf das gemountete Volume (/app/data),
    damit ein neuer Deploy den Code ersetzen kann, ohne die Messreihen
    mitzunehmen. Ohne die Variable ist es schlicht der Programmordner - so
    verhaelt sich die lokale Installation wie bisher.
    """
    return os.environ.get("AIDA_DATA_DIR") or (ordner or ORDNER)

CABIN_API = "https://aida.euresa-reisen.de/axios/api/cabins.php"
CABIN_REFERER = "https://aida.euresa-reisen.de/{code}/IND/Kabine"
PREIS_URL = "https://euresa-reisen.de/reisesuche/{code}/"
BUCHUNG_URL = ("https://aida.de/finden/{code}/CLASSIC?pax%5Badults%5D={erw}"
               "&pax%5Bjuveniles%5D={jug}&pax%5Bchildren%5D={kind}&pax%5Bbabies%5D=0"
               "&airport={flughafen}&arrivalAirport={flughafen}")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")

# Erste Buchstaben der AIDA-Kabinencodes je Kategorie. Fuer das Erkennen der
# Kategorien einer noch unbekannten Reise. Bei Bedarf in config.json erweitern.
STANDARD_PREFIXE = {
    "Innenkabine": "I",
    "Meerblickkabine": "M",
    "Balkonkabine": "B",
    "Verandakabine": "V",
    "Verandakabine Komfort": "V",
    "Verandakabine Deluxe": "D",
    "Panoramakabine": "P",
    "Junior-Suite": "J",
    "Suite": "S",
    "Deluxe Suite": "S",
    "Premium Suite": "S",
}

KABINEN_HEADER = ["datum", "uhrzeit", "gruppe", "gesamt", "codes", "decks"]


class Fehler(Exception):
    """Erwarteter Fehler, dessen Text direkt dem Nutzer gezeigt werden darf."""


# --------------------------------------------------------------------------
# Kleine Helfer
# --------------------------------------------------------------------------

def log(text=""):
    print(text, flush=True)


def jetzt_lokal():
    return datetime.now(timezone.utc).astimezone()


def heute():
    return jetzt_lokal().strftime("%Y-%m-%d")


def _tage(a, b):
    """Tage zwischen zwei JJJJ-MM-TT-Datumsangaben."""
    try:
        d1 = datetime.strptime(a, "%Y-%m-%d")
        d2 = datetime.strptime(b, "%Y-%m-%d")
        return (d2 - d1).days
    except (ValueError, TypeError):
        return None


def euro(wert):
    if wert is None:
        return "-"
    return "{:,.0f}".format(wert).replace(",", ".")


def zahl(wert):
    try:
        if wert in (None, "", "-"):
            return None
        return int(float(wert))
    except (TypeError, ValueError):
        return None


def lade_json(pfad, standard=None):
    if not os.path.exists(pfad):
        return standard
    with open(pfad, encoding="utf-8") as f:
        return json.load(f)


def schreib_json(pfad, daten):
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    tmp = pfad + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(daten, f, ensure_ascii=False, indent=2)
    os.replace(tmp, pfad)


class Sperre(object):
    """Dateisperre, damit CLI-Lauf und Server sich nicht in die Quere kommen."""

    def __init__(self, ordner, blockierend=True):
        os.makedirs(wurzel(ordner), exist_ok=True)
        self.pfad = os.path.join(wurzel(ordner), ".lauf.lock")
        self.blockierend = blockierend
        self.f = None

    def __enter__(self):
        self.f = open(self.pfad, "w")
        flags = fcntl.LOCK_EX if self.blockierend else (fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            fcntl.flock(self.f.fileno(), flags)
        except IOError as e:
            self.f.close()
            self.f = None
            if e.errno in (errno.EACCES, errno.EAGAIN):
                raise Fehler("Es laeuft bereits ein Abruf. Bitte kurz warten.")
            raise
        return self

    def __exit__(self, *_):
        if self.f:
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
            self.f.close()


# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------

def lade_global(ordner=ORDNER):
    """config.json: erst im Datenordner (dort ueberlebt sie einen Deploy), sonst im Code."""
    for kandidat in (os.path.join(wurzel(ordner), "config.json"),
                     os.path.join(ordner, "config.json")):
        cfg = lade_json(kandidat)
        if cfg is not None:
            return ueberschreibe_aus_umgebung(cfg)
    raise Fehler("config.json weder in %s noch in %s" % (wurzel(ordner), ordner))


def ueberschreibe_aus_umgebung(cfg):
    """Damit der Container ohne Dateiaenderung konfigurierbar bleibt."""
    srv = cfg.setdefault("server", {})
    if os.environ.get("PORT"):
        srv["port"] = int(os.environ["PORT"])
    if os.environ.get("HOST"):
        srv["host"] = os.environ["HOST"]
    if os.environ.get("MINDESTABSTAND_SEKUNDEN"):
        srv["mindestabstand_sekunden"] = int(os.environ["MINDESTABSTAND_SEKUNDEN"])
    return cfg


def reise_pfad(ordner, code):
    return os.path.join(wurzel(ordner), "reisen", "%s.json" % code)


def lade_reisen(ordner=ORDNER):
    verzeichnis = os.path.join(wurzel(ordner), "reisen")
    if not os.path.isdir(verzeichnis):
        return []
    reisen = []
    for name in sorted(os.listdir(verzeichnis)):
        if not name.endswith(".json"):
            continue
        r = lade_json(os.path.join(verzeichnis, name))
        if r:
            reisen.append(r)
    reisen.sort(key=lambda r: (not r.get("aktiv", True), r.get("von", ""), r.get("code", "")))
    return reisen


def lade_reise(ordner, code):
    r = lade_json(reise_pfad(ordner, code))
    if r is None:
        raise Fehler("Reise %s ist nicht angelegt." % code)
    return r


def ueberwachung_laeuft(reise, stichtag=None):
    """False, sobald das Ueberwachungsende ueberschritten ist."""
    if not reise.get("aktiv", True):
        return False
    ende = reise.get("ueberwachen_bis")
    if not ende:
        return True
    return (stichtag or heute()) <= ende


def flug_von(reise, glob):
    flug = dict(glob.get("flug", {}))
    flug.update(reise.get("flug", {}))
    return OrderedDict(
        (k, v) for k, v in sorted(flug.items()) if not k.startswith("_")
    )


def buchungslinks(reise, glob):
    erw, jug, kind = (reise.get("reisende") or [2, 0, 0])[:3]
    links = OrderedDict()
    for fh in flug_von(reise, glob):
        links[fh] = BUCHUNG_URL.format(code=reise["code"], erw=erw, jug=jug,
                                       kind=kind, flughafen=fh)
    return links


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def http_get(url, timeout=40):
    req = urllib.request.Request(url, method="GET")
    req.add_header("user-agent", UA)
    req.add_header("accept", "text/html,application/xhtml+xml")
    req.add_header("accept-language", "de-DE,de;q=0.9")
    with urllib.request.urlopen(req, timeout=timeout) as antwort:
        roh = antwort.read()
    for kodierung in ("utf-8", "latin-1"):
        try:
            return roh.decode(kodierung)
        except UnicodeDecodeError:
            continue
    return roh.decode("utf-8", "replace")


def hole_kabinen(code, kategorien, reisende, preismodell, timeout=40):
    payload = {
        "code": code,
        "reisende": reisende,
        "preismodell": preismodell,
        "cabincategorycode": kategorien,
    }
    req = urllib.request.Request(CABIN_API, data=json.dumps(payload).encode("utf-8"),
                                 method="POST")
    req.add_header("content-type", "application/json;charset=UTF-8")
    req.add_header("accept", "application/json, text/plain, */*")
    req.add_header("accept-language", "de-DE,de;q=0.9")
    req.add_header("origin", "https://aida.euresa-reisen.de")
    req.add_header("referer", CABIN_REFERER.format(code=code))
    req.add_header("user-agent", UA)
    with urllib.request.urlopen(req, timeout=timeout) as antwort:
        rohtext = antwort.read().decode("utf-8")
    return rohtext, json.loads(rohtext)


# --------------------------------------------------------------------------
# Kabinen auswerten
# --------------------------------------------------------------------------

def flach(struktur):
    """Die Antwort ist verschachtelt (eine Liste je Kategorie). Alle Kabinen einsammeln."""
    kabinen = []
    stapel = [struktur]
    while stapel:
        element = stapel.pop()
        if isinstance(element, list):
            stapel.extend(element)
        elif isinstance(element, dict):
            if "cabinNumber" in element:
                kabinen.append(element)
            else:
                stapel.extend(element.values())
    return kabinen


def werte_kabinen_aus(kabinen, codes=None):
    buchbar = [k for k in kabinen if k.get("selectable", True)]
    if codes is not None:
        buchbar = [k for k in buchbar if k.get("cabinCategoryCode") in codes]
    nach_code = OrderedDict()
    for code in (codes or sorted(set(k.get("cabinCategoryCode", "?") for k in buchbar))):
        nach_code[code] = sum(1 for k in buchbar if k.get("cabinCategoryCode") == code)
    nach_deck = Counter(str(k.get("deck", "?")) for k in buchbar)
    decks = OrderedDict(
        sorted(nach_deck.items(), key=lambda p: int(p[0]) if p[0].isdigit() else 99)
    )
    return len(buchbar), nach_code, decks


def gruppen_aus(reise):
    gruppen = list(reise.get("gruppen") or [])
    gruppen.sort(key=lambda g: 0 if g.get("primaer") else 1)
    return gruppen


# --------------------------------------------------------------------------
# Preise lesen
# --------------------------------------------------------------------------

def html_zu_zeilen(roh):
    """HTML in sichtbare Textzeilen verwandeln - ohne Fremdbibliothek."""
    ohne = re.sub(r"<script[\s\S]*?</script>", " ", roh, flags=re.I)
    ohne = re.sub(r"<style[\s\S]*?</style>", " ", ohne, flags=re.I)
    ohne = re.sub(r"<!--[\s\S]*?-->", " ", ohne)
    text = re.sub(r"<[^>]+>", "\n", ohne)
    zeilen = []
    for zeile in text.split("\n"):
        sauber = re.sub(r"\s+", " ", html_mod.unescape(zeile)).strip()
        if sauber:
            zeilen.append(sauber)
    return zeilen


def parse_kopf(zeilen, roh):
    """Titel, Schiff, Datum und Naechte aus der Reiseseite lesen."""
    kopf = {}
    for i, z in enumerate(zeilen):
        m = re.match(r"^(\d{2}\.\d{2}\.\d{4})\s*bis\s*(\d{2}\.\d{2}\.\d{4})\s*\((\d+)\s*N", z)
        if m:
            def iso(d):
                t, mo, j = d.split(".")
                return "%s-%s-%s" % (j, mo, t)
            kopf["von"] = iso(m.group(1))
            kopf["bis"] = iso(m.group(2))
            kopf["naechte"] = int(m.group(3))
            if i > 0:
                kopf["titel"] = zeilen[i - 1]
            if i + 1 < len(zeilen):
                kopf["schiff"] = zeilen[i + 1]
            break
    t = re.search(r"<title>(.*?)</title>", roh, flags=re.S | re.I)
    if t:
        titel = html_mod.unescape(re.sub(r"\s+", " ", t.group(1))).strip()
        m = re.match(r"^([^:]+):\s*(.+?)\s+am\s+\d{2}\.\d{2}\.\d{4}", titel)
        if m:
            kopf.setdefault("schiff", m.group(1).strip())
            kopf.setdefault("titel", m.group(2).strip())
    return kopf


def parse_preise(roh, kategorien, tarife):
    """
    Liest die Tabelle 'Gesamtpreis fuer 2 Erwachsene je Kabine & Preismodell'.
    Rueckgabe: {kategorie: {tarif: preis_int}} - fehlende Kombination = nicht enthalten.
    Preise sind Gesamtpreise pro Kabine fuer die eingestellte Personenzahl, OHNE Flug.
    """
    zeilen = html_zu_zeilen(roh)
    start = None
    for i, z in enumerate(zeilen):
        if "Gesamtpreis" in z and "je Kabine" in z:
            start = i
            break
    if start is None:
        raise Fehler("Preisabschnitt nicht gefunden - Seitenaufbau geaendert oder "
                     "Reisecode unbekannt.")

    ergebnis = OrderedDict()
    aktuelle_kategorie = None
    aktueller_tarif = None

    for zeile in zeilen[start + 1:]:
        if zeile in kategorien:
            aktuelle_kategorie = zeile
            ergebnis.setdefault(aktuelle_kategorie, OrderedDict())
            aktueller_tarif = None
            continue

        if aktuelle_kategorie and len(ergebnis) >= 3 and re.match(
                r"^(Reiseverlauf|Preisentwicklung|EURESA Vorteile|H(ae|ä)ufige Fragen)$", zeile):
            break

        treffer = re.match(r"^AIDA ([A-Z][A-Z ]*[A-Z])\s*$", zeile)
        if treffer:
            kandidat = re.sub(r"\s+", " ", treffer.group(1)).strip()
            if kandidat in tarife:
                aktueller_tarif = kandidat
            continue

        preis = re.match(r"^([\d]{1,2}(?:\.\d{3})+|\d{3,5})\s*€$", zeile)
        if preis and aktuelle_kategorie and aktueller_tarif:
            if aktueller_tarif not in ergebnis[aktuelle_kategorie]:
                ergebnis[aktuelle_kategorie][aktueller_tarif] = int(
                    preis.group(1).replace(".", ""))

    if not ergebnis:
        raise Fehler("Preisabschnitt gefunden, aber keine Preise gelesen.")
    return ergebnis, zeilen


# --------------------------------------------------------------------------
# CSV
# --------------------------------------------------------------------------

def daten_ordner(ordner, code):
    p = os.path.join(wurzel(ordner), "daten", code)
    os.makedirs(p, exist_ok=True)
    return p


def lies_csv(pfad):
    if not os.path.exists(pfad):
        return []
    with open(pfad, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def schreib_csv(pfad, header, zeilen):
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    tmp = pfad + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore", restval="")
        w.writeheader()
        for z in zeilen:
            w.writerow(z)
    os.replace(tmp, pfad)


def upsert(zeilen, neue_zeile, schluessel=("datum",)):
    def sig(z):
        return tuple(z.get(f, "") for f in schluessel)
    gefiltert = [z for z in zeilen if sig(z) != sig(neue_zeile)]
    gefiltert.append(neue_zeile)
    gefiltert.sort(key=sig)
    return gefiltert


def preis_header(zeilen, kategorien, tarife):
    """Spalten in kanonischer Reihenfolge, aber ohne je eine bestehende zu verlieren."""
    header = ["datum", "uhrzeit"]
    for k in kategorien:
        for t in tarife:
            header.append("%s|%s" % (k, t))
    for z in zeilen:
        for feld in z:
            if feld not in header:
                header.append(feld)
    return header


def zeilen_der_gruppe(kabinen_zeilen, name):
    treffer = [z for z in kabinen_zeilen if z.get("gruppe") == name]
    if not treffer:
        treffer = [z for z in kabinen_zeilen if not z.get("gruppe")]
    return sorted(treffer, key=lambda z: z.get("datum", ""))


# --------------------------------------------------------------------------
# Bewertung
# --------------------------------------------------------------------------

def pp_inkl_flug(kabinenpreis, flugkosten, personen=2):
    if kabinenpreis is None:
        return None
    return int(round((kabinenpreis + flugkosten) / float(max(1, personen))))


def bewerte(reise, glob, preis_zeilen, kabinen_zeilen):
    schwellen = glob["schwellen"]
    tarif = reise.get("tarif", "LIGHT")

    p_heute_z = preis_zeilen[-1] if preis_zeilen else {}
    p_vor_z = preis_zeilen[-2] if len(preis_zeilen) > 1 else None
    p_erst_z = preis_zeilen[0] if preis_zeilen else None

    gruende = []
    meldenswert = False
    lage_gruppen = []

    for i, g in enumerate(gruppen_aus(reise)):
        name = g["name"]
        primaer = (i == 0)
        schluessel = "%s|%s" % (name, tarif)

        p_heute = zahl(p_heute_z.get(schluessel))
        p_vortag = zahl(p_vor_z.get(schluessel)) if p_vor_z else None
        p_erst = zahl(p_erst_z.get(schluessel)) if p_erst_z else None

        reihe = zeilen_der_gruppe(kabinen_zeilen, name)
        frei = zahl(reihe[-1].get("gesamt")) if reihe else None
        frei_vortag = zahl(reihe[-2].get("gesamt")) if len(reihe) > 1 else None

        if p_heute is None and preis_zeilen:
            if primaer:
                gruende.append("%s-Preis fuer %s ist WEG - eure Konstellation ist nicht "
                               "mehr buchbar." % (tarif, name))
            else:
                gruende.append("%s-Preis fuer %s ist weg." % (tarif, name))

        if primaer:
            if p_heute is not None and p_vortag:
                delta = (p_heute - p_vortag) / float(p_vortag) * 100.0
                if delta > schwellen["preis_anstieg_prozent"]:
                    gruende.append("Preis %+.1f %% ueber Vortag." % delta)
            if p_heute is not None and p_vortag is not None \
                    and abs(p_heute - p_vortag) >= schwellen["preis_aenderung_euro"]:
                meldenswert = True

        if frei is not None and frei < schwellen["kabinen_kritisch"]:
            gruende.append("Nur noch %d freie %s." % (frei, name))
        if frei is not None and frei_vortag is not None \
                and (frei - frei_vortag) <= -schwellen["kabinen_rueckgang"]:
            gruende.append("%d %s weniger als beim letzten Lauf." % (frei_vortag - frei, name))

        lage_gruppen.append({
            "name": name, "primaer": primaer, "codes": g["codes"],
            "preis_heute": p_heute, "preis_vortag": p_vortag, "preis_erst": p_erst,
            "frei": frei, "frei_vortag": frei_vortag,
        })

    haupt = lage_gruppen[0] if lage_gruppen else {}
    return {
        "gruppen": lage_gruppen,
        "preis_heute": haupt.get("preis_heute"),
        "preis_vortag": haupt.get("preis_vortag"),
        "preis_erst": haupt.get("preis_erst"),
        "frei": haupt.get("frei"),
        "frei_vortag": haupt.get("frei_vortag"),
        "alarm": bool(gruende),
        "gruende": gruende,
        "meldenswert": bool(gruende) or meldenswert,
    }


# --------------------------------------------------------------------------
# Vergleichstermine: was kostet dieselbe Route eine Woche frueher/spaeter?
# --------------------------------------------------------------------------

def geschwister_codes(code, vor=4, nach=4):
    """
    AIDA-Reisecodes sind aufgebaut wie CO07261003 = Schiff+Naechte, Jahr, Monat, Tag.
    Daraus lassen sich die Termine derselben Reihe wochenweise ableiten.
    Rueckgabe: [(code, iso_datum)] ohne den Ausgangstermin selbst.
    """
    m = re.match(r"^([A-Z]{2}\d{2})(\d{2})(\d{2})(\d{2})$", (code or "").strip().upper())
    if not m:
        return []
    stamm, jj, mm, tt = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    try:
        start = datetime(2000 + jj, mm, tt)
    except ValueError:
        return []
    aus = []
    for n in range(-abs(vor), abs(nach) + 1):
        if n == 0:
            continue
        d = start + timedelta(weeks=n)
        aus.append(("%s%02d%02d%02d" % (stamm, d.year % 100, d.month, d.day),
                    d.strftime("%Y-%m-%d")))
    return aus


def hole_vergleich(reise, glob, ordner=ORDNER, vor=4, nach=4):
    """
    Holt die Preistabellen der Nachbartermine. Nur euresa-Seiten, keine
    Buchungsstrecke - das ist eine normale Website und vertraegt das.
    """
    kategorien = glob.get("kategorien") or list(STANDARD_PREFIXE.keys())
    tarife = glob["tarife"]
    tarif = reise.get("tarif", "LIGHT")
    wunsch = (gruppen_aus(reise)[0]["name"] if gruppen_aus(reise) else "")

    termine = []
    for code, datum in geschwister_codes(reise["code"], vor, nach):
        eintrag = {"code": code, "von": datum, "erreichbar": False}
        try:
            roh = http_get(PREIS_URL.format(code=code), timeout=30)
            tabelle, zeilen = parse_preise(roh, kategorien, tarife)
            kopf = parse_kopf(zeilen, roh)
            eintrag.update({
                "erreichbar": True,
                "titel": kopf.get("titel", ""),
                "schiff": kopf.get("schiff", ""),
                "von": kopf.get("von", datum),
                "bis": kopf.get("bis", ""),
                "wunsch_tarif": tabelle.get(wunsch, {}).get(tarif),
                "wunsch_classic": tabelle.get(wunsch, {}).get("CLASSIC"),
                "hat_tarif_irgendwo": [k for k in tabelle if tabelle[k].get(tarif) is not None],
                "kategorien": len(tabelle),
            })
        except Exception as e:
            eintrag["fehler"] = str(e)[:200]
        termine.append(eintrag)

    ergebnis = {"stand": heute(), "tarif": tarif, "kategorie": wunsch, "termine": termine}
    ziel = os.path.join(wurzel(ordner), "vergleich", "%s.json" % reise["code"])
    schreib_json(ziel, ergebnis)
    return ergebnis


def lies_vergleich(reise, ordner=ORDNER):
    return lade_json(os.path.join(wurzel(ordner), "vergleich", "%s.json" % reise["code"]))


def vergleich_faellig(reise, glob, ordner=ORDNER):
    tage = int(glob.get("verhalten", {}).get("vergleich_alle_tage", 3) or 0)
    if tage <= 0:
        return False
    alt = lies_vergleich(reise, ordner)
    if not alt or not alt.get("stand"):
        return True
    abstand = _tage(alt["stand"], heute())
    return abstand is None or abstand >= tage


def werte_vergleich_aus(vergleich):
    """Wie selten ist die eigene Konstellation? Zaehlt nur erreichbare Termine."""
    if not vergleich:
        return None
    erreichbar = [t for t in vergleich.get("termine", []) if t.get("erreichbar")]
    if not erreichbar:
        return None
    mit_tarif = [t for t in erreichbar if t.get("wunsch_tarif") is not None]
    preise = [t["wunsch_tarif"] for t in mit_tarif]
    classic = [t["wunsch_classic"] for t in erreichbar if t.get("wunsch_classic") is not None]
    return {
        "geprueft": len(erreichbar),
        "mit_tarif": len(mit_tarif),
        "tarif_preise": preise,
        "classic_mittel": int(round(sum(classic) / float(len(classic)))) if classic else None,
        "classic_min": min(classic) if classic else None,
        "classic_max": max(classic) if classic else None,
    }


# --------------------------------------------------------------------------
# Einschaetzung: buchen oder warten?
# --------------------------------------------------------------------------

def steigung(punkte):
    """
    Lineare Ausgleichsgerade durch (Tag, Wert). Rueckgabe: Einheiten pro Tag.
    None, wenn zu wenige oder identische Punkte - lieber nichts sagen als raten.
    """
    punkte = [(x, y) for x, y in punkte if y is not None]
    if len(punkte) < 3:
        return None
    n = float(len(punkte))
    mx = sum(x for x, _ in punkte) / n
    my = sum(y for _, y in punkte) / n
    zaehler = sum((x - mx) * (y - my) for x, y in punkte)
    nenner = sum((x - mx) ** 2 for x, _ in punkte)
    if nenner == 0:
        return None
    return zaehler / nenner


def einschaetzung(reise, glob, preis_zeilen, kabinen_zeilen, lage, vergleich=None):
    """
    Eine begruendete Einschaetzung - ausdruecklich KEINE Vorhersage.
    Jedes Signal wird mit seiner tatsaechlichen Zahl ausgewiesen, damit
    nachvollziehbar bleibt, woher die Empfehlung kommt.
    """
    tarif = reise.get("tarif", "LIGHT")
    gruppen = lage.get("gruppen") or []
    haupt = gruppen[0] if gruppen else {}
    name = haupt.get("name", "")
    schluessel = "%s|%s" % (name, tarif)
    stand = preis_zeilen[-1]["datum"] if preis_zeilen else heute()

    punkte = 0
    signale = []
    treiber = []          # (Gewicht, Kurztext) - fuer die Kachel auf dem Handy
    kennzahlen = {}

    # --- Datenlage
    tage_reihe = _tage(preis_zeilen[0]["datum"], stand) if len(preis_zeilen) > 1 else 0
    kennzahlen["messungen"] = len(preis_zeilen)
    kennzahlen["tage_beobachtet"] = tage_reihe or 0

    # --- Ist die Wunschkonstellation ueberhaupt noch buchbar?
    if preis_zeilen and haupt.get("preis_heute") is None:
        return {
            "stufe": "weg", "titel": "Der %s-Preis für %s ist verschwunden" % (tarif, name),
            "farbe": "crit", "vertrauen": "hoch",
            "kurz": "%s im Tarif %s nicht mehr buchbar" % (name, tarif),
            "signale": ["Das %s-Kontingent für %s ist erschöpft. Entweder ein anderer Tarif, "
                        "eine andere Kategorie – oder beim AIDA-Berater nachfragen, ob noch "
                        "etwas frei ist." % (tarif, name)],
            "kennzahlen": kennzahlen,
        }

    # --- Preisentwicklung
    preis_paare = []
    for z in preis_zeilen:
        t = _tage(preis_zeilen[0]["datum"], z["datum"])
        if t is not None:
            preis_paare.append((t, zahl(z.get(schluessel))))
    werte = [y for _, y in preis_paare if y is not None]
    p_trend = steigung(preis_paare)
    kennzahlen["preis_trend_eur_pro_tag"] = round(p_trend, 2) if p_trend is not None else None
    if werte:
        kennzahlen["preis_tief"] = min(werte)
        kennzahlen["preis_hoch"] = max(werte)
        kennzahlen["preis_heute"] = werte[-1]

    if p_trend is not None:
        if p_trend > 5:
            punkte += 2
            treiber.append((3, "Preis steigt um %+.0f € pro Tag" % p_trend))
            signale.append("Der Preis steigt: rund %+.0f € pro Tag über die bisherige Messreihe."
                           % p_trend)
        elif p_trend < -5:
            punkte -= 2
            signale.append("Der Preis fällt noch: rund %+.0f € pro Tag. Abwarten hat bisher "
                           "Geld gespart." % p_trend)
        else:
            signale.append("Der Preis bewegt sich kaum (%+.1f € pro Tag)." % p_trend)
    elif len(werte) > 1:
        d = werte[-1] - werte[0]
        signale.append("Preis seit Beobachtungsbeginn %+d € – für einen Trend sind es noch "
                       "zu wenige Messungen." % d)
    else:
        signale.append("Erst eine Preismessung – noch kein Trend erkennbar.")

    if werte and len(werte) >= 3 and max(werte) > min(werte):
        tief = min(werte)
        if werte[-1] <= tief:
            punkte += 1
            signale.append("Aktuell auf dem bisher tiefsten gemessenen Stand (%s €)." % euro(tief))
        elif tief and (werte[-1] - tief) / float(tief) > 0.03:
            signale.append("Aktuell %s € über dem bisherigen Tief von %s €."
                           % (euro(werte[-1] - tief), euro(tief)))

    # --- Kabinenabfluss der Wunschkategorie
    reihe = zeilen_der_gruppe(kabinen_zeilen, name)
    k_paare = []
    for z in reihe:
        t = _tage(reihe[0]["datum"], z["datum"])
        if t is not None:
            k_paare.append((t, zahl(z.get("gesamt"))))
    k_trend = steigung(k_paare)
    kennzahlen["kabinen_trend_pro_tag"] = round(k_trend, 2) if k_trend is not None else None
    frei = haupt.get("frei")

    # Tempo ueber das gesamte Beobachtungsfenster - gibt es auch schon bei zwei Messungen
    kennzahlen["weg_pro_tag"] = None
    if len(k_paare) >= 2 and k_paare[-1][0] > 0:
        erst_wert, letzt_wert = k_paare[0][1], k_paare[-1][1]
        if erst_wert is not None and letzt_wert is not None:
            kennzahlen["weg_pro_tag"] = round((erst_wert - letzt_wert) / float(k_paare[-1][0]), 1)
            kennzahlen["weg_gesamt"] = erst_wert - letzt_wert
    if k_trend is not None and frei:
        if k_trend < -0.5:
            proz = abs(k_trend) / float(frei) * 100
            rest = int(frei / abs(k_trend))
            kennzahlen["tage_bis_leer_bei_gleichem_tempo"] = rest
            if proz >= 1.5:
                punkte += 2
                treiber.append((3, "%.1f Kabinen gehen pro Tag weg" % abs(k_trend)))
                signale.append("Die Kabinen gehen zügig weg: %.1f pro Tag (%.1f %% des Bestands). "
                               "Bei gleichem Tempo wären es in etwa %d Tagen keine mehr."
                               % (abs(k_trend), proz, rest))
            else:
                signale.append("Kabinen nehmen langsam ab: %.1f pro Tag – bei dem Tempo reicht "
                               "der Bestand noch Monate." % abs(k_trend))
        elif k_trend > 0.5:
            punkte -= 1
            signale.append("Es kommen sogar Kabinen zurück (%.1f pro Tag) – Stornierungen. "
                           "Kein Druck von der Verfügbarkeit." % k_trend)
        else:
            signale.append("Die Kabinenzahl ist praktisch unverändert (%.1f pro Tag)." % k_trend)
    elif frei:
        signale.append("Aktuell %d freie %s – für einen Abflusstrend fehlen noch Messungen."
                       % (frei, name))

    # --- Tarifkontingente anderer Kategorien
    ohne = []
    if preis_zeilen:
        letzte = preis_zeilen[-1]
        kats = sorted(set(f.split("|")[0] for f in letzte if "|" in f))
        for kat in kats:
            hat_irgendeinen = any(zahl(letzte.get("%s|%s" % (kat, t))) is not None
                                  for t in glob.get("tarife", []))
            if hat_irgendeinen and zahl(letzte.get("%s|%s" % (kat, tarif))) is None:
                ohne.append(kat)
    kennzahlen["kategorien_ohne_tarifpreis"] = ohne
    if len(ohne) >= 3:
        punkte += 1
        treiber.append((2, "%d Kategorien haben den %s-Tarif schon verloren" % (len(ohne), tarif)))
        signale.append("In %d Kategorien gibt es den %s-Tarif schon nicht mehr (%s). Das "
                       "Kontingent zieht sich zurück – eure Kategorie kann als Nächstes dran sein."
                       % (len(ohne), tarif, ", ".join(ohne)))
    elif ohne:
        signale.append("Ohne %s-Preis: %s." % (tarif, ", ".join(ohne)))

    # --- Vergleichstermine: das aussagekraeftigste Signal, weil es nicht von der
    #     Laenge der eigenen Messreihe abhaengt
    v = werte_vergleich_aus(vergleich)
    if v:
        kennzahlen["vergleich_geprueft"] = v["geprueft"]
        kennzahlen["vergleich_mit_tarif"] = v["mit_tarif"]
        kennzahlen["vergleich_classic_mittel"] = v["classic_mittel"]
        anteil = v["mit_tarif"] / float(v["geprueft"])
        if v["mit_tarif"] == 0:
            punkte += 2
            treiber.append((5, "kein einziger Nachbartermin hat %s noch im Tarif %s"
                            % (name, tarif)))
            signale.append("Von %d vergleichbaren Terminen derselben Reihe bietet KEINER "
                           "%s im Tarif %s an. Ihr habt gerade eine Ausnahme in der Hand."
                           % (v["geprueft"], name, tarif))
        elif anteil <= 0.35:
            punkte += 2
            einer = (v["mit_tarif"] == 1)
            treiber.append((5, "nur %s von %d Nachbarterminen %s %s noch"
                            % ("einer" if einer else str(v["mit_tarif"]), v["geprueft"],
                               "hat" if einer else "haben", tarif)))
            signale.append("Von %d vergleichbaren Terminen derselben Reihe %s nur %s "
                           "noch den %s-Tarif für %s. Diese Kombination ist die Ausnahme, "
                           "nicht die Regel – und sie verschwindet je Termin ersatzlos."
                           % (v["geprueft"], "hat" if einer else "haben",
                              "einer" if einer else str(v["mit_tarif"]), tarif, name))
        else:
            signale.append("%d von %d vergleichbaren Terminen %s den %s-Tarif für %s "
                           "ebenfalls noch." % (v["mit_tarif"], v["geprueft"],
                                                "hat" if v["mit_tarif"] == 1 else "haben",
                                                tarif, name))

        eigener = haupt.get("preis_heute")
        if v["classic_mittel"] and eigener:
            unterschied = v["classic_mittel"] - eigener
            if unterschied > 200:
                punkte += 1
                signale.append("Der CLASSIC-Preis der Nachbartermine liegt im Mittel bei "
                               "%s € (Spanne %s–%s €). Euer %s-Preis von %s € ist deutlich "
                               "darunter." % (euro(v["classic_mittel"]), euro(v["classic_min"]),
                                              euro(v["classic_max"]), tarif, euro(eigener)))
            else:
                signale.append("Preislich liegt ihr im Rahmen der Nachbartermine (CLASSIC dort "
                               "im Mittel %s €)." % euro(v["classic_mittel"]))
    else:
        signale.append("Noch kein Vergleich mit Nachbarterminen – der läuft beim nächsten "
                       "planmäßigen Lauf mit.")

    # --- Aktionsfenster
    aktion = reise.get("aktion") or {}
    if aktion.get("bis"):
        rest = _tage(stand, aktion["bis"])
        kennzahlen["tage_bis_aktionsende"] = rest
        if rest is not None and 0 <= rest <= 7:
            punkte += 2
            treiber.append((4, "Aktion endet in %d Tagen" % rest))
            signale.append("Die Aktion „%s\" endet in %d Tagen (%s). Danach ist mit "
                           "Preisanpassungen zu rechnen."
                           % (aktion.get("name", "Aktion"), rest, aktion["bis"]))
        elif rest is not None and rest <= 14:
            punkte += 1
            treiber.append((2, "Aktion läuft noch %d Tage" % rest))
            signale.append("Die Aktion „%s\" läuft noch %d Tage." % (aktion.get("name", "Aktion"), rest))
        elif rest is not None and rest < 0:
            signale.append("Die Aktion „%s\" ist seit %d Tagen vorbei."
                           % (aktion.get("name", "Aktion"), -rest))

    # --- Zeit bis zur Abreise
    bis_abreise = _tage(stand, reise.get("von", ""))
    kennzahlen["tage_bis_abreise"] = bis_abreise
    if bis_abreise is not None and bis_abreise < 60:
        punkte += 1
        treiber.append((1, "nur noch %d Tage bis zur Abreise" % bis_abreise))
        signale.append("Nur noch %d Tage bis zur Abreise – so kurz vorher werden günstige "
                       "Tarifkontingente selten wieder aufgefüllt." % bis_abreise)

    # --- Vertrauen in die Aussage
    breit = v and v["geprueft"] >= 6
    if kennzahlen["messungen"] >= 20 and kennzahlen["tage_beobachtet"] >= 14:
        vertrauen = "hoch"
    elif (kennzahlen["messungen"] >= 8 and kennzahlen["tage_beobachtet"] >= 5) or breit:
        vertrauen = "mittel"
    else:
        vertrauen = "niedrig"
        t = kennzahlen["tage_beobachtet"]
        signale.append("Achtung: erst %d Messungen über %s. Das ist eine Momentaufnahme, "
                       "kein Trend – die Einschätzung wird mit jedem Lauf belastbarer."
                       % (kennzahlen["messungen"], "1 Tag" if t == 1 else "%d Tage" % t))
    kennzahlen["punkte"] = punkte

    if punkte >= 4:
        stufe, titel, farbe = "jetzt", "Eher jetzt buchen", "crit"
    elif punkte >= 2:
        stufe, titel, farbe = "bald", "Bald entscheiden, nicht ewig warten", "warn"
    else:
        stufe, titel, farbe = "abwarten", "Abwarten ist vertretbar", "ok"
    if vertrauen == "niedrig" and stufe == "jetzt":
        titel += " – aber auf dünner Datenlage"

    if treiber:
        kurz = sorted(treiber, reverse=True)[0][1]
    elif stufe == "abwarten":
        kurz = "Preis und Verfügbarkeit sind ruhig"
    else:
        kurz = "mehrere kleine Signale"

    return {"stufe": stufe, "titel": titel, "farbe": farbe, "vertrauen": vertrauen,
            "kurz": kurz, "signale": signale, "kennzahlen": kennzahlen}


def _macos_mitteilung(titel, text):
    if sys.platform != "darwin":
        return False
    try:
        sicher = lambda x: x.replace('"', "'").replace("\\", "")
        subprocess.run(["osascript", "-e",
                        'display notification "%s" with title "%s" sound name "Submarine"'
                        % (sicher(text), sicher(titel))], check=False, timeout=10)
        return True
    except Exception:
        return False


def _ntfy(titel, text, dringend=False):
    url = os.environ.get("NTFY_URL")
    if not url:
        return False
    try:
        req = urllib.request.Request(url, data=text.encode("utf-8"), method="POST")
        req.add_header("Title", titel.encode("ascii", "replace").decode())
        req.add_header("Priority", "urgent" if dringend else "default")
        req.add_header("Tags", "ship")
        if os.environ.get("NTFY_TOKEN"):
            req.add_header("Authorization", "Bearer %s" % os.environ["NTFY_TOKEN"])
        urllib.request.urlopen(req, timeout=15).read()
        return True
    except Exception as e:
        log("ntfy fehlgeschlagen: %s" % e)
        return False


def _mail(titel, text):
    host = os.environ.get("SMTP_HOST")
    an = os.environ.get("MAIL_AN") or os.environ.get("SMTP_USER")
    if not host or not an:
        return False
    import smtplib
    from email.message import EmailMessage
    nachricht = EmailMessage()
    nachricht["Subject"] = titel
    nachricht["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER") or "aida@localhost"
    nachricht["To"] = an
    nachricht.set_content(text)
    port = int(os.environ.get("SMTP_PORT") or 587)
    sicher = (os.environ.get("SMTP_SECURE") or "").lower() in ("1", "true", "yes")
    try:
        if sicher or port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=25)
        else:
            server = smtplib.SMTP(host, port, timeout=25)
            try:
                server.starttls()
            except Exception:
                pass
        with server:
            if os.environ.get("SMTP_USER"):
                server.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
            server.send_message(nachricht)
        return True
    except Exception as e:
        log("E-Mail fehlgeschlagen: %s" % e)
        return False


def mitteilung(titel, text, dringend=False):
    """
    Meldet ueber alles, was eingerichtet ist: macOS-Mitteilung auf dem Mac,
    ntfy und E-Mail auf dem Server. Schlaegt ein Kanal fehl, ist das kein
    Grund zum Abbruch - der Messwert steht ohnehin schon in der Datei.
    """
    zugestellt = []
    if _macos_mitteilung(titel, text):
        zugestellt.append("macOS")
    if _ntfy(titel, text, dringend):
        zugestellt.append("ntfy")
    if _mail(titel, text):
        zugestellt.append("E-Mail")
    if not zugestellt:
        log("(keine Meldewege eingerichtet - nur ins Protokoll: %s / %s)" % (titel, text))
    return zugestellt


# --------------------------------------------------------------------------
# Eine Reise pruefen
# --------------------------------------------------------------------------

def erkunde_reise(code, glob, reisende=None, preismodell="IND"):
    """
    Holt Kopfdaten, Preistabelle und die tatsaechlich existierenden Kabinencodes.
    Schreibt nichts - dient dem Anlegen einer neuen Reise.
    """
    code = (code or "").strip().upper()
    if not re.match(r"^[A-Z0-9]{6,20}$", code):
        raise Fehler("Das sieht nicht nach einem Reisecode aus (z. B. CO07261003).")

    kategorien = glob.get("kategorien") or list(STANDARD_PREFIXE.keys())
    tarife = glob["tarife"]
    reisende = reisende or glob.get("standard", {}).get("reisende", [2, 0, 0])

    try:
        roh = http_get(PREIS_URL.format(code=code))
    except urllib.error.HTTPError as e:
        raise Fehler("Reiseseite nicht erreichbar (HTTP %s). Reisecode pruefen." % e.code)
    tabelle, zeilen = parse_preise(roh, kategorien, tarife)
    kopf = parse_kopf(zeilen, roh)

    # Welche Kabinencodes gibt es? Ein Aufruf mit allen plausiblen Kandidaten.
    prefixe = dict((k, v) for k, v in (glob.get("kategorie_prefixe") or STANDARD_PREFIXE).items()
                   if not k.startswith("_") and isinstance(v, str) and len(v) == 1)
    kandidaten = []
    for p in sorted(set(prefixe.values())):
        for zweit in "ABCDE":
            kandidaten.append(p + zweit)
    vorhanden = {}
    try:
        _, struktur = hole_kabinen(code, kandidaten, reisende, preismodell)
        for k in flach(struktur):
            if k.get("selectable", True):
                c = k.get("cabinCategoryCode")
                vorhanden[c] = vorhanden.get(c, 0) + 1
    except Exception:
        vorhanden = {}

    vorschlaege = []
    for kat in tabelle:
        p = prefixe.get(kat)
        if not p:
            continue
        codes = sorted(c for c in vorhanden if c.startswith(p))
        # Verandakabine Komfort und Deluxe teilen sich kein Praefix - Deluxe hat D
        if not codes:
            continue
        vorschlaege.append({
            "name": kat,
            "codes": codes,
            "frei": sum(vorhanden[c] for c in codes),
            "preise": tabelle[kat],
        })

    return {
        "code": code,
        "kopf": kopf,
        "preise": tabelle,
        "kategorien": vorschlaege,
        "kabinen_lesbar": bool(vorhanden),
    }


def lauf_reise(reise, glob, ordner=ORDNER, trocken=False):
    """Ein Messlauf fuer eine Reise. Gibt ein Ergebnis-Dict zurueck."""
    code = reise["code"]
    kategorien = glob.get("kategorien") or list(STANDARD_PREFIXE.keys())
    tarife = glob["tarife"]
    reisende = reise.get("reisende") or [2, 0, 0]
    preismodell = reise.get("preismodell", "IND")

    dordner = daten_ordner(ordner, code)
    raw_ordner = os.path.join(wurzel(ordner), "raw", code)
    os.makedirs(raw_ordner, exist_ok=True)
    kabinen_csv = os.path.join(dordner, "kabinen.csv")
    preis_csv = os.path.join(dordner, "preise.csv")

    kabinen_zeilen = lies_csv(kabinen_csv)
    preis_zeilen = lies_csv(preis_csv)

    stempel = jetzt_lokal()
    datum, uhrzeit = stempel.strftime("%Y-%m-%d"), stempel.strftime("%H:%M")
    fehler = []
    zaehlung = []

    # ---- Kabinen (ein Aufruf fuer alle Gruppen) --------------------------
    gruppen = gruppen_aus(reise)
    if gruppen:
        alle_codes = []
        for g in gruppen:
            for c in g["codes"]:
                if c not in alle_codes:
                    alle_codes.append(c)
        try:
            rohtext, struktur = hole_kabinen(code, alle_codes, reisende, preismodell)
            kabinen = flach(struktur)
            if not trocken:
                with open(os.path.join(raw_ordner, "%s-kabinen.json" % datum), "w",
                          encoding="utf-8") as f:
                    f.write(rohtext)
            for g in gruppen:
                gesamt, nach_code, decks = werte_kabinen_aus(kabinen, g["codes"])
                zaehlung.append({"gruppe": g["name"], "gesamt": gesamt,
                                 "codes": nach_code, "decks": decks})
                if not trocken:
                    kabinen_zeilen = upsert(kabinen_zeilen, {
                        "datum": datum, "uhrzeit": uhrzeit, "gruppe": g["name"],
                        "gesamt": gesamt,
                        "codes": json.dumps(nach_code, ensure_ascii=False),
                        "decks": json.dumps(decks, ensure_ascii=False),
                    }, schluessel=("datum", "gruppe"))
            if not trocken:
                schreib_csv(kabinen_csv, KABINEN_HEADER, kabinen_zeilen)
        except urllib.error.HTTPError as e:
            fehler.append("Kabinenabruf HTTP %s - Schnittstelle pruefen." % e.code)
        except Exception as e:
            fehler.append("Kabinenabruf: %s" % e)

    # ---- Preise ----------------------------------------------------------
    try:
        roh_html = http_get(PREIS_URL.format(code=code))
        tabelle, _ = parse_preise(roh_html, kategorien, tarife)
        zeile = {"datum": datum, "uhrzeit": uhrzeit}
        for kat in tabelle:
            for tar in tarife:
                zeile["%s|%s" % (kat, tar)] = tabelle.get(kat, {}).get(tar, "")
        if not trocken:
            with open(os.path.join(raw_ordner, "%s-preise.json" % datum), "w",
                      encoding="utf-8") as f:
                json.dump(tabelle, f, ensure_ascii=False, indent=1)
            preis_zeilen = upsert(preis_zeilen, zeile)
            schreib_csv(preis_csv, preis_header(preis_zeilen, kategorien, tarife),
                        preis_zeilen)
        else:
            preis_zeilen = upsert(preis_zeilen, zeile)
    except Fehler as e:
        fehler.append("Preisabruf: %s" % e)
    except Exception as e:
        fehler.append("Preisabruf: %s" % e)

    # ---- Vergleichstermine (nur alle paar Tage - sind neun weitere Seitenaufrufe)
    if not trocken and vergleich_faellig(reise, glob, ordner):
        try:
            hole_vergleich(reise, glob, ordner)
        except Exception as e:
            fehler.append("Vergleichstermine: %s" % e)

    lage = bewerte(reise, glob, preis_zeilen, kabinen_zeilen)

    if not trocken:
        reise = dict(reise)
        reise["zuletzt_geprueft"] = stempel.strftime("%Y-%m-%d %H:%M")
        reise["letzter_fehler"] = fehler[0] if fehler else ""
        schreib_json(reise_pfad(ordner, code), reise)

    aufraeumen(raw_ordner, glob.get("verhalten", {}).get("raw_aufbewahren_tage", 120))

    return {"code": code, "reise": reise, "lage": lage, "fehler": fehler,
            "zaehlung": zaehlung, "stand": "%s %s" % (datum, uhrzeit),
            "einschaetzung": einschaetzung(reise, glob, preis_zeilen, kabinen_zeilen, lage,
                                           lies_vergleich(reise, ordner))}


def aufraeumen(raw_ordner, tage):
    if tage <= 0 or not os.path.isdir(raw_ordner):
        return
    grenze = (datetime.now() - timedelta(days=tage)).strftime("%Y-%m-%d")
    for name in os.listdir(raw_ordner):
        stamm = name[:10]
        if re.match(r"^\d{4}-\d{2}-\d{2}$", stamm) and stamm < grenze:
            try:
                os.remove(os.path.join(raw_ordner, name))
            except OSError:
                pass


# --------------------------------------------------------------------------
# Status fuer die Weboberflaeche
# --------------------------------------------------------------------------

def erstbefuellung(ordner=ORDNER):
    """
    Beim ersten Start im Container ist das Datenvolumen leer. Dann werden die
    Vorgaben aus vorgaben/ hineinkopiert - die bereits gesammelte Messreihe
    geht so nicht verloren. Vorhandene Daten werden NIE ueberschrieben.
    """
    quelle = os.path.join(ordner, "vorgaben")
    if not os.path.isdir(quelle):
        return []
    import shutil
    kopiert = []
    for teil in ("reisen", "daten", "vergleich"):
        q = os.path.join(quelle, teil)
        z = os.path.join(wurzel(ordner), teil)
        if not os.path.isdir(q):
            continue
        os.makedirs(z, exist_ok=True)
        for name in os.listdir(q):
            qp, zp = os.path.join(q, name), os.path.join(z, name)
            if os.path.exists(zp):
                continue
            if os.path.isdir(qp):
                shutil.copytree(qp, zp)
            else:
                shutil.copy2(qp, zp)
            kopiert.append(os.path.join(teil, name))
    if kopiert:
        log("Erstbefuellung aus vorgaben/: %s" % ", ".join(kopiert))
    return kopiert


def status(ordner=ORDNER):
    glob = lade_global(ordner)
    ausgabe = []
    for reise in lade_reisen(ordner):
        code = reise["code"]
        dordner = os.path.join(wurzel(ordner), "daten", code)
        preis_zeilen = lies_csv(os.path.join(dordner, "preise.csv"))
        kabinen_zeilen = lies_csv(os.path.join(dordner, "kabinen.csv"))
        lage = bewerte(reise, glob, preis_zeilen, kabinen_zeilen)
        vergleich = lies_vergleich(reise, ordner)
        ausgabe.append({
            "reise": reise,
            "laeuft": ueberwachung_laeuft(reise),
            "flug": flug_von(reise, glob),
            "links": buchungslinks(reise, glob),
            "preise": preis_zeilen,
            "kabinen": kabinen_zeilen,
            "lage": lage,
            "vergleich": vergleich,
            "einschaetzung": einschaetzung(reise, glob, preis_zeilen, kabinen_zeilen, lage,
                                           vergleich),
        })
    return {"stand": jetzt_lokal().strftime("%Y-%m-%d %H:%M"),
            "global": glob, "reisen": ausgabe}


def baue_dashboard(ordner=ORDNER, ziel=None):
    """Statische Momentaufnahme - Notnagel, falls der Server nicht laeuft."""
    vorlage = os.path.join(ordner, "web", "index.html")
    if not os.path.exists(vorlage):
        return None
    with open(vorlage, encoding="utf-8") as f:
        html = f.read()
    html = html.replace("/*__DATEN__*/null", json.dumps(status(ordner), ensure_ascii=False))
    ziel = ziel or os.path.join(wurzel(ordner), "dashboard.html")
    with open(ziel, "w", encoding="utf-8") as f:
        f.write(html)
    return ziel


# --------------------------------------------------------------------------
# Migration der Einzelreisen-Struktur von vor dem Umbau
# --------------------------------------------------------------------------

def migriere(ordner=ORDNER):
    """Alte config.json mit 'reise'/'wunsch' in reisen/<code>.json ueberfuehren."""
    cfg = lade_json(os.path.join(ordner, "config.json")) or {}
    if "reise" not in cfg or not cfg.get("reise", {}).get("code"):
        return None
    code = cfg["reise"]["code"]
    if os.path.exists(reise_pfad(ordner, code)):
        return None
    w = cfg.get("wunsch", {})
    reise = {
        "code": code,
        "schiff": cfg["reise"].get("schiff", ""),
        "titel": cfg["reise"].get("titel", ""),
        "von": cfg["reise"].get("von", ""),
        "bis": cfg["reise"].get("bis", ""),
        "naechte": cfg["reise"].get("naechte"),
        "route": cfg["reise"].get("route", ""),
        "aktiv": True,
        "ueberwachen_bis": "",
        "tarif": w.get("tarif", "LIGHT"),
        "reisende": w.get("reisende", [2, 0, 0]),
        "preismodell": w.get("preismodell", "IND"),
        "gruppen": w.get("gruppen", []),
        "preisreihen": w.get("preisreihen", []),
        "flug": cfg.get("flug", {}),
        "angelegt": heute(),
    }
    schreib_json(reise_pfad(ordner, code), reise)
    # Messdaten in den Reiseordner schieben
    alt = os.path.join(ordner, "daten")
    neu = daten_ordner(ordner, code)
    for name in ("kabinen.csv", "preise.csv"):
        q = os.path.join(alt, name)
        if os.path.exists(q) and not os.path.exists(os.path.join(neu, name)):
            os.replace(q, os.path.join(neu, name))
    raw_neu = os.path.join(ordner, "raw", code)
    os.makedirs(raw_neu, exist_ok=True)
    raw_alt = os.path.join(ordner, "raw")
    for name in os.listdir(raw_alt):
        q = os.path.join(raw_alt, name)
        if os.path.isfile(q):
            os.replace(q, os.path.join(raw_neu, name))
    return code


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def berichte(erg, glob):
    r = erg["reise"]
    lage = erg["lage"]
    print()
    print("%s  %s (%s)" % (r.get("schiff", ""), r.get("titel", ""), r["code"]))
    print("Stand %s" % erg["stand"])
    print("-" * 60)
    flug = flug_von(r, glob)
    personen = sum(r.get("reisende") or [2, 0, 0])
    for g in lage["gruppen"]:
        print()
        print("%s%s" % (g["name"], "  (Wunschkabine)" if g["primaer"] else ""))
        if g["preis_heute"] is not None:
            print("   %-8s         %s EUR  (%d Pers., ohne Flug)"
                  % (r.get("tarif", "LIGHT") + ":", euro(g["preis_heute"]), personen))
            for fh, kosten in flug.items():
                print("   p.P. inkl. Flug %s: %s EUR"
                      % (fh, euro(pp_inkl_flug(g["preis_heute"], kosten, personen))))
            if g["preis_vortag"] is not None:
                d = g["preis_heute"] - g["preis_vortag"]
                pfeil = "=" if d == 0 else ("+" if d > 0 else "-")
                print("   zum Vortag:      %s %s EUR (%+.1f %%)"
                      % (pfeil, euro(abs(d)), d / float(g["preis_vortag"]) * 100))
            if g["preis_erst"] is not None:
                print("   zur Erstmessung: %+d EUR" % (g["preis_heute"] - g["preis_erst"]))
        else:
            print("   %s: KEIN PREIS MEHR - Kontingent erschoepft." % r.get("tarif", "LIGHT"))
        if g["frei"] is not None:
            zusatz = ""
            if g["frei_vortag"] is not None:
                zusatz = "  (%+d zum letzten Lauf)" % (g["frei"] - g["frei_vortag"])
            print("   freie Kabinen:   %d%s" % (g["frei"], zusatz))

    ein = erg.get("einschaetzung")
    if ein:
        print()
        print("Einschaetzung: %s  (Vertrauen: %s)" % (ein["titel"], ein["vertrauen"]))
        for zeile in ein["signale"]:
            print("   - %s" % zeile)

    if erg["fehler"]:
        print()
        for f in erg["fehler"]:
            print("FEHLER: %s" % f)
    if lage["alarm"]:
        print()
        print("*** ALARM ***")
        for g in lage["gruende"]:
            print("  - %s" % g)
        print("  Beratung: %s" % glob["links"]["beratung"])


def main():
    p = argparse.ArgumentParser(description="AIDA-Ueberwachung: Kabinen und Preise.")
    p.add_argument("--dir", default=ORDNER, help="Arbeitsordner")
    p.add_argument("--code", help="nur diese eine Reise pruefen")
    p.add_argument("--alle-auch-beendete", action="store_true",
                   help="auch Reisen pruefen, deren Ueberwachungsende erreicht ist")
    p.add_argument("--trocken", action="store_true", help="nichts schreiben")
    p.add_argument("--html", action="store_true", help="zusaetzlich dashboard.html schreiben")
    p.add_argument("--leise", action="store_true", help="keine macOS-Mitteilung")
    p.add_argument("--status", action="store_true", help="nur den Status als JSON ausgeben")
    args = p.parse_args()

    ordner = os.path.abspath(os.path.expanduser(args.dir))
    migriere(ordner)
    erstbefuellung(ordner)
    glob = lade_global(ordner)

    if args.status:
        print(json.dumps(status(ordner), ensure_ascii=False, indent=1))
        return

    reisen = [lade_reise(ordner, args.code)] if args.code else lade_reisen(ordner)
    if not args.code and not args.alle_auch_beendete:
        reisen = [r for r in reisen if ueberwachung_laeuft(r)]

    if not reisen:
        print("Keine aktive Reise. Ueberwachung beendet oder noch nichts angelegt.")
        if args.html:
            baue_dashboard(ordner)
        return

    schlimm = False
    with Sperre(ordner):
        for reise in reisen:
            erg = lauf_reise(reise, glob, ordner, trocken=args.trocken)
            berichte(erg, glob)
            if erg["fehler"]:
                schlimm = True
            if not args.leise and not args.trocken \
                    and glob.get("verhalten", {}).get("benachrichtigung", True):
                lage = erg["lage"]
                kurz = "%s %s" % (erg["reise"].get("schiff", ""), erg["reise"]["code"])
                if erg["fehler"]:
                    mitteilung("AIDA-Check fehlgeschlagen (%s)" % kurz, erg["fehler"][0][:180])
                elif lage["alarm"]:
                    mitteilung("AIDA ALARM - %s" % kurz, "; ".join(lage["gruende"])[:180])
                elif lage["meldenswert"] and lage["preis_heute"] is not None:
                    mitteilung("AIDA Preisaenderung - %s" % kurz,
                               "%s: %s EUR (%+d zum Vortag)"
                               % (lage["gruppen"][0]["name"], euro(lage["preis_heute"]),
                                  lage["preis_heute"] - (lage["preis_vortag"]
                                                         or lage["preis_heute"])))
        if args.html and not args.trocken:
            ziel = baue_dashboard(ordner)
            if ziel:
                print()
                print("Momentaufnahme: %s" % ziel)

    print()
    print("Oberflaeche: http://%s:%s" % (glob["server"]["host"], glob["server"]["port"]))
    sys.exit(1 if schlimm else 0)


if __name__ == "__main__":
    main()
