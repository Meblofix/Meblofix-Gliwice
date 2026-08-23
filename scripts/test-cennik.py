#!/usr/bin/env python3
"""Testuje jedno źródło publicznych cen dla HTML i kalkulatora."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
CONFIG_PATH = ROOT / "data" / "cennik.json"
RENDER_PATH = ROOT / "scripts" / "render-public-config.py"
sys.dont_write_bytecode = True


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


spec = importlib.util.spec_from_file_location("render_public_config", RENDER_PATH)
require(spec is not None and spec.loader is not None, "Nie można załadować generatora cennika")
render_public_config = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = render_public_config
spec.loader.exec_module(render_public_config)

config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
altered = copy.deepcopy(config)
altered["publicRates"].update({
    "minimumJob": 917,
    "hourlyOneInstaller": 431,
    "hourlyTwoInstallers": 782,
    "estimate": 3,
})
altered["publicRates"]["travel"]["outsideGliwicePerKilometer"] = 2.75
altered["serviceArea"]["maximumDistanceOneWayKilometers"] = 27
next(city for city in altered["serviceArea"]["cities"] if city["name"] == "Zabrze")["distanceOneWayKilometers"] = 13

price_pages = [
    "index.html",
    "montaz-mebli-gliwice/index.html",
    "montaz-mebli-zabrze/index.html",
    "montaz-mebli-ikea-gliwice/index.html",
    "montaz-mebli-agata-gliwice/index.html",
    "montaz-mebli-brw-gliwice/index.html",
    "montaz-mebli-jysk-gliwice/index.html",
    "cennik-montazu-mebli/index.html",
]
for relative in price_pages:
    source = (ROOT / relative).read_text(encoding="utf-8")
    rendered = render_public_config.render_document(source, altered)
    for expected in ("917 zł", "431 zł/h", "782 zł/h", "3 zł"):
        require(expected in rendered, f"{relative}: zmiana configu nie trafiła do publikacji ({expected})")

travel_sources = sorted(
    path for path in ROOT.rglob("*.html")
    if "dist" not in path.parts and "assets" not in path.parts and "[[TRAVEL_RULE" in path.read_text(encoding="utf-8")
)
require(travel_sources, "Brak stron korzystających ze wspólnej reguły dojazdu")
for source_path in travel_sources:
    rendered = render_public_config.render_document(source_path.read_text(encoding="utf-8"), altered)
    require("2,75 zł" in rendered, f"{source_path.relative_to(ROOT)}: reguła dojazdu nie pochodzi z configu")

calculator_rendered = render_public_config.render_document(
    (ROOT / "index.html").read_text(encoding="utf-8"), altered
)
require('max="27"' in calculator_rendered, "Maksymalna odległość kalkulatora nie pochodzi z configu")
require(
    '<option value="Zabrze" data-distance="13"></option>' in calculator_rendered,
    "Podpowiedź odległości miasta nie pochodzi z configu",
)
require(
    "Dojazd poza Gliwicami kosztuje 2,75 zł za kilometr liczony w obie strony." in calculator_rendered,
    "Pomoc pola odległości nie pokazuje reguły ze wspólnego configu",
)

backend = (ROOT / "functions" / "api" / "quote-products.js").read_text(encoding="utf-8")
require("../../data/cennik.json" in backend, "Kalkulator nie importuje wspólnego configu")
require("minimumJob: 150" not in backend and "travelPerKm: 1.5" not in backend, "Kalkulator nadal hardcoduje reguły")
require("maximumDistanceOneWayKilometers" in backend and "distanceInput > 500" not in backend, "Limit odległości backendu nie pochodzi z configu")

for html_path in DIST.rglob("*.html"):
    require("[[" not in html_path.read_text(encoding="utf-8"), f"Niewypełniony marker w {html_path.relative_to(DIST)}")

cennik_source = (ROOT / "cennik-montazu-mebli" / "index.html").read_text(encoding="utf-8")
cennik_rendered = render_public_config.render_document(cennik_source, altered)
for expected in ("917 zł", "1564 zł", "55 zł"):
    require(expected in cennik_rendered, f"Przykład cennika nie wynika matematycznie z configu: {expected}")

print(f"OK: wspólny config zasila {len(price_pages)} stron, {len(travel_sources)} reguł dojazdu i kalkulator")
