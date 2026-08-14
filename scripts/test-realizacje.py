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
SITE_URL = "https://meblofix-gliwice.pl/"
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
        self.related_links: dict[str, dict[str, str | None]] = {}
        self.gallery_links: list[dict[str, str | None]] = []
        self.gallery_images: list[dict[str, str | None]] = []
        self.comparison_sections: list[str] = []
        self.comparisons: dict[str, list[dict]] = {}
        self.current_comparison: dict | None = None
        self.current_comparison_side: str | None = None
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

        if tag == "a" and "work-related-link" in classes(attrs) and self.current_card:
            self.related_links[self.current_card] = attrs

        if tag == "section" and "work-comparisons" in classes(attrs) and self.current_card:
            self.comparison_sections.append(self.current_card)

        if tag == "figure" and "before-after" in classes(attrs) and self.current_card:
            self.current_comparison = {"attrs": attrs, "images": {}, "control": None}
            self.comparisons.setdefault(self.current_card, []).append(self.current_comparison)

        if tag == "div" and self.current_comparison:
            pane_classes = classes(attrs)
            if "before-after-before" in pane_classes:
                self.current_comparison_side = "przed"
            elif "before-after-after" in pane_classes:
                self.current_comparison_side = "po"

        if tag == "a" and "work-photo-link" in classes(attrs):
            self.current_gallery_link = attrs
            self.gallery_links.append(attrs)

        if tag == "img" and self.current_gallery_link is not None:
            self.gallery_images.append(attrs)

        if tag == "img" and self.current_comparison and self.current_comparison_side:
            self.current_comparison["images"][self.current_comparison_side] = attrs

        if tag == "input" and "before-after-control" in classes(attrs) and self.current_comparison:
            self.current_comparison["control"] = attrs

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
        if tag == "div" and self.current_comparison_side:
            self.current_comparison_side = None
        if tag == "figure":
            self.current_comparison = None
            self.current_comparison_side = None
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


def gallery_id(item: dict) -> str:
    return SITE_URL + "#realizacja-" + item["id"]


def gallery_name(item: dict) -> str:
    title = item["tytul"].rstrip()
    return title if title.endswith(item["miasto"]) else f'{title} — {item["miasto"]}'


def image_id(item: dict, photo: dict) -> str:
    return SITE_URL + "#zdjecie-realizacji-" + photo["plik"]


def normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--html", type=Path, required=True)
    args = parser.parse_args()

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = data.get("realizacje", [])
    require(len(items) == 6, f"Oczekiwano 6 realizacji, jest {len(items)}")
    require(sum(len(item.get("zdjecia", [])) for item in items) == 36, "Oczekiwano 36 zdjęć logicznych")

    ids = [item.get("id") for item in items]
    require(all(ids), "Każda realizacja musi mieć ID")
    require(len(ids) == len(set(ids)), "ID realizacji nie są unikalne")
    require(set(data.get("kolejnosc", [])) == set(ids), "Pole 'kolejnosc' nie odpowiada realizacjom")

    expected_photos: dict[tuple[str, int], dict] = {}
    expected_comparisons: dict[str, list[dict]] = {}
    all_titles: list[str] = []
    all_descriptions: list[str] = []
    all_alts: list[str] = []
    all_file_bases: list[str] = []
    for item in items:
        require(bool(item.get("tytul", "").strip()), f"Brak tytułu: {item.get('id')}")
        require(bool(item.get("opis", "").strip()), f"Brak opisu: {item.get('id')}")
        require(bool(item.get("miasto", "").strip()), f"Brak miasta: {item.get('id')}")
        all_titles.append(normalized(item["tytul"]))
        all_descriptions.append(normalized(item["opis"]))
        photos = item.get("zdjecia", [])
        photos_by_base = {photo.get("plik"): photo for photo in photos}
        require(any(photo.get("plik") == item.get("okladka") for photo in photos), f"Błędna okładka: {item['id']}")
        related_page = item.get("powiazanaStrona")
        if related_page:
            related_url = str(related_page.get("url", ""))
            require(bool(related_url) and not related_url.startswith(("/", "http:", "https:")), f"Nieprawidłowy URL powiązanej strony: {item['id']}")
            require(".." not in Path(related_url).parts, f"URL powiązanej strony wychodzi poza katalog strony: {item['id']}")
            require(bool(related_page.get("etykieta", "").strip()), f"Brak etykiety powiązanej strony: {item['id']}")
            require((ROOT / related_url / "index.html").is_file(), f"Brak powiązanej strony: {related_url}")
        for index, photo in enumerate(photos):
            require(bool(photo.get("alt", "").strip()), f"Brak alt: {item['id']} zdjęcie {index + 1}")
            require(bool(photo.get("plik", "").strip()), f"Brak nazwy pliku: {item['id']} zdjęcie {index + 1}")
            all_alts.append(normalized(photo["alt"]))
            all_file_bases.append(photo["plik"])
            expected_photos[(item["id"], index)] = photo
            for size in SIZES:
                for extension in EXTENSIONS:
                    path = ROOT / image_relative(item, photo["plik"], size, extension)
                    require(path.is_file(), f"Brak obrazu: {path.relative_to(ROOT)}")

        comparisons = item.get("porownania", [])
        expected_comparisons[item["id"]] = comparisons
        seen_comparison_pairs: set[tuple[str, str]] = set()
        for comparison_index, comparison in enumerate(comparisons):
            require(bool(comparison.get("nazwa", "").strip()), f"Brak nazwy porównania: {item['id']} #{comparison_index + 1}")
            before = comparison.get("przed")
            after = comparison.get("po")
            require(before in photos_by_base, f"Zdjęcie przed nie należy do realizacji: {item['id']} #{comparison_index + 1}")
            require(after in photos_by_base, f"Zdjęcie po nie należy do realizacji: {item['id']} #{comparison_index + 1}")
            require(before != after, f"Porównanie używa tego samego zdjęcia przed i po: {item['id']} #{comparison_index + 1}")
            pair = (before, after)
            require(pair not in seen_comparison_pairs, f"Powtórzona para porównawcza: {item['id']} #{comparison_index + 1}")
            seen_comparison_pairs.add(pair)

    require(len(all_titles) == len(set(all_titles)), "Tytuły realizacji nie są unikalne")
    require(len(all_descriptions) == len(set(all_descriptions)), "Opisy realizacji nie są unikalne")
    require(len(all_alts) == len(set(all_alts)), "Teksty alt zdjęć nie są unikalne")
    require(len(all_file_bases) == len(set(all_file_bases)), "Nazwy bazowe zdjęć nie są unikalne")

    html_path = args.html.resolve()
    require(html_path.is_file(), f"Brak HTML: {html_path}")
    for item in items:
        for photo in item["zdjecia"]:
            for size in SIZES:
                for extension in EXTENSIONS:
                    deployed_path = html_path.parent / image_relative(item, photo["plik"], size, extension)
                    require(deployed_path.is_file(), f"Brak obrazu przy sprawdzanym HTML: {deployed_path}")
    document = html_path.read_text(encoding="utf-8")
    html_parser = RealizationsParser()
    html_parser.feed(document)

    duplicates = sorted(item_id for item_id, count in Counter(html_parser.ids).items() if count > 1)
    require(not duplicates, f"Zduplikowane ID w HTML: {', '.join(duplicates)}")
    require(len(html_parser.cards) == 6, f"HTML powinien mieć 6 realizacji, ma {len(html_parser.cards)}")
    require(set(html_parser.cards) == set(ids), "Lista realizacji w HTML nie odpowiada źródłu")
    require(len(html_parser.gallery_links) == 36, f"HTML powinien mieć 36 linków zdjęć, ma {len(html_parser.gallery_links)}")
    require(len(html_parser.gallery_images) == 36, f"HTML powinien mieć 36 obrazów galerii, ma {len(html_parser.gallery_images)}")
    require(all((image.get("alt") or "").strip() for image in html_parser.gallery_images), "Co najmniej jeden obraz galerii nie ma alt")

    by_id = {item["id"]: item for item in items}
    for item_id, item in by_id.items():
        card_text = " ".join(html_parser.card_text.get(item_id, []))
        require(item["tytul"] in card_text, f"Tytuł nie jest widoczny w karcie: {item_id}")
        require(item["opis"] in card_text, f"Opis nie jest dostępny w HTML: {item_id}")
        cover_index = next(index for index, photo in enumerate(item["zdjecia"]) if photo["plik"] == item["okladka"])
        card_link = html_parser.card_links.get(item_id)
        require(card_link is not None, f"Brak funkcjonalnego linku okładki: {item_id}")
        require(card_link.get("data-idx") == str(cover_index), f"Błędny indeks okładki: {item_id}")
        require(f"realizacja-{item_id}" in html_parser.ids, f"Brak stabilnej kotwicy realizacji: {item_id}")
        related_page = item.get("powiazanaStrona")
        related_link = html_parser.related_links.get(item_id)
        if related_page:
            require(related_link is not None, f"Brak powiązanego linku w HTML: {item_id}")
            require(related_link.get("href") == related_page["url"], f"Błędny powiązany link: {item_id}")
            related_target = html_path.parent / related_page["url"] / "index.html"
            require(related_target.is_file(), f"Powiązany link nie istnieje przy sprawdzanym HTML: {item_id}")
        else:
            require(related_link is None, f"Nadmiarowy powiązany link: {item_id}")

        expected_item_comparisons = expected_comparisons[item_id]
        actual_item_comparisons = html_parser.comparisons.get(item_id, [])
        require(len(actual_item_comparisons) == len(expected_item_comparisons), f"Błędna liczba porównań: {item_id}")
        require(html_parser.comparison_sections.count(item_id) == (1 if expected_item_comparisons else 0), f"Błędna sekcja porównań: {item_id}")
        photos_by_base = {photo["plik"]: photo for photo in item["zdjecia"]}
        for comparison_index, (expected, actual) in enumerate(zip(expected_item_comparisons, actual_item_comparisons, strict=True)):
            attrs = actual["attrs"]
            require(attrs.get("data-before") == expected["przed"], f"Błędne data-before: {item_id} #{comparison_index + 1}")
            require(attrs.get("data-after") == expected["po"], f"Błędne data-after: {item_id} #{comparison_index + 1}")
            images = actual["images"]
            require(set(images) == {"przed", "po"}, f"Fallback porównania nie zawiera obu zdjęć: {item_id} #{comparison_index + 1}")
            require(images["przed"].get("alt") == photos_by_base[expected["przed"]]["alt"], f"Błędny alt zdjęcia przed: {item_id} #{comparison_index + 1}")
            require(images["po"].get("alt") == photos_by_base[expected["po"]]["alt"], f"Błędny alt zdjęcia po: {item_id} #{comparison_index + 1}")
            require(images["przed"].get("loading") == "lazy" and images["po"].get("loading") == "lazy", f"Obrazy porównania nie są ładowane leniwie: {item_id} #{comparison_index + 1}")
            control = actual["control"] or {}
            require(control.get("type") == "range", f"Brak suwaka porównania: {item_id} #{comparison_index + 1}")
            require(control.get("min") == "0" and control.get("max") == "100" and control.get("value") == "50", f"Błędny zakres suwaka: {item_id} #{comparison_index + 1}")
            require(bool((control.get("aria-label") or "").strip()), f"Suwak nie ma etykiety dostępności: {item_id} #{comparison_index + 1}")

    seen_links: set[tuple[str, int]] = set()
    for link, image in zip(html_parser.gallery_links, html_parser.gallery_images, strict=True):
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
        photo = expected_photos[key]
        require((image.get("alt") or "") == photo["alt"], f"Alt HTML nie odpowiada źródłu: {key}")
        require(image.get("loading") == "lazy", f"Obraz galerii nie ma loading=lazy: {key}")
    require(seen_links == set(expected_photos), "Nie wszystkie zdjęcia źródłowe mają link w HTML")

    require(html_parser.works_data is not None, "Brak #works-data")
    runtime = json.loads(html_parser.works_data or "{}")
    require(set(runtime) == set(ids), "#works-data nie odpowiada realizacjom źródłowym")
    require(sum(len(item["zdjecia"]) for item in runtime.values()) == 36, "#works-data nie zawiera 36 zdjęć")

    image_objects = []
    image_galleries = []
    for payload in html_parser.json_ld:
        block = json.loads(payload)
        if isinstance(block, dict) and isinstance(block.get("@graph"), list):
            image_objects.extend(node for node in block["@graph"] if node.get("@type") == "ImageObject")
            image_galleries.extend(node for node in block["@graph"] if node.get("@type") == "ImageGallery")
    require(len(image_objects) == 36, f"Oczekiwano 36 ImageObject, jest {len(image_objects)}")
    require(len(image_galleries) == 6, f"Oczekiwano 6 ImageGallery, jest {len(image_galleries)}")

    image_objects_by_id = {node.get("@id"): node for node in image_objects}
    image_galleries_by_id = {node.get("@id"): node for node in image_galleries}
    require(len(image_objects_by_id) == 36 and None not in image_objects_by_id, "ImageObject nie mają unikalnych @id")
    require(len(image_galleries_by_id) == 6 and None not in image_galleries_by_id, "ImageGallery nie mają unikalnych @id")
    all_nodes_by_id = {**image_galleries_by_id, **image_objects_by_id}
    require(len(all_nodes_by_id) == 42, "@id nie są unikalne w całym grafie realizacji")

    for item in items:
        expected_gallery_id = gallery_id(item)
        gallery = image_galleries_by_id.get(expected_gallery_id)
        require(gallery is not None, f"Brak ImageGallery: {item['id']}")
        require(gallery.get("url") == expected_gallery_id, f"Błędny URL ImageGallery: {item['id']}")
        require(gallery.get("name") == gallery_name(item), f"Błędna nazwa ImageGallery: {item['id']}")
        require(gallery.get("description") == item["opis"], f"Błędny opis ImageGallery: {item['id']}")
        require(gallery.get("inLanguage") == "pl", f"Brak języka ImageGallery: {item['id']}")
        require(gallery.get("isPartOf") == SITE_URL, f"ImageGallery nie jest powiązana ze stroną: {item['id']}")
        expected_parts = [{"@id": image_id(item, photo)} for photo in item["zdjecia"]]
        require(gallery.get("hasPart") == expected_parts, f"Błędne hasPart ImageGallery: {item['id']}")
        require("associatedMedia" not in gallery, f"ImageGallery nie może używać associatedMedia do relacji ze zdjęciami: {item['id']}")
        require(
            all(reference.get("@id") in all_nodes_by_id for reference in gallery["hasPart"]),
            f"hasPart wskazuje nieistniejący element: {item['id']}",
        )

        for photo in item["zdjecia"]:
            expected_image_id = image_id(item, photo)
            image_object = image_objects_by_id.get(expected_image_id)
            require(image_object is not None, f"Brak ImageObject: {photo['plik']}")
            expected_content = SITE_URL + image_relative(item, photo["plik"], 800, "jpg").as_posix()
            expected_thumbnail = SITE_URL + image_relative(item, photo["plik"], 400, "jpg").as_posix()
            require(image_object.get("contentUrl") == expected_content, f"Błędny contentUrl: {photo['plik']}")
            require(image_object.get("thumbnailUrl") == expected_thumbnail, f"Błędny thumbnailUrl: {photo['plik']}")
            require(image_object.get("caption") == photo["alt"], f"Błędny caption: {photo['plik']}")
            require(image_object.get("name") == photo["alt"], f"Błędna nazwa ImageObject: {photo['plik']}")
            require(image_object.get("isPartOf") == {"@id": expected_gallery_id}, f"Błędne powiązanie ImageObject: {photo['plik']}")
            require(image_object["isPartOf"]["@id"] in all_nodes_by_id, f"isPartOf wskazuje nieistniejący element: {photo['plik']}")
            require(image_object.get("contentLocation") == {"@type": "Place", "name": item["miasto"]}, f"Błędna lokalizacja ImageObject: {photo['plik']}")
            require(image_object.get("datePublished") == item["data"], f"Błędna data ImageObject: {photo['plik']}")
            require(image_object.get("creator") == {"@type": "Organization", "name": "MebloFix Gliwice"}, f"Błędny twórca ImageObject: {photo['plik']}")
            require(image_object.get("creditText") == "MebloFix Gliwice", f"Brak creditText: {photo['plik']}")
            require(image_object.get("copyrightNotice") == "MebloFix Gliwice", f"Brak copyrightNotice: {photo['plik']}")
            require(image_object.get("license") == SITE_URL + "licencja-zdjec/", f"Błędna licencja: {photo['plik']}")
            require(image_object.get("acquireLicensePage") == SITE_URL + "licencja-zdjec/", f"Błędna strona licencji: {photo['plik']}")
            require(isinstance(image_object.get("width"), int) and image_object["width"] > 0, f"Błędna szerokość: {photo['plik']}")
            require(isinstance(image_object.get("height"), int) and image_object["height"] > 0, f"Błędna wysokość: {photo['plik']}")
            for field in ("contentUrl", "thumbnailUrl"):
                parsed = urlparse(image_object[field])
                require(parsed.scheme == "https" and parsed.netloc == "meblofix-gliwice.pl", f"Błędna domena {field}: {photo['plik']}")
                require((html_path.parent / parsed.path.lstrip("/")).is_file(), f"{field} wskazuje brakujący plik: {photo['plik']}")

    if html_path.parent.name == "dist":
        require(not (html_path.parent / "data" / "realizacje.json").exists(), "Źródłowy realizacje.json trafił do dist")
        require(not (html_path.parent / "data" / "cennik.json").exists(), "Prywatny cennik trafił do dist")

    print("OK: źródło — 6 realizacji, 36 zdjęć")
    print("OK: HTML — 6 realizacji, 36 linków i 36 obrazów galerii")
    print("OK: unikalne ID, kompletne tytuły, opisy i alty")
    print("OK: wszystkie warianty obrazów i odnośniki istnieją")
    print("OK: unikalne tytuły, opisy i 36 tekstów alt są zgodne ze źródłem")
    print("OK: porównania przed/po mają prawidłowe referencje, fallback i suwaki")
    print("OK: #works-data, 6 ImageGallery.hasPart i 36 ImageObject.isPartOf są zgodne ze źródłem")


if __name__ == "__main__":
    main()
