#!/usr/bin/env python3
"""Generuje sekcję realizacji w HTML z jednego źródła: data/realizacje.json."""

from __future__ import annotations

import argparse
import html
import json
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "realizacje.json"
SITE_URL = "https://meblofix-gliwice.pl/"
SIZES = (400, 800, 1200, 1600)

MARKERS = {
    "image_objects": ("<!-- REALIZACJE_IMAGEOBJECT:START -->", "<!-- REALIZACJE_IMAGEOBJECT:END -->"),
    "cards": ("<!-- REALIZACJE_CARDS:START -->", "<!-- REALIZACJE_CARDS:END -->"),
    "runtime_data": ("<!-- REALIZACJE_DATA:START -->", "<!-- REALIZACJE_DATA:END -->"),
}


def escape(value: object, *, quote: bool = True) -> str:
    return html.escape(str(value), quote=quote)


def jpeg_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:2] != b"\xff\xd8":
        raise ValueError(f"Nieprawidłowy plik JPEG: {path}")

    offset = 2
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset < len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0x01, 0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(data):
            break
        length = struct.unpack(">H", data[offset : offset + 2])[0]
        if marker in sof_markers:
            if offset + 7 > len(data):
                break
            height, width = struct.unpack(">HH", data[offset + 3 : offset + 7])
            return width, height
        offset += length
    raise ValueError(f"Nie znaleziono wymiarów JPEG: {path}")


def category_dir(item: dict) -> str:
    return "na-wymiar" if item["kategoria"] == "na-wymiar" else "sieciowe"


def image_path(item: dict, base: str, size: int, extension: str) -> str:
    return f"img/realizacje/{category_dir(item)}/{base}-{size}.{extension}"


def gallery_id(item: dict) -> str:
    return SITE_URL + "#realizacja-" + item["id"]


def gallery_name(item: dict) -> str:
    title = item["tytul"].rstrip()
    return title if title.endswith(item["miasto"]) else f'{title} — {item["miasto"]}'


def image_id(item: dict, photo: dict) -> str:
    return SITE_URL + "#zdjecie-realizacji-" + photo["plik"]


def image_variants(item: dict, photo: dict, extension: str) -> list[tuple[str, int, int]]:
    variants: list[tuple[str, int, int]] = []
    used_widths: set[int] = set()
    for size in SIZES:
        relative = image_path(item, photo["plik"], size, extension)
        path = ROOT / relative
        if not path.is_file():
            raise FileNotFoundError(f"Brak wariantu obrazu: {relative}")
        width, height = jpeg_size(ROOT / image_path(item, photo["plik"], size, "jpg"))
        if width not in used_widths:
            variants.append((relative, width, height))
            used_widths.add(width)
    return variants


def srcset(variants: list[tuple[str, int, int]]) -> str:
    return ", ".join(f"{path} {width}w" for path, width, _ in variants)


def ordered_realizations(data: dict) -> list[dict]:
    by_id = {item["id"]: item for item in data["realizacje"]}
    order = data.get("kolejnosc", list(by_id))
    if set(order) != set(by_id) or len(order) != len(by_id):
        raise ValueError("Pole 'kolejnosc' musi zawierać dokładnie wszystkie ID realizacji")
    return [by_id[item_id] for item_id in order]


def runtime_photo(item: dict, photo: dict) -> dict:
    jpg = image_variants(item, photo, "jpg")
    webp = image_variants(item, photo, "webp")
    largest = image_variants(item, photo, "jpg")[-1]
    return {
        "alt": photo["alt"],
        "w": largest[1],
        "h": largest[2],
        "jpg": srcset(jpg),
        "webp": srcset(webp),
        "src": image_path(item, photo["plik"], 1200, "jpg"),
    }


def picture(item: dict, photo: dict, *, cover: bool, featured: bool = False) -> str:
    jpg = image_variants(item, photo, "jpg")
    webp = image_variants(item, photo, "webp")
    largest = jpg[-1]
    if cover:
        desktop_size = "calc((200vw - 21.5rem) / 3)" if featured else "calc((100vw - 13rem) / 3)"
        sizes = f"(max-width: 600px) calc(100vw - 3rem), (max-width: 900px) calc((100vw - 4rem) / 2), {desktop_size}"
        source_size = 800
        css_class = ""
    else:
        sizes = "(max-width: 600px) calc((100vw - 4.5rem) / 2), 180px"
        source_size = 400
        css_class = ' class="work-gallery-img"'
    return (
        "<picture>"
        f'<source type="image/webp" srcset="{escape(srcset(webp))}" sizes="{escape(sizes)}">'
        f'<img{css_class} src="{escape(image_path(item, photo["plik"], source_size, "jpg"))}" '
        f'srcset="{escape(srcset(jpg))}" sizes="{escape(sizes)}" alt="{escape(photo["alt"])}" '
        f'width="{largest[1]}" height="{largest[2]}" loading="lazy" decoding="async">'
        "</picture>"
    )


