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


# --------------------------------------------------------------------------
# Aktionen an den Preiskacheln
# --------------------------------------------------------------------------
print("Aktionen lesen")
AKT_SEITE = SEITE.replace(
    "<div>AIDA PREMIUM ALL IN </div>",
    "<div>AIDA PREMIUM ALL IN </div><div>AIDA Herbst Deals</div>").replace(
    "<div>Verandakabine Komfort</div>\n  <div>AIDA LIGHT </div>",
    "<div>Verandakabine Komfort</div>\n  <div>AIDA LIGHT </div><div>AIDA Herbst Deals</div>")
_, akt_zeilen = A.parse_preise(AKT_SEITE, glob["kategorien"], glob["tarife"])
akt = A.parse_aktionen(akt_zeilen, glob["kategorien"], glob["tarife"])
pruefe(akt.get("Innenkabine", {}).get("PREMIUM ALL IN", {}).get("aktion") == "AIDA Herbst Deals",
       "Aktionsname haengt an der Preiskachel")
pruefe(akt.get("Innenkabine", {}).get("PREMIUM ALL IN", {}).get("senkung") == -100,
       "Preissenkung wird als Betrag gelesen")
pruefe("aktion" not in akt.get("Innenkabine", {}).get("LIGHT", {}),
       "Kachel ohne Aktion bekommt keinen Namen angedichtet")
pruefe(akt.get("Verandakabine Komfort", {}).get("LIGHT", {}).get("aktion") == "AIDA Herbst Deals",
       "Aktion der Wunschkonstellation wird erkannt")
pruefe("Getränkepaket AIDA Comfort Deluxe"
       not in [w.get("aktion") for k in akt.values() for w in k.values()],
       "Ausstattungszeilen sind keine Aktionen")

print("Aktionszeitraum lesen")
pruefe(A._datum_lang("07", "September", "2026") == "2026-09-07", "Datum in Worten wird umgesetzt")
pruefe(A._datum_lang("07", "Nonember", "2026") is None, "unbekannter Monat gibt None")
pruefe(A._slug("AIDA Herbst Deals") == "aida-herbst-deals", "Aktionsname wird zum Suchbegriff")

# --------------------------------------------------------------------------
# Preisaenderungs-Archiv
# --------------------------------------------------------------------------
print("Preisaenderungen lesen")
AEN_HTML = """
<table><thead><tr><th>Zeitpunkt</th><th>&Auml;nderung [&euro;]</th><th>&Auml;nderung [%]</th></tr></thead>
<tbody>
<tr><td><div>17.08.2026</div></td><td><span>+80 &euro;</span></td><td><span>5,64 %</span></td></tr>
<tr><td><div>08.07.2026</div></td><td><span>-100 &euro;</span></td><td><span>-3,76 %</span></td></tr>
<tr><td><div>12.05.2026</div></td><td><span>+300 &euro;</span></td><td><span>9,01 %</span></td></tr>
</tbody></table>
"""
saetze = A.parse_aenderungen(AEN_HTML)
pruefe(len(saetze) == 3, "drei Aenderungen gelesen")
pruefe(saetze[0] == {"datum": "2026-08-17", "eur": 80, "prozent": 5.64},
       "Datum, Betrag und Prozent stimmen")
pruefe(saetze[1]["eur"] == -100 and saetze[1]["prozent"] == -3.76, "Minus bleibt Minus")
pruefe(saetze[2]["prozent"] == 9.01, "euresa schreibt Zuwaechse ohne Vorzeichen")
pruefe(A.parse_aenderungen("<div>nichts</div>") == [], "ohne Tabelle keine Aenderungen")

print("Preisaenderungen auswerten")
roh_aen = [{"kategorie": "Verandakabine Komfort", "tarif": "LIGHT", "flug": "0",
            "datum": d, "eur": e, "prozent": p}
           for d, e, p in [("2026-06-01", 100, 4.5), ("2026-07-01", -50, -2.1),
                           ("2026-08-01", 100, 4.4)]]
gewaehlt = A.waehle_aenderungen(roh_aen, "Verandakabine Komfort", "LIGHT")
pruefe(len(gewaehlt) == 3, "die eigene Konstellation wird herausgefiltert")
pruefe(A.waehle_aenderungen(roh_aen, "Balkonkabine", "LIGHT") == [],
       "fremde Kategorie liefert nichts")
pruefe(A.waehle_aenderungen(roh_aen, "Verandakabine Komfort", "LIGHT", mit_flug=True) == [],
       "Flugpreise sind eine eigene Reihe")

aus = A.werte_aenderungen_aus(gewaehlt, stichtag="2026-08-20")
pruefe(aus["anzahl"] == 3 and aus["hoch"] == 2 and aus["runter"] == 1, "Richtungen gezaehlt")
pruefe(aus["netto_eur"] == 150, "Nettoveraenderung summiert")
pruefe(aus["beobachtet_tage"] == 61, "Beobachtungsfenster stimmt")
pruefe(aus["abstand_tage"] == 30.5, "mittlerer Abstand zwischen Aenderungen")
pruefe(aus["tage_seit_letzter"] == 19, "Alter der letzten Aenderung")
pruefe(A.werte_aenderungen_aus(gewaehlt, fenster_tage=5, stichtag="2026-08-20") is None,
       "ausserhalb des Fensters bleibt nichts uebrig")
