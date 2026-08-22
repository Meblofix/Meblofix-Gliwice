#!/usr/bin/env python3
"""Sprawdza wygenerowane, trwałe strony realizacji."""

from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "realizacje.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(DATA.read_text(encoding="utf-8"))
    ids = {item["id"] for item in data["realizacje"]}
    require(len(ids) == len(data["realizacje"]), "ID realizacji nie są unikalne")

    pages_dir = args.dist / "realizacje"
    generated = {path.parent.name for path in pages_dir.glob("*/index.html")}
    require(generated == ids, f"Strony realizacji nie odpowiadają danym: {generated ^ ids}")

    for item in data["realizacje"]:
        page = pages_dir / item["id"] / "index.html"
        source = page.read_text(encoding="utf-8")
        canonical = f'https://meblofix-gliwice.pl/realizacje/{item["id"]}/'
        require(f'<link rel="canonical" href="{canonical}">' in source, f"{item['id']}: błędny canonical")
        require(f'<h1>{html.escape(item["tytul"])}</h1>' in source, f"{item['id']}: brak H1 ze źródła")
        require(html.escape(item["opis"]) in source, f"{item['id']}: brak pełnego opisu")
        require("Wyceń podobny montaż" in source, f"{item['id']}: brak CTA")
        require('"@type": "BreadcrumbList"' in source, f"{item['id']}: brak BreadcrumbList")
        for photo in item["zdjecia"]:
            require(html.escape(photo["alt"], quote=True) in source, f"{item['id']}: brak alt {photo['plik']}")
            require(f'{photo["plik"]}-1200.jpg' in source, f"{item['id']}: brak pełnego zdjęcia {photo['plik']}")
        for comparison in item.get("porownania", []):
            require(html.escape(comparison["nazwa"]) in source, f"{item['id']}: brak porównania {comparison['nazwa']}")
        if item.get("przed_po"):
            require("Porównanie realizacji" in source, f"{item['id']}: brak porównania przed/po")

    redirects = (args.dist / "_redirects").read_text(encoding="utf-8")
    require("/realizacje/*" not in redirects, "Wildcard nadal przechwytuje strony realizacji")
    homepage = (args.dist / "index.html").read_text(encoding="utf-8")
    linked = set(re.findall(r'href="realizacje/([^/]+)/"', homepage))
    require(linked == ids, "Homepage nie linkuje do wszystkich trwałych stron realizacji")
    print(f"OK: {len(ids)} trwałych stron realizacji, galerie, porównania, CTA i breadcrumb")


if __name__ == "__main__":
    main()