def comparison_picture(item: dict, photo: dict) -> str:
    jpg = image_variants(item, photo, "jpg")
    webp = image_variants(item, photo, "webp")
    largest = jpg[-1]
    sizes = "(max-width: 600px) calc(100vw - 5rem), (max-width: 900px) calc((100vw - 6rem) / 2), 440px"
    return (
        "<picture>"
        f'<source type="image/webp" srcset="{escape(srcset(webp))}" sizes="{escape(sizes)}">'
        f'<img class="before-after-img" src="{escape(image_path(item, photo["plik"], 800, "jpg"))}" '
        f'srcset="{escape(srcset(jpg))}" sizes="{escape(sizes)}" alt="{escape(photo["alt"])}" '
        f'width="{largest[1]}" height="{largest[2]}" loading="lazy" decoding="async">'
        "</picture>"
    )


def render_cards(data: dict) -> str:
    items = ordered_realizations(data)
    counts = {key: sum(item["kategoria"] == key for item in items) for key in data["kategorie"]}
    lines = [
        '  <div class="works-filters" role="group" aria-label="Filtruj realizacje">',
        f'    <button type="button" class="works-filter is-active" aria-pressed="true" data-filter="wszystkie">Wszystkie <span>{len(items)}</span></button>',
    ]
    for key, label in data["kategorie"].items():
        lines.append(
            f'    <button type="button" class="works-filter" aria-pressed="false" data-filter="{escape(key)}">{escape(label)} <span>{counts[key]}</span></button>'
        )
    lines.extend(
        [
            '    <span class="works-chip-wrap"></span>',
            "  </div>",
            f'  <p class="works-status" role="status" aria-live="polite">Pokazuję {len(items)} realizacji</p>',
            '  <p class="works-empty" hidden>Żadna realizacja nie spełnia obu warunków naraz. Usuń znacznik pomieszczenia albo wybierz inną kategorię.</p>',
            '  <ul class="works-grid">',
        ]
    )

    for position, item in enumerate(items):
        photos = item["zdjecia"]
        photo_by_base = {photo["plik"]: photo for photo in photos}
        cover = photo_by_base.get(item["okladka"])
        if not cover:
            raise ValueError(f"Okładka {item['okladka']} nie należy do realizacji {item['id']}")
        cover_index = photos.index(cover)
        featured = " is-featured" if position == 0 else ""
        count_label = f"{len(photos)} zdjęć" if len(photos) != 1 else "1 zdjęcie"
        lines.extend(
            [
                f'    <li class="work-card{featured}" id="realizacja-{escape(item["id"])}" data-kat="{escape(item["kategoria"])}" data-pomieszczenie="{escape(item["pomieszczenie"])}" data-realizacja="{escape(item["id"])}">',
                f'      <a class="work-card-btn" href="{escape(image_path(item, cover["plik"], 1200, "jpg"))}" data-id="{escape(item["id"])}" data-idx="{cover_index}" aria-label="{escape(item["tytul"])} — {escape(item["miasto"])} — otwórz zdjęcie okładkowe; {count_label} w galerii">',
                '        <span class="work-thumb">',
                f'          {picture(item, cover, cover=True, featured=position == 0)}',
                f'          <span class="work-badge">{escape(data["kategorie"][item["kategoria"]])}</span>',
                "        </span>",
                '        <span class="work-meta">',
                f'          <span class="work-title">{escape(item["tytul"])}</span>',
                f'          <span class="work-city">{escape(item["miasto"])}</span>',
                f'          <span class="work-count">{count_label}</span>',
                "        </span>",
                "      </a>",
                '      <details class="work-details">',
                f'        <summary>Opis i wszystkie zdjęcia ({len(photos)})</summary>',
                f'        <p class="work-description">{escape(item["opis"])}</p>',
            ]
        )
        related_page = item.get("powiazanaStrona")
        if related_page:
            lines.append(
                '        <p class="work-related">Powiązana usługa: '
                f'<a class="work-related-link" href="{escape(related_page["url"])}">{escape(related_page["etykieta"])}</a></p>'
            )
        comparisons = item.get("porownania", [])
        if comparisons:
            comparisons_id = f'porownania-{item["id"]}'
            lines.extend(
                [
                    f'        <section class="work-comparisons" aria-labelledby="{escape(comparisons_id)}">',
                    f'          <h3 id="{escape(comparisons_id)}">Przed i po montażu</h3>',
                    '          <p class="work-comparisons-intro">Przeciągnij suwak albo użyj klawiszy strzałek, aby porównać efekt.</p>',
                    '          <ul class="before-after-list">',
                ]
            )
            for comparison in comparisons:
                before = photo_by_base.get(comparison["przed"])
                after = photo_by_base.get(comparison["po"])
                if not before or not after:
                    raise ValueError(f"Porównanie odwołuje się do nieznanego zdjęcia: {item['id']}")
                name = comparison["nazwa"]
                lines.extend(
                    [
                        "            <li>",
                        f'              <figure class="before-after" data-before-after data-before="{escape(before["plik"])}" data-after="{escape(after["plik"])}">',
                        f'                <figcaption>{escape(name)}</figcaption>',
                        '                <div class="before-after-viewport">',
                        '                  <div class="before-after-pane before-after-before">',
                        f'                    {comparison_picture(item, before)}',
                        '                    <span class="before-after-label">Przed</span>',
                        "                  </div>",
                        '                  <div class="before-after-pane before-after-after">',
                        f'                    {comparison_picture(item, after)}',
                        '                    <span class="before-after-label">Po</span>',
                        "                  </div>",
                        '                  <span class="before-after-divider" aria-hidden="true"></span>',
                        f'                  <input class="before-after-control" type="range" min="0" max="100" value="50" aria-label="Porównaj zdjęcia przed i po: {escape(name)}" aria-valuetext="50% zdjęcia przed">',
                        "                </div>",
                        "              </figure>",
                        "            </li>",
                    ]
                )
            lines.extend(["          </ul>", "        </section>"])
        lines.append('        <ul class="work-gallery" aria-label="Zdjęcia realizacji">')
        for index, photo in enumerate(photos):
            lines.extend(
                [
                    "          <li>",
                    f'            <a class="work-photo-link" href="{escape(image_path(item, photo["plik"], 1200, "jpg"))}" data-id="{escape(item["id"])}" data-idx="{index}" aria-label="Otwórz zdjęcie {index + 1} z {len(photos)}: {escape(photo["alt"])}">',
                    f'              {picture(item, photo, cover=False)}',
                    "            </a>",
                    "          </li>",
                ]
            )
        lines.extend(["        </ul>", "      </details>", "    </li>"])

    lines.extend(
        [
            "  </ul>",
            '  <div class="works-cta">',
            "    <p>Podoba Ci się podobna realizacja?</p>",
            '    <a class="btn-primary" href="#kontakt">Wyceń podobny montaż</a>',
            "  </div>",
        ]
    )
    return "\n".join(lines)


