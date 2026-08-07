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

        if tag == "a" and "work-photo-link" in classes(attrs):
            self.current_gallery_link = attrs
            self.gallery_links.append(attrs)

        if tag == "img" and self.current_gallery_link is not None:
            self.gallery_images.append(attrs)

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


def gallery_id(item: dict) -> str:
    return SITE_URL + "#realizacja-" + item["id"]


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
    require(len(items) == 5, f"Oczekiwano 5 realizacji, jest {len(items)}")
    require(sum(len(item.get("zdjecia", [])) for item in items) == 22, "Oczekiwano 22 zdjęć logicznych")

    ids = [item.get("id") for item in items]
    require(all(ids), "Każda realizacja musi mieć ID")
    require(len(ids) == len(set(ids)), "ID realizacji nie są unikalne")
    require(set(data.get("kolejnosc", [])) == set(ids), "Pole 'kolejnosc' nie odpowiada realizacjom")

    expected_photos: dict[tuple[str, int], dict] = {}
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
    require(len(html_parser.cards) == 5, f"HTML powinien mieć 5 realizacji, ma {len(html_parser.cards)}")
    require(set(html_parser.cards) == set(ids), "Lista realizacji w HTML nie odpowiada źródłu")
    require(len(html_parser.gallery_links) == 22, f"HTML powinien mieć 22 linki zdjęć, ma {len(html_parser.gallery_links)}")
    require(len(html_parser.gallery_images) == 22, f"HTML powinien mieć 22 obrazy galerii, ma {len(html_parser.gallery_images)}")
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
    require(sum(len(item["zdjecia"]) for item in runtime.values()) == 22, "#works-data nie zawiera 22 zdjęć")

    image_objects = []
    image_galleries = []
    for payload in html_parser.json_ld:
        block = json.loads(payload)
        if isinstance(block, dict) and isinstance(block.get("@graph"), list):
            image_objects.extend(node for node in block["@graph"] if node.get("@type") == "ImageObject")
            image_galleries.extend(node for node in block["@graph"] if node.get("@type") == "ImageGallery")
    require(len(image_objects) == 22, f"Oczekiwano 22 ImageObject, jest {len(image_objects)}")
    require(len(image_galleries) == 5, f"Oczekiwano 5 ImageGallery, jest {len(image_galleries)}")

    image_objects_by_id = {node.get("@id"): node for node in image_objects}
    image_galleries_by_id = {node.get("@id"): node for node in image_galleries}
    require(len(image_objects_by_id) == 22 and None not in image_objects_by_id, "ImageObject nie mają unikalnych @id")
    require(len(image_galleries_by_id) == 5 and None not in image_galleries_by_id, "ImageGallery nie mają unikalnych @id")
    all_nodes_by_id = {**image_galleries_by_id, **image_objects_by_id}
    require(len(all_nodes_by_id) == 27, "@id nie są unikalne w całym grafie realizacji")

    for item in items:
        expected_gallery_id = gallery_id(item)
        gallery = image_galleries_by_id.get(expected_gallery_id)
        require(gallery is not None, f"Brak ImageGallery: {item['id']}")
        require(gallery.get("url") == expected_gallery_id, f"Błędny URL ImageGallery: {item['id']}")
        require(gallery.get("name") == f'{item["tytul"]} — {item["miasto"]}', f"Błędna nazwa ImageGallery: {item['id']}")
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

    print("OK: źródło — 5 realizacji, 22 zdjęcia")
    print("OK: HTML — 5 realizacji, 22 linki i 22 obrazy galerii")
    print("OK: unikalne ID, kompletne tytuły, opisy i alty")
    print("OK: wszystkie warianty obrazów i odnośniki istnieją")
    print("OK: unikalne tytuły, opisy i 22 teksty alt są zgodne ze źródłem")
    print("OK: #works-data, 5 ImageGallery.hasPart i 22 ImageObject.isPartOf są zgodne ze źródłem")


if __name__ == "__main__":
    main()
