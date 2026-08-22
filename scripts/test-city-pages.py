#!/usr/bin/env python3
"""Regresje konsolidacji stron miejskich i dowodu lokalnego Zabrza."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


OLD_CITY_PATHS = (
    "montaz-mebli-bytom",
    "montaz-mebli-katowice",
    "montaz-mebli-rybnik",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    args = parser.parse_args()

    zabrze = (args.dist / "montaz-mebli-zabrze" / "index.html").read_text(encoding="utf-8")
    require("około trzech godzin" in zabrze.casefold(), "Zabrze: brak czasu ze źródła")
    require("rozpakowaniem i uprzątnięciem kartonów" in zabrze, "Zabrze: niepełny opis realizacji")
    require(zabrze.count("lozko-dla-dziecka-") >= 2, "Zabrze: brak zdjęcia łóżka")
    require(zabrze.count("szafka-ikea-otwarta-") >= 2, "Zabrze: brak zdjęcia szafki")
    require('href="../realizacje/pokoj-dzieciecy-zabrze/"' in zabrze, "Zabrze: brak linku do case study")
    require(len(re.findall(r"<details>", zabrze)) <= 4, "Zabrze: FAQ przekracza cztery pytania")

    area = (args.dist / "obszar-dzialania" / "index.html").read_text(encoding="utf-8")
    for city in ("Gliwice", "Zabrze", "Bytom", "Katowice", "Rybnik"):
        require(city in area, f"Obszar działania: brak miasta {city}")
    require("1,50 zł" in area and "w obie strony" in area, "Obszar działania: brak reguły dojazdu z configu")

    sitemap = (args.dist / "sitemap.xml").read_text(encoding="utf-8")
    redirects = (args.dist / "_redirects").read_text(encoding="utf-8")
    require("/obszar-dzialania/" in sitemap, "Brak obszaru działania w sitemapie")
    for old_path in OLD_CITY_PATHS:
        require(f"/{old_path}/" not in sitemap, f"Stary URL pozostał w sitemapie: {old_path}")
        require(not (args.dist / old_path / "index.html").exists(), f"Stara strona nadal jest publikowana: {old_path}")
        require(f"/{old_path}/ /obszar-dzialania/ 301" in redirects, f"Brak 301: {old_path}")

    for page in args.dist.rglob("*.html"):
        source = page.read_text(encoding="utf-8")
        for old_path in OLD_CITY_PATHS:
            require(
                f'href="../{old_path}/"' not in source and f'href="{old_path}/"' not in source,
                f"Link wewnętrzny prowadzi przez 301: {page}",
            )

    print("OK: Zabrze ma realny dowód; Bytom, Katowice i Rybnik kierują 301 do obszaru działania")


if __name__ == "__main__":
    main()