def render_runtime_data(data: dict) -> str:
    runtime = {}
    for item in ordered_realizations(data):
        runtime[item["id"]] = {
            "tytul": item["tytul"],
            "miasto": item["miasto"],
            "opis": item["opis"],
            "kategoria": data["kategorie"][item["kategoria"]],
            "marka": item["marka"],
            "czas": item["czas"],
            "zdjecia": [runtime_photo(item, photo) for photo in item["zdjecia"]],
        }
    payload = json.dumps(runtime, ensure_ascii=False, separators=(",", ":"))
    return f'<script type="application/json" id="works-data">{payload}</script>'


def render_image_objects(data: dict) -> str:
    graph = []
    for item in ordered_realizations(data):
        graph.append(
            {
                "@type": "ImageGallery",
                "@id": gallery_id(item),
                "url": gallery_id(item),
                "name": gallery_name(item),
                "description": item["opis"],
                "inLanguage": "pl",
                "isPartOf": SITE_URL,
                "hasPart": [
                    {"@id": image_id(item, photo)} for photo in item["zdjecia"]
                ],
            }
        )
        for photo in item["zdjecia"]:
            content_path = image_path(item, photo["plik"], 800, "jpg")
            thumbnail_path = image_path(item, photo["plik"], 400, "jpg")
            width, height = jpeg_size(ROOT / content_path)
            graph.append(
                {
                    "@type": "ImageObject",
                    "@id": image_id(item, photo),
                    "contentUrl": SITE_URL + content_path,
                    "thumbnailUrl": SITE_URL + thumbnail_path,
                    "width": width,
                    "height": height,
                    "caption": photo["alt"],
                    "name": photo["alt"],
                    "isPartOf": {"@id": gallery_id(item)},
                    "contentLocation": {"@type": "Place", "name": item["miasto"]},
                    "datePublished": item["data"],
                    "creator": {"@type": "Organization", "name": "MebloFix Gliwice"},
                    "creditText": "MebloFix Gliwice",
                    "copyrightNotice": "MebloFix Gliwice",
                    "license": SITE_URL + "licencja-zdjec/",
                    "acquireLicensePage": SITE_URL + "licencja-zdjec/",
                }
            )
    payload = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
    return f'<script type="application/ld+json">\n{payload}\n</script>'


def replace_generated(document: str, key: str, generated: str) -> str:
    start, end = MARKERS[key]
    if document.count(start) != 1 or document.count(end) != 1:
        raise ValueError(f"Brak jednoznacznych markerów generatora: {key}")
    before, rest = document.split(start, 1)
    _, after = rest.split(end, 1)
    return f"{before}{start}\n{generated}\n{end}{after}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, default=ROOT / "index.html")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    document = args.template.read_text(encoding="utf-8")
    document = replace_generated(document, "image_objects", render_image_objects(data))
    document = replace_generated(document, "cards", render_cards(data))
    document = replace_generated(document, "runtime_data", render_runtime_data(data))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(document, encoding="utf-8")
    print(
        f"Wygenerowano realizacje: {len(data['realizacje'])} realizacji, "
        f"{sum(len(item['zdjecia']) for item in data['realizacje'])} zdjęcia -> {args.output}"
    )


if __name__ == "__main__":
    main()
