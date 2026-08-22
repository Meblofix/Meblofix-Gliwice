#!/usr/bin/env python3
"""Regresyjna kontrola źródła realizacji i lekkiej sekcji homepage."""

from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "realizacje.json"
SIZES = (400, 800, 1200, 1600)
EXTENSIONS = ("jpg", "webp")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def category_dir(item: dict) -> str:
    return "na-wymiar" if item["kategoria"] == "na-wymiar" else "sieciowe"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--html", type=Path, required=True)
    args = parser.parse_args()

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = data.get("realizacje", [])
    require(len(items) == 6, f"Oczekiwano 6 realizacji, jest {len(items)}")
    require(sum(len(item.get("zdjecia", [])) for item in items) == 36, "Oczekiwano 36 zdjęć logicznych")
    ids = [item.get("id") for item in items]
    require(all(ids) and len(ids) == len(set(ids)), "ID realizacji są puste lub nieunikalne")
    require(set(data.get("kolejnosc", [])) == set(ids), "Pole kolejności nie odpowiada realizacjom")

    titles = []
    descriptions = []
    alts = []
    file_bases = []
    for item in items:
        require(item.get("tytul") and item.get("opis") and item.get("miasto"), f"Niepełna realizacja: {item.get('id')}")
        titles.append(item["tytul"].casefold())
        descriptions.append(item["opis"].casefold())
        photos = item.get("zdjecia", [])
        item_file_bases = {photo.get("plik") for photo in photos}
        require(item.get("okladka") in item_file_bases, f"Błędna okładka: {item['id']}")
        for photo in photos:
            require(photo.get("plik") and photo.get("alt"), f"Niepełne zdjęcie: {item['id']}")
            alts.append(photo["alt"].casefold())
            file_bases.append(photo["plik"])
            for size in SIZES:
                for extension in EXTENSIONS:
                    source = ROOT / "img" / "realizacje" / category_dir(item) / f'{photo["plik"]}-{size}.{extension}'
                    require(source.is_file(), f"Brak wariantu obrazu: {source.relative_to(ROOT)}")
        for comparison in item.get("porownania", []):
            require(
                comparison.get("przed") in item_file_bases and comparison.get("po") in item_file_bases,
                f"Błędne porównanie: {item['id']}",
            )

    require(len(titles) == len(set(titles)), "Tytuły realizacji nie są unikalne")
    require(len(descriptions) == len(set(descriptions)), "Opisy realizacji nie są unikalne")
    require(len(alts) == len(set(alts)), "Teksty alt nie są unikalne")
    require(len(file_bases) == len(set(file_bases)), "Nazwy zdjęć nie są unikalne")

    html_path = args.html.resolve()
    document = html_path.read_text(encoding="utf-8")
    card_ids = re.findall(r'<li class="work-card[^>]*data-realizacja="([^"]+)"', document)
    require(set(card_ids) == set(ids) and len(card_ids) == len(ids), "Homepage nie ma dokładnie sześciu kart")
    require('class="work-details"' not in document, "Homepage nadal zawiera rozwijane pełne opisy")
    require('class="work-gallery"' not in document, "Homepage nadal zawiera pełne galerie")
    require('id="works-data"' not in document, "Homepage nadal zawiera ciężki payload galerii")
    require('"@type": "ImageGallery"' not in document and '"@type": "ImageObject"' not in document, "Homepage nadal zawiera ciężki graf zdjęć")
    require('class="works-filters"' in document, "Homepage stracił filtry realizacji")

    for item in items:
        require(f'href="realizacje/{item["id"]}/"' in document, f"Brak trwałego linku: {item['id']}")
        require(html.escape(item["tytul"]) in document, f"Brak tytułu karty: {item['id']}")
        cover = next(photo for photo in item["zdjecia"] if photo["plik"] == item["okladka"])
        require(html.escape(cover["alt"], quote=True) in document, f"Brak alt okładki: {item['id']}")
        require(item["opis"] not in document, f"Pełny opis nadal jest na homepage: {item['id']}")

    if html_path.parent.name == "dist":
        require(not (html_path.parent / "data" / "realizacje.json").exists(), "Źródło danych trafiło do dist")
        require(not (html_path.parent / "data" / "cennik.json").exists(), "Config cennika trafił do dist")

    print("OK: źródło — 6 realizacji, 36 zdjęć i komplet wariantów")
    print("OK: homepage — 6 lekkich kart bez pełnych opisów, galerii i payloadu zdjęć")


if __name__ == "__main__":
    main()