pruefe(A.werte_aenderungen_aus([]) is None, "ohne Archiv keine Auswertung")

print("Prozentrechnung")
pruefe(A.prozent(1498, 1418) == 5.6, "80 Euro auf 1418 sind 5,6 Prozent")
pruefe(A.prozent(1418, 1498) == -5.3, "Rueckgang wird negativ")
pruefe(A.prozent(100, 0) is None and A.prozent(None, 100) is None, "keine Division durch nichts")
pruefe(A.proz_text(5.64, 2) == "+5.64 %" and A.proz_text(None) == "-", "Prozenttext mit Vorzeichen")

# --------------------------------------------------------------------------
# Tarif-Erosion
# --------------------------------------------------------------------------
print("Tarif-Erosion")
kats = ["Innenkabine", "Balkonkabine", "Verandakabine Komfort"]
reihe_p = [
    {"datum": "2026-08-14", "Innenkabine|LIGHT": "1418", "Balkonkabine|LIGHT": "2258",
     "Verandakabine Komfort|LIGHT": "2258"},
    {"datum": "2026-08-17", "Innenkabine|LIGHT": "1498", "Balkonkabine|LIGHT": "",
     "Verandakabine Komfort|LIGHT": "2258"},
    {"datum": "2026-08-20", "Innenkabine|LIGHT": "1498", "Balkonkabine|LIGHT": "",
     "Verandakabine Komfort|LIGHT": "2258"},
]
verl = A.tarif_verlauf(reihe_p, kats, "LIGHT")
pruefe([v["anzahl"] for v in verl] == [3, 2, 2], "Zahl der Kategorien mit Tarif je Tag")
pruefe(verl[1]["verloren"] == ["Balkonkabine"], "der Tag des Wegfalls wird benannt")
pruefe(verl[2]["verloren"] == [], "ein Wegfall wird nicht jeden Tag neu gemeldet")
pruefe(A.tarif_verlauf([], kats, "LIGHT") == [], "ohne Messreihe kein Verlauf")

ero = A.erosion_aus_vergleich([
    {"datum": "2026-08-14", "geprueft": "8", "mit_tarif": "3"},
    {"datum": "2026-08-20", "geprueft": "7", "mit_tarif": "1"},
])
pruefe(ero["tage"] == 6 and ero["von_mit_tarif"] == 3 and ero["auf_mit_tarif"] == 1,
       "Erosion ueber die Nachbartermine")
pruefe(A.erosion_aus_vergleich([{"datum": "2026-08-20", "geprueft": "7", "mit_tarif": "1"}]) is None,
       "ein einzelner Tag ist noch keine Kurve")

print("Vergleich faellig")
pruefe(A.vergleich_faellig({"code": "X"}, {"verhalten": {"vergleich_alle_tage": 0}}, tmp) is True,
       "0 heisst: bei jedem Lauf")
pruefe(A.vergleich_faellig({"code": "X"}, {"verhalten": {"vergleich_alle_tage": -1}}, tmp) is False,
       "-1 schaltet den Vergleich ab")

print("Einschaetzung mit Archiv")
lage6 = A.bewerte(reise, glob, ruhig_p, ruhig_k)
steigend = [{"kategorie": "Verandakabine Komfort", "tarif": "LIGHT", "flug": "0", "datum": d,
             "eur": e, "prozent": p}
            for d, e, p in [("2026-08-01", 100, 4.4), ("2026-08-05", 100, 4.3),
                            ("2026-08-10", 100, 4.2)]]
fallend = [{"kategorie": "Verandakabine Komfort", "tarif": "LIGHT", "flug": "0", "datum": d,
            "eur": e, "prozent": p}
           for d, e, p in [("2026-08-01", -100, -4.4), ("2026-08-05", -100, -4.3),
                           ("2026-08-10", -100, -4.2)]]
ohne_a = A.einschaetzung(reise, glob, ruhig_p, ruhig_k, lage6)
mit_hoch = A.einschaetzung(reise, glob, ruhig_p, ruhig_k, lage6, None, steigend)
mit_runter = A.einschaetzung(reise, glob, ruhig_p, ruhig_k, lage6, None, fallend)
pruefe(mit_hoch["kennzahlen"]["punkte"] > ohne_a["kennzahlen"]["punkte"],
       "lauter Preiserhoehungen im Archiv erhoehen die Dringlichkeit")
pruefe(mit_runter["kennzahlen"]["punkte"] < ohne_a["kennzahlen"]["punkte"],
       "lauter Preissenkungen im Archiv senken sie")
pruefe(mit_hoch["archiv"]["anzahl"] == 3, "das Archiv haengt an der Einschaetzung")
pruefe(any("Prozent" in z or "%" in z for z in mit_hoch["signale"]),
       "die Begruendung nennt Prozentwerte")

print()
if fehler:
    print("%d Pruefung(en) fehlgeschlagen:" % len(fehler))
    for f in fehler:
        print("  - %s" % f)
    sys.exit(1)
print("Alle Pruefungen bestanden.")
