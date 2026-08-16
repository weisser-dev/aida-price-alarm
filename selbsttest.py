#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
selbsttest.py - prueft die Auswertung OHNE jeden Netzzugriff.

Laeuft im Deploy-Workflow als Qualitaetstor: schlaegt hier etwas fehl,
wird nicht ausgeliefert. Und laeuft in zwei Sekunden.

    python3 selbsttest.py
"""

import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aida_watch as A

fehler = []


def pruefe(bedingung, was):
    if bedingung:
        print("  ok   %s" % was)
    else:
        print("  FEHL %s" % was)
        fehler.append(was)


# --------------------------------------------------------------------------
# Preistabelle: nachgebauter Ausschnitt der euresa-Seite
# --------------------------------------------------------------------------
SEITE = """
<html><head><title>AIDAcosma: Mediterrane Sch&auml;tze mit Korsika ab Mallorca am 03.10.2026</title></head>
<body>
<h1>Mediterrane Sch&auml;tze mit Korsika ab Mallorca</h1>
<p> 03.10.2026 bis 10.10.2026 (7 N&auml;chte)</p>
<p> AIDAcosma</p>
<h2>Gesamtpreis f&uuml;r 2 Erwachsene je Kabine &amp; Preismodell</h2>
<div>Innenkabine</div>
  <div>AIDA PREMIUM ALL IN </div><span>ab</span><span>2.390 &euro;</span><span>pro Kabine</span>
  <div>Preissenkung: -100 &euro;</div><div>Onboard Chat</div>
  <div>AIDA LIGHT </div><span>ab</span><span>1.418 &euro;</span><span>pro Kabine</span>
<div>Meerblickkabine</div>
  <div>AIDA CLASSIC </div><span>ab</span><span>2.218 &euro;</span><span>pro Kabine</span>
<div>Balkonkabine</div>
  <div>AIDA LIGHT </div><span>ab</span><span>2.258 &euro;</span><span>pro Kabine</span>
  <div>AIDA PREMIUM </div><span>ab</span><span>2.900 &euro;</span><span>pro Kabine</span>
<div>Verandakabine Komfort</div>
  <div>AIDA LIGHT </div><span>ab</span><span>2.258 &euro;</span><span>pro Kabine</span>
  <div>Getr&auml;nkepaket AIDA Comfort Deluxe</div>
  <div>AIDA PREMIUM </div><span>ab</span><span>3.030 &euro;</span><span>pro Kabine</span>
<div>Junior-Suite</div>
  <div>AIDA CLASSIC </div><span>ab</span><span>3.598 &euro;</span><span>pro Kabine</span>
