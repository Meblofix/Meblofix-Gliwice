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
    ordered = [next(item for item in data["realizacje"] if item["id"] == item_id) for item_id in data["kolejnosc"]]
    require(len(ids) == len(data["realizacje"]), "ID realizacji nie są unikalne")

    pages_dir = args.dist / "realizacje"
    generated = {path.parent.name for path in pages_dir.glob("*/index.html")}
    require(generated == ids, f"Strony realizacji nie odpowiadają danym: {generated ^ ids}")

    for item in data["realizacje"]:
        page = pages_dir / item["id"] / "index.html"
        source = page.read_text(encoding="utf-8")
        canonical = f'https://meblofix-gliwice.pl/realizacje/{item["id"]}/'
        title_match = re.search(r"<title>(.*?)</title>", source)
        require(title_match is not None, f"{item['id']}: brak title")
        title = html.unescape(title_match.group(1))
        description_match = re.search(r'<meta name="description" content="([^"]*)">', source)
        require(description_match is not None, f"{item['id']}: brak meta description")
        description = html.unescape(description_match.group(1))
        require(
            f'{item["miasto"]} w {item["miasto"]}' not in description,
            f"{item['id']}: meta description mechanicznie powiela miasto",
        )
        if item.get("title_seo"):
            require(title == item["title_seo"], f"{item['id']}: generator zmienił ręczne title_seo")
        require(len(title) <= 60, f"{item['id']}: title ma {len(title)} znaków")
        require(item["miasto"] in title, f"{item['id']}: title nie zawiera miasta")
        require(title.count(item["miasto"]) == 1, f"{item['id']}: title powiela miasto")
        service_prefix = " ".join(item["tytul"].split()[:2])
        require(service_prefix in title, f"{item['id']}: title nie zachowuje rodzaju usługi")
        require(f'<link rel="canonical" href="{canonical}">' in source, f"{item['id']}: błędny canonical")
        require(f'<h1>{html.escape(item["tytul"])}</h1>' in source, f"{item['id']}: brak H1 ze źródła")
        require(html.escape(item["opis"]) in source, f"{item['id']}: brak pełnego opisu")
        require("Wyceń podobny montaż" in source, f"{item['id']}: brak CTA")
        require('"@type": "BreadcrumbList"' in source, f"{item['id']}: brak BreadcrumbList")
        require('<dialog class="case-lightbox"' in source, f"{item['id']}: brak dostępnego lightboxa")
        require('src="../../js/realizacje.js"' in source, f"{item['id']}: brak wspólnego skryptu galerii")
        schemas = [json.loads(payload) for payload in re.findall(
            r'<script type="application/ld\+json">\s*(.*?)\s*</script>', source, flags=re.DOTALL
        )]
        breadcrumb = next(schema for schema in schemas if schema.get("@type") == "BreadcrumbList")
        require(item["tytul"].count(item["miasto"]) <= 1, f"{item['id']}: H1 powiela miasto")
        require(
            breadcrumb["itemListElement"][-1]["name"].count(item["miasto"]) <= 1,
            f"{item['id']}: breadcrumb powiela miasto",
        )
        image_objects = [
            node
            for schema in schemas
            for node in schema.get("@graph", [])
            if node.get("@type") == "ImageObject"
        ]
        require(len(image_objects) == len(item["zdjecia"]), f"{item['id']}: błędna liczba ImageObject")
        for image_object in image_objects:
            require(image_object.get("contentUrl", "").startswith("https://meblofix-gliwice.pl/img/realizacje/"), f"{item['id']}: błędny contentUrl")
            require(image_object.get("license") == "https://meblofix-gliwice.pl/licencja-zdjec/", f"{item['id']}: błędna licencja")
            require(image_object.get("acquireLicensePage") == "https://meblofix-gliwice.pl/licencja-zdjec/", f"{item['id']}: błędna strona pozyskania licencji")
        for photo in item["zdjecia"]:
            require(photo["alt"].count(item["miasto"]) <= 1, f"{item['id']}: alt {photo['plik']} powiela miasto")
            require(html.escape(photo["alt"], quote=True) in source, f"{item['id']}: brak alt {photo['plik']}")
            require(f'{photo["plik"]}-1200.jpg' in source, f"{item['id']}: brak pełnego zdjęcia {photo['plik']}")
        for comparison in item.get("porownania", []):
            require(html.escape(comparison["nazwa"]) in source, f"{item['id']}: brak porównania {comparison['nazwa']}")
            require('data-before-after' in source, f"{item['id']}: brak suwaka przed/po")
            require('type="range"' in source, f"{item['id']}: porównanie nie ma sterowania suwakiem")
        if item.get("przed_po"):
            require("Porównanie realizacji" in source, f"{item['id']}: brak porównania przed/po")
        others = [candidate for candidate in ordered if candidate["id"] != item["id"]]
        expected_related = [candidate for candidate in others if candidate["kategoria"] == item["kategoria"]]
        expected_related += [candidate for candidate in others if candidate["kategoria"] != item["kategoria"]]
        expected_ids = [candidate["id"] for candidate in expected_related[:3]]
        related_ids = re.findall(r'class="related-case" href="\.\./([^/]+)/"', source)
        require(related_ids == expected_ids, f"{item['id']}: błędna kolejność podobnych realizacji {related_ids}")
        for related in expected_related[:3]:
            require(html.escape(related["tytul"]) in source, f"{item['id']}: brak tytułu podobnej realizacji")
            require(html.escape(related["miasto"]) in source, f"{item['id']}: brak miasta podobnej realizacji")
            require(f'{related["okladka"]}-800.jpg' in source, f"{item['id']}: brak miniatury podobnej realizacji")

    redirects = (args.dist / "_redirects").read_text(encoding="utf-8")
    require("/realizacje/*" not in redirects, "Wildcard nadal przechwytuje strony realizacji")
    homepage = (args.dist / "index.html").read_text(encoding="utf-8")
    require('"@type": "ImageObject"' not in homepage, "Homepage ponownie zawiera ImageObject")
    linked = set(re.findall(r'href="realizacje/([^/]+)/"', homepage))
    require(linked == ids, "Homepage nie linkuje do wszystkich trwałych stron realizacji")
    print(f"OK: {len(ids)} trwałych stron realizacji, galerie, porównania, CTA i breadcrumb")


if __name__ == "__main__":
    main()
