#!/usr/bin/env python3
"""Regresyjna kontrola danych i produkcyjnego HTML sekcji realizacji."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "realizacje.json"
SIZES = (400, 800, 1200, 1600)
EXTENSIONS = ("jpg", "webp")


def classes(attrs: dict[str, str | None]) -> set[str]:
    return set((attrs.get("class") or "").split())


class RealizationsParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.cards: list[str] = []
        self.card_text: dict[str, list[str]] = {}
        self.card_links: dict[str, dict[str, str | None]] = {}
        self.gallery_links: list[dict[str, str | None]] = []
        self.gallery_alts: list[str] = []
        self.current_card: str | None = None
        self.card_li_depth = 0
        self.current_gallery_link: dict[str, str | None] | None = None
        self.script_id: str | None = None
        self.script_type: str | None = None
        self.script_text: list[str] = []
        self.works_data: str | None = None
        self.json_ld: list[str] = []

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = dict(attrs_list)
        if attrs.get("id"):
            self.ids.append(attrs["id"] or "")

        if tag == "li" and "work-card" in classes(attrs):
            item_id = attrs.get("data-realizacja")
            if item_id:
                self.current_card = item_id
                self.card_li_depth = 1
                self.cards.append(item_id)
                self.card_text[item_id] = []
        elif tag == "li" and self.current_card:
            self.card_li_depth += 1

        if tag == "a" and "work-card-btn" in classes(attrs):
            item_id = attrs.get("data-id")
            if item_id:
                self.card_links[item_id] = attrs

        if tag == "a" and "work-photo-link" in classes(attrs):
            self.current_gallery_link = attrs
            self.gallery_links.append(attrs)

        if tag == "img" and self.current_gallery_link is not None:
            self.gallery_alts.append(attrs.get("alt") or "")

        if tag == "script":
            self.script_id = attrs.get("id")
            self.script_type = attrs.get("type")
            self.script_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "li" and self.current_card:
            self.card_li_depth -= 1
            if self.card_li_depth == 0:
                self.current_card = None
        if tag == "a" and self.current_gallery_link is not None:
            self.current_gallery_link = None
        if tag == "script":
            payload = "".join(self.script_text).strip()
            if self.script_id == "works-data":
                self.works_data = payload
            if self.script_type == "application/ld+json":
                self.json_ld.append(payload)
            self.script_id = None
            self.script_type = None
            self.script_text = []

    def handle_data(self, data: str) -> None:
        if self.current_card and data.strip():
            self.card_text[self.current_card].append(data.strip())
        if self.script_id or self.script_type:
            self.script_text.append(data)


def category_dir(item: dict) -> str:
    return "na-wymiar" if item["kategoria"] == "na-wymiar" else "sieciowe"


def image_relative(item: dict, base: str, size: int, extension: str) -> Path:
    return Path("img") / "realizacje" / category_dir(item) / f"{base}-{size}.{extension}"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--html", type=Path, required=True)
    args = parser.parse_args()

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = data.get("realizacje", [])
    require(len(items) == 5, f"Oczekiwano 5 realizacji, jest {len(items)}")
    require(sum(len(item.get("zdjecia", [])) for item in items) == 22, "Oczekiwano 22 zdjęć logicznych")

    ids = [item.get("id") for item in items]
    require(all(ids), "Każda realizacja musi mieć ID")
    require(len(ids) == len(set(ids)), "ID realizacji nie są unikalne")
    require(set(data.get("kolejnosc", [])) == set(ids), "Pole 'kolejnosc' nie odpowiada realizacjom")

    expected_photos: dict[tuple[str, int], dict] = {}
    for item in items:
        require(bool(item.get("tytul", "").strip()), f"Brak tytułu: {item.get('id')}")
        require(bool(item.get("opis", "").strip()), f"Brak opisu: {item.get('id')}")
        photos = item.get("zdjecia", [])
        require(any(photo.get("plik") == item.get("okladka") for photo in photos), f"Błędna okładka: {item['id']}")
        for index, photo in enumerate(photos):
            require(bool(photo.get("alt", "").strip()), f"Brak alt: {item['id']} zdjęcie {index + 1}")
            expected_photos[(item["id"], index)] = photo
            for size in SIZES:
                for extension in EXTENSIONS:
                    path = ROOT / image_relative(item, photo["plik"], size, extension)
                    require(path.is_file(), f"Brak obrazu: {path.relative_to(ROOT)}")

    html_path = args.html.resolve()
    require(html_path.is_file(), f"Brak HTML: {html_path}")
    document = html_path.read_text(encoding="utf-8")
    html_parser = RealizationsParser()
    html_parser.feed(document)

    duplicates = sorted(item_id for item_id, count in Counter(html_parser.ids).items() if count > 1)
    require(not duplicates, f"Zduplikowane ID w HTML: {', '.join(duplicates)}")
    require(len(html_parser.cards) == 5, f"HTML powinien mieć 5 realizacji, ma {len(html_parser.cards)}")
    require(set(html_parser.cards) == set(ids), "Lista realizacji w HTML nie odpowiada źródłu")
    require(len(html_parser.gallery_links) == 22, f"HTML powinien mieć 22 linki zdjęć, ma {len(html_parser.gallery_links)}")
    require(len(html_parser.gallery_alts) == 22, f"HTML powinien mieć 22 obrazy galerii, ma {len(html_parser.gallery_alts)}")
    require(all(alt.strip() for alt in html_parser.gallery_alts), "Co najmniej jeden obraz galerii nie ma alt")

    by_id = {item["id"]: item for item in items}
    for item_id, item in by_id.items():
        card_text = " ".join(html_parser.card_text.get(item_id, []))
        require(item["tytul"] in card_text, f"Tytuł nie jest widoczny w karcie: {item_id}")
        require(item["opis"] in card_text, f"Opis nie jest dostępny w HTML: {item_id}")
        cover_index = next(index for index, photo in enumerate(item["zdjecia"]) if photo["plik"] == item["okladka"])
        card_link = html_parser.card_links.get(item_id)
        require(card_link is not None, f"Brak funkcjonalnego linku okładki: {item_id}")
        require(card_link.get("data-idx") == str(cover_index), f"Błędny indeks okładki: {item_id}")

    seen_links: set[tuple[str, int]] = set()
    for link in html_parser.gallery_links:
        item_id = link.get("data-id") or ""
        try:
            index = int(link.get("data-idx") or "-1")
        except ValueError as error:
            raise AssertionError(f"Błędny indeks zdjęcia: {link.get('data-idx')}") from error
        key = (item_id, index)
        require(key in expected_photos, f"Nieznane zdjęcie w HTML: {key}")
        require(key not in seen_links, f"Powtórzony link zdjęcia: {key}")
        seen_links.add(key)
        href = urlparse(link.get("href") or "").path
        require(bool(href), f"Brak href zdjęcia: {key}")
        require((html_path.parent / href).is_file(), f"Link wskazuje brakujący plik: {href}")
    require(seen_links == set(expected_photos), "Nie wszystkie zdjęcia źródłowe mają link w HTML")

    require(html_parser.works_data is not None, "Brak #works-data")
    runtime = json.loads(html_parser.works_data or "{}")
    require(set(runtime) == set(ids), "#works-data nie odpowiada realizacjom źródłowym")
    require(sum(len(item["zdjecia"]) for item in runtime.values()) == 22, "#works-data nie zawiera 22 zdjęć")

    image_objects = []
    for payload in html_parser.json_ld:
        block = json.loads(payload)
        if isinstance(block, dict) and isinstance(block.get("@graph"), list):
            image_objects.extend(node for node in block["@graph"] if node.get("@type") == "ImageObject")
    require(len(image_objects) == 22, f"Oczekiwano 22 ImageObject, jest {len(image_objects)}")

    if html_path.parent.name == "dist":
        require(not (html_path.parent / "data" / "realizacje.json").exists(), "Źródłowy realizacje.json trafił do dist")
        require(not (html_path.parent / "data" / "cennik.json").exists(), "Prywatny cennik trafił do dist")

    print("OK: źródło — 5 realizacji, 22 zdjęcia")
    print("OK: HTML — 5 realizacji, 22 linki i 22 obrazy galerii")
    print("OK: unikalne ID, kompletne tytuły, opisy i alty")
    print("OK: wszystkie warianty obrazów i odnośniki istnieją")
    print("OK: #works-data i 22 ImageObject są zgodne liczbowo")


if __name__ == "__main__":
    main()