<div>Reiseverlauf</div>
<div>Palma</div><div>AIDA LIGHT</div><span>ab</span><span>999 &euro;</span>
</body></html>
"""

print("Preistabelle lesen")
glob = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
                     encoding="utf-8"))
tabelle, zeilen = A.parse_preise(SEITE, glob["kategorien"], glob["tarife"])
pruefe(tabelle.get("Verandakabine Komfort", {}).get("LIGHT") == 2258, "Veranda Komfort LIGHT = 2258")
pruefe(tabelle.get("Verandakabine Komfort", {}).get("PREMIUM") == 3030, "Veranda Komfort PREMIUM = 3030")
pruefe(tabelle.get("Balkonkabine", {}).get("PREMIUM") == 2900, "Balkon PREMIUM = 2900")
pruefe("LIGHT" not in tabelle.get("Meerblickkabine", {}), "Meerblick hat keinen LIGHT-Preis")
pruefe(tabelle.get("Innenkabine", {}).get("LIGHT") == 1418, "Innen LIGHT = 1418")
pruefe(999 not in [p for k in tabelle.values() for p in k.values()],
       "Abschnitt endet vor dem Reiseverlauf")

print("Kopfdaten lesen")
kopf = A.parse_kopf(zeilen, SEITE)
pruefe(kopf.get("von") == "2026-10-03" and kopf.get("bis") == "2026-10-10", "Termin erkannt")
pruefe(kopf.get("naechte") == 7, "7 Naechte erkannt")
pruefe(kopf.get("schiff") == "AIDAcosma", "Schiff erkannt")
pruefe("Mediterrane" in (kopf.get("titel") or ""), "Titel erkannt")

# --------------------------------------------------------------------------
# Kabinenzaehlung
# --------------------------------------------------------------------------
print("Kabinen zaehlen")
antwort = [
    [{"cabinNumber": "8101", "cabinCategoryCode": "VA", "deck": 8, "selectable": True},
     {"cabinNumber": "8102", "cabinCategoryCode": "VA", "deck": 8, "selectable": True},
     {"cabinNumber": "9001", "cabinCategoryCode": "VB", "deck": 9, "selectable": True},
     {"cabinNumber": "9002", "cabinCategoryCode": "VB", "deck": 9, "selectable": False}],
    [{"cabinNumber": "5001", "cabinCategoryCode": "BA", "deck": 5, "selectable": True}],
]
kabinen = A.flach(antwort)
pruefe(len(kabinen) == 5, "5 Kabinen im Rohdatensatz")
gesamt, nach_code, decks = A.werte_kabinen_aus(kabinen, ["VA", "VB", "VC"])
pruefe(gesamt == 3, "3 buchbare Verandakabinen (die nicht waehlbare faellt raus)")
pruefe(nach_code == {"VA": 2, "VB": 1, "VC": 0}, "Aufteilung je Unterkategorie stimmt")
pruefe(decks == {"8": 2, "9": 1}, "Deckverteilung stimmt")
gesamt_b, _, _ = A.werte_kabinen_aus(kabinen, ["BA", "BB", "BC"])
pruefe(gesamt_b == 1, "Balkonkabinen getrennt gezaehlt")

# --------------------------------------------------------------------------
# Rechnen
# --------------------------------------------------------------------------
print("Umrechnung und Trend")
pruefe(A.pp_inkl_flug(2258, 1000, 2) == 1629, "2.258 € + 1.000 € Flug = 1.629 € p.P.")
pruefe(A.pp_inkl_flug(2258, 800, 2) == 1529, "mit MUC-Flug = 1.529 € p.P.")
pruefe(A.pp_inkl_flug(None, 1000, 2) is None, "ohne Preis kein p.P.-Wert")
pruefe(A.steigung([(0, 100), (1, 110), (2, 120)]) == 10, "Steigung +10 pro Tag")
pruefe(A.steigung([(0, 100), (1, 100)]) is None, "zwei Punkte ergeben noch keinen Trend")
pruefe(A.steigung([(0, 5), (1, 5), (2, 5)]) == 0, "flache Reihe = Steigung 0")

print("Tageszeile ersetzen statt anhaengen")
zeilen_ = []
zeilen_ = A.upsert(zeilen_, {"datum": "2026-08-15", "gruppe": "A", "gesamt": 10}, ("datum", "gruppe"))
zeilen_ = A.upsert(zeilen_, {"datum": "2026-08-15", "gruppe": "B", "gesamt": 20}, ("datum", "gruppe"))
zeilen_ = A.upsert(zeilen_, {"datum": "2026-08-15", "gruppe": "A", "gesamt": 11}, ("datum", "gruppe"))
pruefe(len(zeilen_) == 2, "zweiter Lauf am selben Tag ersetzt die Zeile")
pruefe([z for z in zeilen_ if z["gruppe"] == "A"][0]["gesamt"] == 11, "neuer Wert gewinnt")

# --------------------------------------------------------------------------
# Einschaetzung
# --------------------------------------------------------------------------
print("Einschaetzung")
reise = {"code": "TEST", "tarif": "LIGHT", "von": "2026-10-03", "reisende": [2, 0, 0],
         "gruppen": [{"name": "Verandakabine Komfort", "codes": ["VA"], "primaer": True}],
         "aktion": {"name": "Test-Aktion", "bis": "2026-09-07"}}

def preisreihe(werte, start_tag=14):
    aus = []
    for i, w in enumerate(werte):
        aus.append({"datum": "2026-08-%02d" % (start_tag + i), "uhrzeit": "07:07",
                    "Verandakabine Komfort|LIGHT": "" if w is None else w})
    return aus

def kabinenreihe(werte, start_tag=14):
    return [{"datum": "2026-08-%02d" % (start_tag + i), "uhrzeit": "07:07",
             "gruppe": "Verandakabine Komfort", "gesamt": w,
             "codes": "{}", "decks": "{}"} for i, w in enumerate(werte)]

ruhig_p = preisreihe([2258] * 6)
ruhig_k = kabinenreihe([222, 222, 221, 222, 221, 221])
lage = A.bewerte(reise, glob, ruhig_p, ruhig_k)
e = A.einschaetzung(reise, glob, ruhig_p, ruhig_k, lage)
pruefe(e["stufe"] == "abwarten", "ruhige Lage -> abwarten")
pruefe(e["vertrauen"] in ("niedrig", "mittel"), "kurze Reihe -> kein hohes Vertrauen")

steig_p = preisreihe([2258, 2300, 2350, 2400, 2460, 2520])
steig_k = kabinenreihe([222, 210, 195, 180, 160, 140])
lage2 = A.bewerte(reise, glob, steig_p, steig_k)
e2 = A.einschaetzung(reise, glob, steig_p, steig_k, lage2)
pruefe(e2["stufe"] == "jetzt", "steigender Preis + schwindende Kabinen -> jetzt")
pruefe(e2["kennzahlen"]["preis_trend_eur_pro_tag"] > 40, "Preistrend wird beziffert")
pruefe(e2["kennzahlen"]["kabinen_trend_pro_tag"] < -10, "Kabinentrend wird beziffert")

fall_p = preisreihe([2500, 2450, 2400, 2350, 2300, 2258])
lage3 = A.bewerte(reise, glob, fall_p, ruhig_k)
e3 = A.einschaetzung(reise, glob, fall_p, ruhig_k, lage3)
pruefe(e3["stufe"] == "abwarten", "fallender Preis -> abwarten")

weg_p = preisreihe([2258, 2258, None])
lage4 = A.bewerte(reise, glob, weg_p, ruhig_k)
e4 = A.einschaetzung(reise, glob, weg_p, ruhig_k, lage4)
pruefe(e4["stufe"] == "weg", "verschwundener Tarifpreis -> eigene Stufe")
pruefe(lage4["alarm"] is True, "verschwundener Tarifpreis loest Alarm aus")

# --------------------------------------------------------------------------
# Datenwurzel und Erstbefuellung
# --------------------------------------------------------------------------
print("Datenwurzel und Erstbefuellung")
tmp = tempfile.mkdtemp()
alt = os.environ.get("AIDA_DATA_DIR")
try:
    os.environ["AIDA_DATA_DIR"] = tmp
    pruefe(A.wurzel() == tmp, "AIDA_DATA_DIR schlaegt den Programmordner")
    pruefe(A.reise_pfad(A.ORDNER, "X").startswith(tmp), "Reisedateien landen im Datenordner")
    kopiert = A.erstbefuellung(A.ORDNER)
    pruefe(os.path.exists(os.path.join(tmp, "reisen", "CO07261003.json")),
           "Vorgabe-Reise wurde in den leeren Datenordner kopiert")
    pruefe(os.path.exists(os.path.join(tmp, "daten", "CO07261003", "preise.csv")),
           "Vorgabe-Messreihe wurde mitkopiert")
    with open(os.path.join(tmp, "reisen", "CO07261003.json"), "w", encoding="utf-8") as f:
        f.write('{"code":"CO07261003","angefasst":true}')
    A.erstbefuellung(A.ORDNER)
    with open(os.path.join(tmp, "reisen", "CO07261003.json"), encoding="utf-8") as f:
        pruefe(json.load(f).get("angefasst") is True,
               "zweiter Start ueberschreibt vorhandene Daten NICHT")
    reisen = A.lade_reisen(A.ORDNER)
    pruefe(len(reisen) >= 1, "Reise wird aus dem Datenordner gelesen")
finally:
    if alt is None:
        os.environ.pop("AIDA_DATA_DIR", None)
    else:
        os.environ["AIDA_DATA_DIR"] = alt
    shutil.rmtree(tmp, ignore_errors=True)




# --------------------------------------------------------------------------
# Vergleichstermine
# --------------------------------------------------------------------------
print("Vergleichstermine")
paare = A.geschwister_codes("CO07261003", 2, 2)
pruefe([c for c, _ in paare] == ["CO07260919", "CO07260926", "CO07261010", "CO07261017"],
       "Nachbarcodes werden wochenweise abgeleitet")
pruefe(A.geschwister_codes("QUATSCH") == [], "unbrauchbarer Code ergibt keine Nachbarn")
pruefe(len(A.geschwister_codes("CO07261003", 4, 4)) == 8, "vier Wochen vor und nach = 8 Termine")

vgl = {"tarif": "LIGHT", "kategorie": "Verandakabine Komfort", "termine": [
    {"code": "A", "erreichbar": True, "wunsch_tarif": None, "wunsch_classic": 3458},
    {"code": "B", "erreichbar": True, "wunsch_tarif": None, "wunsch_classic": 2598},
    {"code": "C", "erreichbar": True, "wunsch_tarif": 1798, "wunsch_classic": 2038},
    {"code": "D", "erreichbar": False, "fehler": "kaputt"},
]}
a = A.werte_vergleich_aus(vgl)
pruefe(a["geprueft"] == 3, "nicht erreichbare Termine zaehlen nicht mit")
pruefe(a["mit_tarif"] == 1, "ein Termin hat den Tarif noch")
pruefe(a["classic_min"] == 2038 and a["classic_max"] == 3458, "CLASSIC-Spanne stimmt")
pruefe(A.werte_vergleich_aus(None) is None, "ohne Daten keine Auswertung")

lage5 = A.bewerte(reise, glob, ruhig_p, ruhig_k)
ohne_v = A.einschaetzung(reise, glob, ruhig_p, ruhig_k, lage5)
mit_v = A.einschaetzung(reise, glob, ruhig_p, ruhig_k, lage5, vgl)
pruefe(mit_v["kennzahlen"]["punkte"] > ohne_v["kennzahlen"]["punkte"],
       "seltener Tarif bei Nachbarterminen erhoeht die Dringlichkeit")
pruefe(mit_v["vertrauen"] != "niedrig" or a["geprueft"] < 6,
       "breiter Vergleich hebt das Vertrauen")

print()
if fehler:
    print("%d Pruefung(en) fehlgeschlagen:" % len(fehler))
    for f in fehler:
        print("  - %s" % f)
    sys.exit(1)
print("Alle Pruefungen bestanden.")
