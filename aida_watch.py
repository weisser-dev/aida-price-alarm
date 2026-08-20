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

Bitte hoechstens ein paar Mal am Tag laufen lassen. Der Mindestabstand aus
config.json wird erzwungen.

Ein Lauf besteht aus:

    1 x cabins.php          fremde Buchungsstrecke, kein oeffentliches API -
                            genau ein Aufruf je Lauf, das bleibt so
    1 x Reiseseite          Preistafel, Aktionshinweise, Livewire-Bausteine
  <=14 x Livewire-Endpunkt  Preisaenderungs-Archiv derselben Seite
    8 x Reiseseite          Vergleichstermine der Nachbarwochen
    1 x Aktionsseite        nur, wenn der Gueltigkeitszeitraum fehlt oder alt ist

Alles ausser dem ersten Punkt sind Aufrufe einer ganz normalen Website. Wem das
zu viel ist, drosselt es in config.json unter "verhalten".
"""

import argparse
import csv
import errno
import fcntl
import html as html_mod
import http.cookiejar
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

# Die Preisentwicklung von euresa haengt an einer Livewire-Komponente: der
# CSRF-Wert aus dem Seitenquelltext gilt nur zusammen mit dem Sitzungskeks aus
# demselben Abruf. Deshalb teilen sich GET und POST ein Keksglas.
_KEKSE = http.cookiejar.CookieJar()
_OEFFNER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_KEKSE))


def http_get(url, timeout=40):
    req = urllib.request.Request(url, method="GET")
    req.add_header("user-agent", UA)
    req.add_header("accept", "text/html,application/xhtml+xml")
    req.add_header("accept-language", "de-DE,de;q=0.9")
    with _OEFFNER.open(req, timeout=timeout) as antwort:
        roh = antwort.read()
    for kodierung in ("utf-8", "latin-1"):
        try:
            return roh.decode(kodierung)
        except UnicodeDecodeError:
            continue
    return roh.decode("utf-8", "replace")


def http_post_json(url, nutzlast, referer, csrf, timeout=40):
    daten = json.dumps(nutzlast).encode("utf-8")
    req = urllib.request.Request(url, data=daten, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("accept", "application/json")
    req.add_header("x-livewire", "true")
    req.add_header("x-csrf-token", csrf)
    req.add_header("referer", referer)
    req.add_header("origin", "https://euresa-reisen.de")
    req.add_header("accept-language", "de-DE,de;q=0.9")
    req.add_header("user-agent", UA)
    with _OEFFNER.open(req, timeout=timeout) as antwort:
        return json.loads(antwort.read().decode("utf-8"))


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
# Aktionen und Preisaenderungs-Historie von euresa
# --------------------------------------------------------------------------
#
# euresa schreibt beides selbst auf der Reiseseite mit und verschenkt es:
#
#   * an jeder Preiskachel steht der Name der laufenden Aktion und die
#     ausgewiesene Preissenkung ("AIDA Herbst Deals", "Preissenkung: -100 €"),
#   * der Abschnitt "Preisentwicklung" fuehrt seit dem 01.06.2025 Buch ueber
#     jede Preisaenderung - mit Datum, Betrag UND Prozentwert.
#
# Der zweite Teil ist der Grund, warum dieses Programm ueberhaupt etwas ueber
# das Verhalten von Preisen sagen kann: die eigene Messreihe ist ein paar Tage
# lang, das euresa-Archiv reicht Monate zurueck.

MONATE = {"januar": 1, "februar": 2, "maerz": 3, "märz": 3, "april": 4, "mai": 5,
          "juni": 6, "juli": 7, "august": 8, "september": 9, "oktober": 10,
          "november": 11, "dezember": 12}

AKTION_SEITE = re.compile(r'href="(https://euresa-reisen\.de/angebote/aktuelles/[^"]+)"')


def _slug(text):
    tausch = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}
    klein = "".join(tausch.get(z, z) for z in (text or "").lower())
    return re.sub(r"[^a-z0-9]+", "-", klein).strip("-")


def _datum_lang(tag, monat, jahr):
    nr = MONATE.get((monat or "").lower())
    if not nr or not jahr:
        return None
    try:
        return "%04d-%02d-%02d" % (int(jahr), nr, int(tag))
    except (TypeError, ValueError):
        return None


def parse_aktionen(zeilen, kategorien, tarife):
    """
    Je Kategorie/Tarif: laufende Aktion und ausgewiesene Preissenkung.

    Der Seitenaufbau an einer Preiskachel ist:

        AIDA LIGHT
        AIDA Herbst Deals          <- Aktionsname, direkt hinter dem Tarif
        ab
        1.498 €
        pro Kabine
        Preissenkung:
        -100 €
    """
    start = None
    for i, z in enumerate(zeilen):
        if "Gesamtpreis" in z and "je Kabine" in z:
            start = i
            break
    if start is None:
        return OrderedDict()

    aus = OrderedDict()
    kategorie = tarif = None
    erwarte_namen = False

    for i in range(start + 1, len(zeilen)):
        zeile = zeilen[i]

        if zeile in kategorien:
            kategorie, tarif, erwarte_namen = zeile, None, False
            continue

        if re.match(r"^(Reiseverlauf|Preisentwicklung|EURESA Vorteile|"
                    r"H(ae|ä)ufige Fragen)$", zeile):
            if len(aus) >= 3:
                break
            continue

        treffer = re.match(r"^AIDA ([A-Z][A-Z ]*[A-Z])\s*$", zeile)
        if treffer:
            kandidat = re.sub(r"\s+", " ", treffer.group(1)).strip()
            tarif = kandidat if kandidat in tarife else None
            erwarte_namen = tarif is not None
            continue

        if not (kategorie and tarif):
            continue
        feld = aus.setdefault(kategorie, OrderedDict()).setdefault(tarif, {})

        if erwarte_namen:
            erwarte_namen = False
            # "ab" / ein Preis / "Loading..." heisst: diese Kachel hat keine Aktion
            if not re.match(r"^(ab|pro Kabine|Loading\.\.\.|[\d.]+\s*€)$", zeile):
                feld["aktion"] = zeile
                continue

        if zeile.startswith("Preissenkung"):
            # mal "Preissenkung: -100 €" in einer Zeile, mal auf zwei verteilt
            rest = zeile.split(":", 1)[1] if ":" in zeile else ""
            if not rest.strip() and i + 1 < len(zeilen):
                rest = zeilen[i + 1]
            betrag = re.match(r"^\s*([+-]?[\d.]+)\s*€\s*$", rest)
            if betrag:
                feld["senkung"] = int(betrag.group(1).replace(".", ""))

    # leere Kacheln wieder herauswerfen, damit die Datei nicht mit {} zuwaechst
    sauber = OrderedDict()
    for kat, tarife_ in aus.items():
        innen = OrderedDict((t, w) for t, w in tarife_.items() if w)
        if innen:
            sauber[kat] = innen
    return sauber


def aktion_aus_seite(roh, name, timeout=30):
    """
    Holt den Gueltigkeitszeitraum der Aktion von der verlinkten Aktionsseite.
    Auf der Reiseseite steht nur der Name; das Fenster steht im Fliesstext der
    Aktionsseite ("Die Aktion beginnt am Donnerstag, 13. August und laeuft bis
    Montag, 07. September 2026.").

    Gibt {"name", "von", "bis", "quelle", "geprueft"} zurueck oder None.
    """
    if not name:
        return None
    kandidaten = AKTION_SEITE.findall(roh)
    if not kandidaten:
        return None
    marke = _slug(name).replace("aida-", "")
    treffer = [u for u in kandidaten if marke and marke in u] or kandidaten
    text = " ".join(html_zu_zeilen(http_get(treffer[0], timeout=timeout)))

    von = bis = None
    spanne = re.search(
        r"beginnt\s+am\s+[A-Za-zäöüÄÖÜ]+,?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})?"
        r"[^.]{0,60}?bis\s+[A-Za-zäöüÄÖÜ]+,?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})",
        text)
    if spanne:
        jahr = spanne.group(6)
        von = _datum_lang(spanne.group(1), spanne.group(2), spanne.group(3) or jahr)
        bis = _datum_lang(spanne.group(4), spanne.group(5), jahr)
    else:
        ende = re.search(r"(?:l(?:ae|äu)uft\s+bis|g(?:ue|ü)ltig\s+bis|buchbar\s+bis)"
                         r"\s+(?:[A-Za-zäöüÄÖÜ]+,?\s*)?(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)"
                         r"\s*(\d{4})", text)
        if ende:
            bis = _datum_lang(ende.group(1), ende.group(2), ende.group(3))
    if not bis:
        return None
    return {"name": name, "von": von, "bis": bis, "quelle": treffer[0],
            "geprueft": heute()}


# ---- Preisaenderungs-Archiv (Livewire-Komponente der Reiseseite) ----------

def _select_optionen(roh, feld_id):
    block = re.search(r'<select[^>]*id="%s"[^>]*>([\s\S]*?)</select>' % re.escape(feld_id), roh)
    if not block:
        return {}
    aus = {}
    for treffer in re.finditer(r'<option value="([^"]*)"[^>]*>([^<]*)</option>', block.group(1)):
        wert = treffer.group(1).strip()
        text = html_mod.unescape(treffer.group(2)).strip()
        if wert and text and text != "---":
            aus[re.sub(r"^AIDA\s+", "", text)] = wert
    return aus


def livewire_teile(roh):
    """Die Bausteine, die ein Livewire-Aufruf der Preisentwicklung braucht."""
    csrf = re.search(r'data-csrf="([^"]*)"', roh)
    uri = re.search(r'data-update-uri="([^"]*)"', roh)
    schnappschuss = None
    for treffer in re.finditer(r'wire:snapshot="([^"]*)"', roh):
        s = html_mod.unescape(treffer.group(1))
        if "filterPriceChanges" in s:
            schnappschuss = s
            break
    if not (csrf and uri and schnappschuss):
        return None
    return {"csrf": csrf.group(1), "uri": uri.group(1), "snapshot": schnappschuss,
            "tarife": _select_optionen(roh, "price_model_id"),
            "kategorien": _select_optionen(roh, "organizer_cabin_category_id")}


def parse_aenderungen(htm):
    """Die Tabelle 'Zeitpunkt | Aenderung [€] | Aenderung [%]' auslesen."""
    koerper = re.search(r"<tbody[^>]*>([\s\S]*?)</tbody>", htm)
    if not koerper:
        return []
    aus = []
    for roh_zeile in re.split(r"<tr\b", koerper.group(1))[1:]:
        text = " ".join(html_zu_zeilen(roh_zeile))
        tag = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", text)
        betrag = re.search(r"([+-]\s?[\d.]+)\s*€", text)
        if not (tag and betrag):
            continue
        eur = int(re.sub(r"[^\d-]", "", betrag.group(1).replace(" ", "")))
        proz = re.search(r"([+-]?\d+(?:\.\d{3})*,\d+)\s*%", text)
        wert = None
        if proz:
            wert = abs(float(proz.group(1).replace(".", "").replace(",", ".")))
            # euresa schreibt Zuwaechse ohne Vorzeichen - der Betrag verraet die Richtung
            wert = -wert if eur < 0 else wert
        aus.append({"datum": "%s-%s-%s" % (tag.group(3), tag.group(2), tag.group(1)),
                    "eur": eur, "prozent": wert})
    return aus


def hole_preisaenderungen(teile, kategorie, tarif, mit_flug, referer, timeout=30):
    """Die letzten Preisaenderungen einer Konstellation. None = nicht abfragbar."""
    kat_id = teile["kategorien"].get(kategorie)
    tar_id = teile["tarife"].get(tarif)
    if not (kat_id and tar_id):
        return None
    nutzlast = {"_token": teile["csrf"], "components": [{
        "snapshot": teile["snapshot"],
        "updates": {
            "filterPriceChanges.price_model_id": tar_id,
            "filterPriceChanges.organizer_cabin_category_id": kat_id,
            "filterPriceChanges.flight": "1" if mit_flug else "0",
        },
        "calls": [],
    }]}
    antwort = http_post_json(teile["uri"], nutzlast, referer, teile["csrf"], timeout)
    teilstuecke = antwort.get("components") or []
    if not teilstuecke:
        return []
    return parse_aenderungen((teilstuecke[0].get("effects") or {}).get("html", ""))


def merke_aktion(reise, aktionen, roh_html, glob, timeout=30):
    """
    Haelt fest, welche Aktion an der Wunschkonstellation haengt und bis wann
    sie laeuft. Der Name steht an der Preiskachel, das Enddatum nur im Text der
    verlinkten Aktionsseite - die wird deshalb nur geholt, wenn sich der Name
    geaendert hat oder das gespeicherte Fenster alt ist.
    """
    reise = dict(reise)
    reise["aktionen"] = aktionen or {}

    tarif = reise.get("tarif", "LIGHT")
    wunsch = gruppen_aus(reise)[0]["name"] if gruppen_aus(reise) else ""
    eigen = (aktionen or {}).get(wunsch, {}).get(tarif, {})
    name = eigen.get("aktion")
    if not name:
        # Der Nachlass haengt an der einzelnen Kachel, der Aktionsname gilt fuer
        # die ganze Reise - also die haeufigste Nennung nehmen.
        namen = Counter(w["aktion"] for k in (aktionen or {}).values()
                        for w in k.values() if w.get("aktion"))
        name = namen.most_common(1)[0][0] if namen else None

    alt = reise.get("aktion") or {}
    reise["aktion"] = dict(alt)
    reise["aktion"]["nachlass"] = eigen.get("senkung")

    if not name:
        reise["aktion"]["name"] = alt.get("name")
        return reise

    hoechstalter = int(glob.get("verhalten", {}).get("aktion_pruefen_alle_tage", 7) or 7)
    frisch = alt.get("geprueft") and _tage(alt["geprueft"], heute()) is not None \
        and _tage(alt["geprueft"], heute()) < hoechstalter
    if alt.get("name") == name and alt.get("bis") and frisch:
        reise["aktion"]["name"] = name
        return reise

    gefunden = None
    try:
        gefunden = aktion_aus_seite(roh_html, name, timeout=timeout)
    except Exception:
        gefunden = None
    if gefunden:
        gefunden["nachlass"] = eigen.get("senkung")
        reise["aktion"] = gefunden
    else:
        # Kein Fenster gefunden: Namen uebernehmen, ein von Hand gepflegtes
        # Datum aber nicht wegwerfen.
        reise["aktion"]["name"] = name
        reise["aktion"].setdefault("bis", alt.get("bis"))
    return reise


def archiv_konstellationen(reise, teile, glob, hoechstens=14):
    """
    Welche Kombinationen aus Kategorie und Tarif aus dem euresa-Archiv geholt
    werden - die eigene zuerst, danach die Nachbarn in beide Richtungen:
    derselbe Tarif in anderen Kategorien, dieselbe Kategorie in anderen Tarifen.
    """
    tarif = reise.get("tarif", "LIGHT")
    wunsch = gruppen_aus(reise)[0]["name"] if gruppen_aus(reise) else ""
    kategorien = [k for k in teile["kategorien"] if k]
    tarife = [t for t in teile["tarife"] if t in (glob.get("tarife") or [])]

    aus = []

    def dazu(kat, tar, flug):
        if kat in kategorien and tar in tarife and (kat, tar, flug) not in aus:
            aus.append((kat, tar, flug))

    dazu(wunsch, tarif, False)
    dazu(wunsch, tarif, True)
    for kat in (reise.get("preisreihen") or []) + kategorien:
        dazu(kat, tarif, False)
    for tar in tarife:
        dazu(wunsch, tar, False)
    return aus[:hoechstens]


def hole_archiv(reise, glob, ordner, roh_html, preis_zeilen):
    """
    Holt die Preisaenderungs-Historie aus der Livewire-Komponente der
    Reiseseite und fuehrt sie ins eigene Archiv zusammen. Gibt die Zahl der
    abgefragten Konstellationen zurueck.
    """
    teile = livewire_teile(roh_html)
    if not teile:
        raise Fehler("Preisentwicklung nicht gefunden - Seitenaufbau geaendert.")
    hoechstens = int(glob.get("verhalten", {}).get("archiv_konstellationen", 14) or 0)
    if hoechstens <= 0:
        return 0
    referer = PREIS_URL.format(code=reise["code"])
    gezogen = 0
    for kat, tar, flug in archiv_konstellationen(reise, teile, glob, hoechstens):
        saetze = hole_preisaenderungen(teile, kat, tar, flug, referer)
        if saetze is None:
            continue
        gezogen += 1
        if saetze:
            merke_aenderungen(ordner, reise["code"], kat, tar, flug, saetze)
    return gezogen


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


def hole_vergleich(reise, glob, ordner=ORDNER, vor=None, nach=None):
    """
    Holt die Preistabellen der Nachbartermine. Nur euresa-Seiten, keine
    Buchungsstrecke - das ist eine normale Website und vertraegt das.
    """
    kategorien = glob.get("kategorien") or list(STANDARD_PREFIXE.keys())
    tarife = glob["tarife"]
    tarif = reise.get("tarif", "LIGHT")
    wunsch = (gruppen_aus(reise)[0]["name"] if gruppen_aus(reise) else "")
    verhalten = glob.get("verhalten", {})
    vor = int(verhalten.get("vergleich_wochen_vor", 4)) if vor is None else vor
    nach = int(verhalten.get("vergleich_wochen_nach", 4)) if nach is None else nach

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
        except Fehler as e:
            # "Seite da, aber keine Preise" heisst nicht "Abruf kaputt", sondern
            # dass an dem Termin nichts mehr verkauft wird. Das ist eine Aussage,
            # kein Fehler - und darf nicht wie ein Lesefehler aussehen.
            text = str(e)
            if "keine Preise gelesen" in text:
                eintrag["fehler"] = "keine Preise ausgewiesen – ausgebucht oder kein Verkaufstermin"
                eintrag["ohne_preise"] = True
            else:
                eintrag["fehler"] = text[:200]
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
    """
    vergleich_alle_tage:  0 = bei jedem Lauf (Voreinstellung)
                          n = hoechstens alle n Tage
                         -1 = gar nicht

    Bei jedem Lauf zu vergleichen kostet neun weitere Aufrufe einer ganz
    normalen Website. Dafuer bleibt die Aussage "nur einer von sieben
    Nachbarterminen hat den Tarif noch" so aktuell wie der Preis daneben -
    und die Erosion des Tarifs ueber die Reihe wird ueberhaupt erst messbar.
    """
    tage = int(glob.get("verhalten", {}).get("vergleich_alle_tage", 0) or 0)
    if tage < 0:
        return False
    if tage == 0:
        return True
    alt = lies_vergleich(reise, ordner)
    if not alt or not alt.get("stand"):
        return True
    # Termine, die beim letzten Mal nicht gelesen werden konnten, sind ein
    # Grund fuer sich: sonst fehlen sie bis zum naechsten planmaessigen Lauf
    # stillschweigend in jeder "X von Y"-Aussage.
    if any(not t.get("erreichbar") for t in alt.get("termine", [])):
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

# --------------------------------------------------------------------------
# Preisaenderungs-Archiv und Tarif-Erosion auswerten
# --------------------------------------------------------------------------

AENDERUNGEN_HEADER = ["kategorie", "tarif", "flug", "datum", "eur", "prozent", "gesehen"]
VERGLEICH_HEADER = ["datum", "uhrzeit", "geprueft", "mit_tarif", "anteil_prozent",
                    "classic_mittel", "classic_min", "classic_max", "codes_mit_tarif"]


def prozent(neu, alt):
    """Prozentuale Veraenderung von alt nach neu - None, wenn nicht berechenbar."""
    if neu is None or not alt:
        return None
    return round((neu - alt) / float(alt) * 100.0, 1)


def proz_text(wert, stellen=1):
    if wert is None:
        return "-"
    return ("%+." + str(stellen) + "f %%") % wert


def aenderungen_pfad(ordner, code):
    return os.path.join(daten_ordner(ordner, code), "aenderungen.csv")


def lies_aenderungen(ordner, code):
    return lies_csv(aenderungen_pfad(ordner, code))


def merke_aenderungen(ordner, code, kategorie, tarif, mit_flug, saetze):
    """
    euresa zeigt nur die letzten zehn Aenderungen je Konstellation. Wer sie bei
    jedem Lauf abholt und zusammenfuehrt, baut sich daraus ein Archiv, das
    weiter zurueckreicht als die zehn - und als die eigene Messreihe.
    """
    pfad = aenderungen_pfad(ordner, code)
    zeilen = lies_csv(pfad)
    flug = "1" if mit_flug else "0"
    for satz in saetze or []:
        zeilen = upsert(zeilen, {
            "kategorie": kategorie, "tarif": tarif, "flug": flug,
            "datum": satz["datum"], "eur": satz["eur"],
            "prozent": "" if satz.get("prozent") is None else satz["prozent"],
            "gesehen": heute(),
        }, schluessel=("kategorie", "tarif", "flug", "datum"))
    zeilen.sort(key=lambda z: (z.get("kategorie", ""), z.get("tarif", ""),
                               z.get("flug", ""), z.get("datum", "")))
    schreib_csv(pfad, AENDERUNGEN_HEADER, zeilen)
    return zeilen


def waehle_aenderungen(zeilen, kategorie, tarif, mit_flug=False):
    flug = "1" if mit_flug else "0"
    treffer = [z for z in zeilen
               if z.get("kategorie") == kategorie and z.get("tarif") == tarif
               and z.get("flug", "0") == flug and z.get("datum")]
    return sorted(treffer, key=lambda z: z["datum"])


def werte_aenderungen_aus(zeilen, fenster_tage=180, stichtag=None):
    """
    Was das Archiv ueber das Verhalten der Preise sagt: wie oft sie sich
    bewegen, in welche Richtung, wie gross die Schritte sind und wie lange die
    letzte Bewegung her ist. Das ist Statistik ueber die Vergangenheit,
    ausdruecklich keine Vorhersage.
    """
    stichtag = stichtag or heute()
    im_fenster = []
    for z in zeilen:
        alter = _tage(z["datum"], stichtag)
        if alter is not None and 0 <= alter <= fenster_tage:
            im_fenster.append(z)
    if not im_fenster:
        return None

    betraege = [zahl(z.get("eur")) for z in im_fenster]
    betraege = [b for b in betraege if b is not None]
    hoch = [b for b in betraege if b > 0]
    runter = [b for b in betraege if b < 0]
    prozente = []
    for z in im_fenster:
        try:
            prozente.append(float(z.get("prozent")))
        except (TypeError, ValueError):
            pass

    tage = [_tage(im_fenster[0]["datum"], z["datum"]) for z in im_fenster]
    spanne = max(t for t in tage if t is not None) if len(im_fenster) > 1 else 0
    abstand = round(spanne / float(len(im_fenster) - 1), 1) if len(im_fenster) > 1 else None

    letzte = im_fenster[-1]
    letzte_prozent = None
    try:
        letzte_prozent = float(letzte.get("prozent"))
    except (TypeError, ValueError):
        pass

    return {
        "fenster_tage": fenster_tage,
        "anzahl": len(im_fenster),
        "hoch": len(hoch),
        "runter": len(runter),
        "netto_eur": sum(betraege),
        "netto_prozent": round(sum(prozente), 1) if prozente else None,
        "schritt_hoch_mittel": int(round(sum(hoch) / float(len(hoch)))) if hoch else None,
        "schritt_runter_mittel": int(round(sum(runter) / float(len(runter)))) if runter else None,
        "abstand_tage": abstand,
        "beobachtet_tage": spanne,
        "letzte_datum": letzte["datum"],
        "letzte_eur": zahl(letzte.get("eur")),
        "letzte_prozent": letzte_prozent,
        "tage_seit_letzter": _tage(letzte["datum"], stichtag),
    }


def tarif_verlauf(preis_zeilen, kategorien, tarif):
    """
    Wie viele Kabinenkategorien den Tarif an jedem Messtag noch hatten - die
    einzige Spur, die das Kontingent eines Tarifs in den Daten hinterlaesst.
    Es gibt keine Zahl "noch X Light-Plaetze frei"; sichtbar ist nur, wann eine
    Kategorie den Tarifpreis verliert.
    """
    verlauf = []
    vorher = None
    for zeile in preis_zeilen:
        mit = [k for k in kategorien if zahl(zeile.get("%s|%s" % (k, tarif))) is not None]
        verloren = sorted(set(vorher) - set(mit)) if vorher is not None else []
        zurueck = sorted(set(mit) - set(vorher)) if vorher is not None else []
        verlauf.append({"datum": zeile.get("datum"), "anzahl": len(mit),
                        "kategorien": mit, "verloren": verloren, "zurueck": zurueck})
        vorher = mit
    return verlauf


def vergleich_pfad(ordner, code):
    return os.path.join(daten_ordner(ordner, code), "vergleich.csv")


def merke_vergleich(ordner, code, vergleich, uhrzeit):
    """Ein Datenpunkt je Lauf: wie viele Nachbartermine den Tarif noch haben."""
    ausgewertet = werte_vergleich_aus(vergleich)
    if not ausgewertet:
        return []
    mit_tarif = [t.get("code") for t in vergleich.get("termine", [])
                 if t.get("erreichbar") and t.get("wunsch_tarif") is not None]
    anteil = round(ausgewertet["mit_tarif"] / float(ausgewertet["geprueft"]) * 100, 1)
    zeilen = upsert(lies_csv(vergleich_pfad(ordner, code)), {
        "datum": heute(), "uhrzeit": uhrzeit,
        "geprueft": ausgewertet["geprueft"], "mit_tarif": ausgewertet["mit_tarif"],
        "anteil_prozent": anteil,
        "classic_mittel": ausgewertet["classic_mittel"] or "",
        "classic_min": ausgewertet["classic_min"] or "",
        "classic_max": ausgewertet["classic_max"] or "",
        "codes_mit_tarif": json.dumps(mit_tarif, ensure_ascii=False),
    })
    schreib_csv(vergleich_pfad(ordner, code), VERGLEICH_HEADER, zeilen)
    return zeilen


def erosion_aus_vergleich(zeilen):
    """Wie sich die Tarifverfuegbarkeit ueber die Nachbartermine entwickelt hat."""
    sauber = [z for z in zeilen if zahl(z.get("geprueft"))]
    if len(sauber) < 2:
        return None
    erst, letzt = sauber[0], sauber[-1]
    tage = _tage(erst["datum"], letzt["datum"])
    return {
        "seit": erst["datum"], "tage": tage,
        "von_mit_tarif": zahl(erst.get("mit_tarif")), "von_geprueft": zahl(erst.get("geprueft")),
        "auf_mit_tarif": zahl(letzt.get("mit_tarif")), "auf_geprueft": zahl(letzt.get("geprueft")),
    }


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


def einschaetzung(reise, glob, preis_zeilen, kabinen_zeilen, lage, vergleich=None,
                  aenderungen=None, vergleich_verlauf=None):
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
            "kennzahlen": kennzahlen, "archiv": None, "erosion": None,
            "warten": {}, "tarif_verlauf": [],
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

    # Prozente sagen mehr als Beträge: +80 € sind bei der Innenkabine 5,6 %,
    # bei der Junior-Suite 2,2 % - dieselbe Zahl, ein anderer Vorgang.
    if len(werte) > 1:
        kennzahlen["preis_prozent_seit_beginn"] = prozent(werte[-1], werte[0])
        kennzahlen["preis_eur_seit_beginn"] = werte[-1] - werte[0]
    if p_trend is not None and werte and werte[-1]:
        kennzahlen["preis_trend_prozent_pro_tag"] = round(p_trend / float(werte[-1]) * 100, 2)

    seit_beginn = kennzahlen.get("preis_prozent_seit_beginn")
    anhang = "" if seit_beginn is None else (" Seit Beobachtungsbeginn %+d € (%s)."
                                             % (kennzahlen["preis_eur_seit_beginn"],
                                                proz_text(seit_beginn)))
    if p_trend is not None:
        proz_tag = kennzahlen.get("preis_trend_prozent_pro_tag")
        tempo = "%+.0f € pro Tag" % p_trend
        if proz_tag:
            tempo += " (%s)" % proz_text(proz_tag, 2)
        if p_trend > 5:
            punkte += 2
            treiber.append((3, "Preis steigt um %s" % tempo))
            signale.append("Der Preis steigt: rund %s über die bisherige Messreihe.%s"
                           % (tempo, anhang))
        elif p_trend < -5:
            punkte -= 2
            signale.append("Der Preis fällt noch: rund %s. Abwarten hat bisher "
                           "Geld gespart.%s" % (tempo, anhang))
        else:
            signale.append("Der Preis bewegt sich kaum (%s).%s" % (tempo, anhang))
    elif len(werte) > 1:
        signale.append("Preis seit Beobachtungsbeginn %+d € (%s) – für einen Trend aus der "
                       "eigenen Messreihe sind es noch zu wenige Messungen."
                       % (kennzahlen["preis_eur_seit_beginn"], proz_text(seit_beginn)))
    else:
        signale.append("Erst eine Preismessung – aus der eigenen Reihe noch kein Trend.")

    if werte and len(werte) >= 3 and max(werte) > min(werte):
        tief = min(werte)
        if werte[-1] <= tief:
            punkte += 1
            signale.append("Aktuell auf dem bisher tiefsten gemessenen Stand (%s €)." % euro(tief))
        elif tief and (werte[-1] - tief) / float(tief) > 0.03:
            signale.append("Aktuell %s € über dem bisherigen Tief von %s €."
                           % (euro(werte[-1] - tief), euro(tief)))

    # --- Was euresa selbst mitschreibt: jede Preisaenderung seit Juni 2025.
    #     Die eigene Messreihe ist Tage alt, dieses Archiv Monate - fuer die
    #     Frage "wie oft und wie stark bewegt sich der Preis eigentlich" ist
    #     es die einzige belastbare Quelle.
    archiv = werte_aenderungen_aus(waehle_aenderungen(aenderungen or [], name, tarif))
    kennzahlen["archiv"] = archiv
    if archiv and archiv["anzahl"] >= 2:
        richtung = ("%d nach oben, %d nach unten"
                    % (archiv["hoch"], archiv["runter"]))
        netto = "%+d €" % archiv["netto_eur"]
        if archiv["netto_prozent"] is not None:
            netto += " (%s)" % proz_text(archiv["netto_prozent"])
        signale.append("euresa hat für %s im Tarif %s in den letzten %d Tagen "
                       "%d Preisänderungen verzeichnet – %s, unterm Strich %s."
                       % (name, tarif, archiv["beobachtet_tage"] or archiv["fenster_tage"],
                          archiv["anzahl"], richtung, netto))
        if archiv["abstand_tage"]:
            rhythmus = ("Im Schnitt bewegt sich dieser Preis alle %.1f Tage."
                        % archiv["abstand_tage"])
            if archiv["tage_seit_letzter"] is not None:
                letzte = "%+d €" % archiv["letzte_eur"]
                if archiv["letzte_prozent"] is not None:
                    letzte += " / %s" % proz_text(archiv["letzte_prozent"])
                rhythmus += (" Die letzte war vor %d Tagen (%s, %s)."
                             % (archiv["tage_seit_letzter"], archiv["letzte_datum"], letzte))
                if archiv["tage_seit_letzter"] > archiv["abstand_tage"] * 1.5:
                    rhythmus += (" Nach diesem Rhythmus ist die nächste Änderung überfällig – "
                                 "das ist eine Beobachtung über die Vergangenheit, keine Zusage.")
            signale.append(rhythmus)
        if archiv["hoch"] and archiv["hoch"] >= 2 * max(archiv["runter"], 1):
            punkte += 1
            treiber.append((3, "%d von %d Änderungen gingen nach oben"
                            % (archiv["hoch"], archiv["anzahl"])))
            signale.append("Von %d Änderungen gingen %d nach oben. Bei dieser Reise hat sich "
                           "Warten in der Vergangenheit überwiegend verteuert."
                           % (archiv["anzahl"], archiv["hoch"]))
        elif archiv["runter"] > archiv["hoch"]:
            punkte -= 1
            signale.append("Von %d Änderungen gingen %d nach unten – der Preis ist bei dieser "
                           "Reise bisher eher gefallen als gestiegen."
                           % (archiv["anzahl"], archiv["runter"]))
    elif archiv:
        signale.append("Im euresa-Archiv steht für %s im Tarif %s bisher nur eine Änderung "
                       "(%s, %+d €)." % (name, tarif, archiv["letzte_datum"], archiv["letzte_eur"]))
    else:
        signale.append("Für %s im Tarif %s hat euresa noch keine Preisänderung verzeichnet – "
                       "dieser Preis steht, solange er beobachtet wird." % (name, tarif))

    # --- Tarif-Erosion: wie viele Kategorien den Tarif ueber die Zeit verlieren.
    #     Es gibt keine Zahl "noch X Kontingente frei"; die einzige Spur, die
    #     ein erschoepftes Kontingent hinterlaesst, ist der verschwundene Preis.
    verlauf = tarif_verlauf(preis_zeilen, glob.get("kategorien") or [], tarif)
    if len(verlauf) > 1:
        erst, letzt = verlauf[0], verlauf[-1]
        kennzahlen["kategorien_mit_tarif"] = letzt["anzahl"]
        kennzahlen["kategorien_mit_tarif_beginn"] = erst["anzahl"]
        gefallen = [(s["datum"], k) for s in verlauf[1:] for k in s["verloren"]]
        kennzahlen["tarif_verluste"] = [{"datum": d, "kategorie": k} for d, k in gefallen]
        if gefallen:
            punkte += 1
            jung = gefallen[-1]
            treiber.append((4, "%s hat %s am %s verloren" % (jung[1], tarif, jung[0])))
            signale.append("Seit Beobachtungsbeginn hat %s den %s-Tarif verloren (%s). "
                           "Von %d Kategorien bieten ihn noch %d."
                           % (", ".join(k for _, k in gefallen), tarif,
                              ", ".join(d for d, _ in gefallen),
                              erst["anzahl"], letzt["anzahl"]))
        elif letzt["anzahl"] == erst["anzahl"]:
            signale.append("Die Zahl der Kategorien mit %s-Tarif ist seit Beobachtungsbeginn "
                           "unverändert (%d)." % (tarif, letzt["anzahl"]))

    # --- Dasselbe ueber die Nachbartermine: erst der Verlauf macht daraus eine
    #     Erosionskurve statt einer Momentaufnahme.
    erosion = erosion_aus_vergleich(vergleich_verlauf or [])
    kennzahlen["erosion"] = erosion
    if erosion and erosion["von_mit_tarif"] is not None and erosion["tage"]:
        weg = erosion["von_mit_tarif"] - erosion["auf_mit_tarif"]
        if weg > 0:
            punkte += 1
            treiber.append((4, "%d Nachbartermine haben %s in %d Tagen verloren"
                            % (weg, tarif, erosion["tage"])))
            signale.append("Vor %d Tagen hatten noch %d von %d Nachbarterminen den %s-Tarif, "
                           "heute sind es %d von %d. Das Kontingent zieht sich messbar zurück."
                           % (erosion["tage"], erosion["von_mit_tarif"], erosion["von_geprueft"],
                              tarif, erosion["auf_mit_tarif"], erosion["auf_geprueft"]))
        elif weg < 0:
            signale.append("Über die Nachbartermine ist der %s-Tarif seit %d Tagen sogar wieder "
                           "häufiger geworden (%d statt %d von %d)."
                           % (tarif, erosion["tage"], erosion["auf_mit_tarif"],
                              erosion["von_mit_tarif"], erosion["auf_geprueft"]))

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

    # --- Was Warten konkret kostet
    #
    # Zwei Zahlen, die sich beziffern lassen, statt eines Gefuehls:
    #   * das Rueckfallrisiko - faellt der Tarif weg, kostet dieselbe Kabine
    #     den naechstguenstigen Tarif,
    #   * die Drift - was der Preis nach dem bisherigen Rhythmus in 30 Tagen
    #     macht. Das ist eine Fortschreibung der Vergangenheit, nichts weiter.
    warten = {}
    letzte_zeile = preis_zeilen[-1] if preis_zeilen else {}
    eigener = haupt.get("preis_heute")
    if eigener:
        alternativen = []
        for tar in (glob.get("tarife") or []):
            if tar == tarif:
                continue
            wert = zahl(letzte_zeile.get("%s|%s" % (name, tar)))
            if wert is not None and wert > eigener:
                alternativen.append((wert, tar))
        if alternativen:
            aufpreis, ersatz = min(alternativen)
            warten["rueckfall_tarif"] = ersatz
            warten["rueckfall_eur"] = aufpreis - eigener
            warten["rueckfall_prozent"] = prozent(aufpreis, eigener)
            signale.append("Fällt %s weg, ist %s der nächstgünstigste Tarif für %s: %s € statt "
                           "%s €, also %+d € (%s). Das ist der Betrag, um den es beim Warten "
                           "wirklich geht."
                           % (tarif, ersatz, name, euro(aufpreis), euro(eigener),
                              warten["rueckfall_eur"], proz_text(warten["rueckfall_prozent"])))
        else:
            warten["rueckfall_tarif"] = None
            signale.append("Für %s gibt es keinen teureren Tarif mehr in der Tafel – fällt %s "
                           "weg, ist die Kategorie in dieser Preisklasse erledigt."
                           % (name, tarif))

    if archiv and archiv["beobachtet_tage"] and archiv["netto_eur"]:
        pro_tag = archiv["netto_eur"] / float(max(archiv["beobachtet_tage"], 1))
        warten["drift_30_tage_eur"] = int(round(pro_tag * 30))
        if eigener:
            warten["drift_30_tage_prozent"] = prozent(eigener + warten["drift_30_tage_eur"], eigener)
        signale.append("Im Tempo der letzten %d Tage wären das in 30 Tagen %+d €%s – reine "
                       "Fortschreibung, keine Vorhersage."
                       % (archiv["beobachtet_tage"], warten["drift_30_tage_eur"],
                          "" if warten.get("drift_30_tage_prozent") is None
                          else " (%s)" % proz_text(warten["drift_30_tage_prozent"])))
    kennzahlen["warten"] = warten

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
            "kurz": kurz, "signale": signale, "kennzahlen": kennzahlen,
            "archiv": archiv, "erosion": erosion, "warten": warten,
            "tarif_verlauf": verlauf if len(verlauf) > 1 else []}


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
    # Ein einziger Seitenaufruf, aus dem alles Weitere faellt: die vollstaendige
    # Preistafel, die Aktionshinweise an den Kacheln und die Bausteine fuer das
    # Preisaenderungs-Archiv. Deshalb wird der Quelltext hier festgehalten.
    roh_html = None
    try:
        roh_html = http_get(PREIS_URL.format(code=code))
        tabelle, preis_zeilen_text = parse_preise(roh_html, kategorien, tarife)
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

        # ---- Aktion: Name und Nachlass stehen an den Preiskacheln
        try:
            aktionen = parse_aktionen(preis_zeilen_text, kategorien, tarife)
            reise = merke_aktion(reise, aktionen, roh_html, glob)
        except Exception as e:
            fehler.append("Aktion: %s" % e)
    except Fehler as e:
        fehler.append("Preisabruf: %s" % e)
    except Exception as e:
        fehler.append("Preisabruf: %s" % e)

    # ---- Preisaenderungs-Archiv von euresa
    if roh_html and not trocken:
        try:
            gezogen = hole_archiv(reise, glob, ordner, roh_html, preis_zeilen)
            if gezogen:
                log("   Preisaenderungen: %d Konstellationen abgeglichen" % gezogen)
        except Exception as e:
            fehler.append("Preisaenderungen: %s" % e)

    # ---- Vergleichstermine
    if not trocken and vergleich_faellig(reise, glob, ordner):
        try:
            vergleich_neu = hole_vergleich(reise, glob, ordner)
            merke_vergleich(ordner, code, vergleich_neu, uhrzeit)
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
                                           lies_vergleich(reise, ordner),
                                           lies_aenderungen(ordner, code),
                                           lies_csv(vergleich_pfad(ordner, code)))}


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
        aenderungen = lies_aenderungen(ordner, code)
        vergleich_verlauf = lies_csv(vergleich_pfad(ordner, code))
        ausgabe.append({
            "reise": reise,
            "laeuft": ueberwachung_laeuft(reise),
            "flug": flug_von(reise, glob),
            "links": buchungslinks(reise, glob),
            "preise": preis_zeilen,
            "kabinen": kabinen_zeilen,
            "lage": lage,
            "vergleich": vergleich,
            "aenderungen": aenderungen,
            "vergleich_verlauf": vergleich_verlauf,
            "einschaetzung": einschaetzung(reise, glob, preis_zeilen, kabinen_zeilen, lage,
                                           vergleich, aenderungen, vergleich_verlauf),
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
