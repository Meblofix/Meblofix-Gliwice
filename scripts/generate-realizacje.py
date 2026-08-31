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
MAX_CASE_TITLE_LENGTH = 60

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


def short_description(item: dict) -> str:
    return item.get("opis_krotki", item["opis"])


def photo_count_label(count: int) -> str:
    if count == 1:
        return "1 zdjęcie"
    if count % 10 in {2, 3, 4} and count % 100 not in {12, 13, 14}:
        return f"{count} zdjęcia"
    return f"{count} zdjęć"


def case_service_title(item: dict) -> str:
    service = item["tytul"].strip()
    for separator in (" — ", " – ", " - "):
        city_suffix = separator + item["miasto"]
        if service.endswith(city_suffix):
            service = service[: -len(city_suffix)].rstrip()
            break
    return service


def case_page_title(item: dict) -> str:
    if "title_seo" in item:
        title_seo = item["title_seo"]
        if not isinstance(title_seo, str) or not title_seo.strip():
            raise ValueError(f'Nieprawidłowe title_seo realizacji: {item["id"]}')
        return title_seo
    title = f'{case_service_title(item)} — {item["miasto"]} | MebloFix'
    if len(title) > MAX_CASE_TITLE_LENGTH:
        raise ValueError(
            f'Realizacja {item["id"]}: wygenerowany title ma {len(title)} znaków '
            f'(maksimum {MAX_CASE_TITLE_LENGTH}); ustaw title_seo'
        )
    return title


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
        count_label = photo_count_label(len(photos))
        lines.extend(
            [
                f'    <li class="work-card{featured}" id="realizacja-{escape(item["id"])}" data-kat="{escape(item["kategoria"])}" data-pomieszczenie="{escape(item["pomieszczenie"])}" data-realizacja="{escape(item["id"])}">',
                f'      <a class="work-card-btn" href="{escape(image_path(item, cover["plik"], 1200, "jpg"))}" data-id="{escape(item["id"])}" data-idx="{cover_index}" aria-label="{escape(gallery_name(item))} — otwórz zdjęcie okładkowe; {count_label} w galerii">',
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
                f'      <p class="work-page-link"><a class="work-case-link" href="realizacje/{escape(item["id"])}/">Opis i wszystkie zdjęcia ({len(photos)})</a></p>',
                '      <details class="work-details">',
                '        <summary>Skrócony opis i podgląd galerii</summary>',
                f'        <p class="work-description">{escape(short_description(item))}</p>',
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
            "opis": short_description(item),
            "kategoria": data["kategorie"][item["kategoria"]],
            "marka": item["marka"],
            "czas": item["czas"],
            "zdjecia": [runtime_photo(item, photo) for photo in item["zdjecia"]],
        }
    payload = json.dumps(runtime, ensure_ascii=False, separators=(",", ":"))
    return f'<script type="application/json" id="works-data">{payload}</script>'


def render_homepage_cards(data: dict) -> str:
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
    lines.extend([
        '    <span class="works-chip-wrap"></span>',
        '  </div>',
        f'  <p class="works-status" role="status" aria-live="polite">Pokazuję {len(items)} realizacji</p>',
        '  <p class="works-empty" hidden>Żadna realizacja nie spełnia obu warunków naraz. Usuń znacznik pomieszczenia albo wybierz inną kategorię.</p>',
        '  <ul class="works-grid">',
    ])
    for position, item in enumerate(items):
        photos = item["zdjecia"]
        cover = next(photo for photo in photos if photo["plik"] == item["okladka"])
        count_label = photo_count_label(len(photos))
        featured = " is-featured" if position == 0 else ""
        lines.extend([
            f'    <li class="work-card{featured}" id="realizacja-{escape(item["id"])}" data-kat="{escape(item["kategoria"])}" data-pomieszczenie="{escape(item["pomieszczenie"])}" data-realizacja="{escape(item["id"])}">',
            f'      <a class="work-card-btn" href="realizacje/{escape(item["id"])}/" data-id="{escape(item["id"])}" aria-label="{escape(gallery_name(item))} — opis i {count_label}">',
            '        <span class="work-thumb">',
            f'          {picture(item, cover, cover=True, featured=position == 0)}',
            f'          <span class="work-badge">{escape(data["kategorie"][item["kategoria"]])}</span>',
            '        </span>',
            '        <span class="work-meta">',
            f'          <span class="work-title">{escape(item["tytul"])}</span>',
            f'          <span class="work-city">{escape(item["miasto"])}</span>',
            f'          <span class="work-count">{count_label}</span>',
            '          <span class="work-case-link">Opis i wszystkie zdjęcia</span>',
            '        </span>',
            '      </a>',
            '    </li>',
        ])
    lines.extend([
        '  </ul>',
        '  <div class="works-cta">',
        '    <p>Podoba Ci się podobna realizacja?</p>',
        '    <a class="btn-primary" href="#kontakt">Wyceń podobny montaż</a>',
        '  </div>',
    ])
    return "\n".join(lines)


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
            image_object = {
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
                    "creator": {"@type": "Organization", "name": "MebloFix Gliwice"},
                    "creditText": "MebloFix Gliwice",
                    "copyrightNotice": "MebloFix Gliwice",
                    "license": SITE_URL + "licencja-zdjec/",
                    "acquireLicensePage": SITE_URL + "licencja-zdjec/",
                }
            if item.get("data"):
                image_object["datePublished"] = item["data"]
            graph.append(image_object)
    payload = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
    return f'<script type="application/ld+json">\n{payload}\n</script>'


def case_picture(item: dict, photo: dict, *, eager: bool = False) -> str:
    jpg = image_variants(item, photo, "jpg")
    webp = image_variants(item, photo, "webp")
    largest = jpg[-1]
    prefix = "../../"
    loading = ' loading="eager" fetchpriority="high"' if eager else ' loading="lazy"'
    sizes = "(max-width: 520px) calc(100vw - 2.5rem), (max-width: 800px) calc((100vw - 3.5rem) / 2), 360px"
    return (
        "<picture>"
        f'<source type="image/webp" srcset="{escape(srcset([(prefix + path, width, height) for path, width, height in webp]))}" sizes="{escape(sizes)}">'
        f'<img src="{escape(prefix + image_path(item, photo["plik"], 800, "jpg"))}" '
        f'srcset="{escape(srcset([(prefix + path, width, height) for path, width, height in jpg]))}" '
        f'sizes="{escape(sizes)}" alt="{escape(photo["alt"])}" width="{largest[1]}" height="{largest[2]}"'
        f'{loading} decoding="async">'
        "</picture>"
    )


def case_comparisons(item: dict) -> list[dict]:
    comparisons = list(item.get("porownania", []))
    if item.get("przed_po"):
        comparisons.append({"nazwa": "Porównanie realizacji", **item["przed_po"]})
    return comparisons


def related_realizations(data: dict, item: dict, limit: int = 3) -> list[dict]:
    others = [candidate for candidate in ordered_realizations(data) if candidate["id"] != item["id"]]
    same_category = [candidate for candidate in others if candidate["kategoria"] == item["kategoria"]]
    remaining = [candidate for candidate in others if candidate["kategoria"] != item["kategoria"]]
    return (same_category + remaining)[:limit]


def render_case_image_objects(item: dict, page_url: str) -> str:
    gallery_url = page_url + "#galeria"
    graph: list[dict] = [
        {
            "@type": "ImageGallery",
            "@id": gallery_url,
            "url": gallery_url,
            "name": gallery_name(item),
            "description": item["opis"],
            "inLanguage": "pl",
            "isPartOf": page_url,
            "hasPart": [
                {"@id": page_url + "#zdjecie-" + photo["plik"]} for photo in item["zdjecia"]
            ],
        }
    ]
    for photo in item["zdjecia"]:
        content_path = image_path(item, photo["plik"], 800, "jpg")
        thumbnail_path = image_path(item, photo["plik"], 400, "jpg")
        width, height = jpeg_size(ROOT / content_path)
        image_object = {
                "@type": "ImageObject",
                "@id": page_url + "#zdjecie-" + photo["plik"],
                "contentUrl": SITE_URL + content_path,
                "thumbnailUrl": SITE_URL + thumbnail_path,
                "width": width,
                "height": height,
                "caption": photo["alt"],
                "name": photo["alt"],
                "isPartOf": {"@id": gallery_url},
                "contentLocation": {"@type": "Place", "name": item["miasto"]},
                "creator": {"@type": "Organization", "name": "MebloFix Gliwice"},
                "creditText": "MebloFix Gliwice",
                "copyrightNotice": "MebloFix Gliwice",
                "license": SITE_URL + "licencja-zdjec/",
                "acquireLicensePage": SITE_URL + "licencja-zdjec/",
            }
        if item.get("data"):
            image_object["datePublished"] = item["data"]
        graph.append(image_object)
    payload = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
    return f'<script type="application/ld+json">\n{payload}\n</script>'


def render_case_page(data: dict, item: dict) -> str:
    photos = item["zdjecia"]
    photo_by_base = {photo["plik"]: photo for photo in photos}
    cover = photo_by_base[item["okladka"]]
    slug = item["id"]
    page_url = f"{SITE_URL}realizacje/{slug}/"
    title = case_page_title(item)
    description = item.get("meta_description")
    if not description:
        description = f'{case_service_title(item)} w {item["miasto"]}. {item["opis"]}'
        if len(description) > 158:
            description = description[:155].rsplit(" ", 1)[0] + "…"
    cover_url = SITE_URL + image_path(item, cover["plik"], 1200, "jpg")
    breadcrumb = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Strona główna", "item": SITE_URL},
                {"@type": "ListItem", "position": 2, "name": "Realizacje", "item": SITE_URL + "#realizacje"},
                {"@type": "ListItem", "position": 3, "name": item["tytul"], "item": page_url},
            ],
        },
        ensure_ascii=False,
        indent=2,
    )
    image_objects = render_case_image_objects(item, page_url)

    facts = [item["miasto"], data["kategorie"][item["kategoria"]]]
    if item.get("marka"):
        facts.append(item["marka"])
    if item.get("czas"):
        facts.append(item["czas"])
    facts_html = "".join(f'<span class="fact">{escape(fact)}</span>' for fact in facts)

    scope_html = ""
    scope_items = item.get("zakresPrac", [])
    if scope_items:
        scope_list = "".join(f"<li>{escape(scope_item)}</li>" for scope_item in scope_items)
        excluded_items = item.get("pozaZakresem", [])
        excluded_html = ""
        if excluded_items:
            excluded_list = "".join(f"<li>{escape(excluded_item)}</li>" for excluded_item in excluded_items)
            excluded_html = f'<h3>Poza zakresem realizacji</h3><ul class="scope-list">{excluded_list}</ul>'
        scope_html = (
            '<section class="section section-muted"><div class="wrap">'
            '<h2>Zakres realizacji</h2>'
            f'<p class="section-intro">{escape(item["opis"])}</p>'
            '<h3>Wykonane prace</h3>'
            f'<ul class="scope-list">{scope_list}</ul>'
            f'{excluded_html}'
            '</div></section>'
        )

    gallery = []
    for index, photo in enumerate(photos):
        gallery.append(
            "<li>"
            f'<a href="../../{escape(image_path(item, photo["plik"], 1200, "jpg"))}" '
            f'aria-label="Otwórz zdjęcie {index + 1} z {len(photos)}: {escape(photo["alt"])}">'
            f'{case_picture(item, photo, eager=index == 0)}'
            "</a></li>"
        )

    comparisons_html = ""
    comparisons = case_comparisons(item)
    if comparisons:
        comparison_items = []
        for comparison in comparisons:
            before = photo_by_base[comparison["przed"]]
            after = photo_by_base[comparison["po"]]
            comparison_items.append(
                '<li><figure class="comparison">'
                f'<figcaption>{escape(comparison["nazwa"])}</figcaption>'
                '<div class="before-after-frame" data-before-after>'
                f'<div class="before-after-before">{case_picture(item, before)}<span>Przed</span></div>'
                f'<div class="before-after-after">{case_picture(item, after)}<span>Po</span></div>'
                '<span class="before-after-divider" aria-hidden="true"></span>'
                f'<input type="range" min="0" max="100" value="50" aria-label="Porównaj zdjęcia przed i po: {escape(comparison["nazwa"])}" aria-valuetext="50% zdjęcia przed">'
                "</div></figure></li>"
            )
        comparisons_html = (
            '<section class="section section-muted"><div class="wrap">'
            '<h2>Przed i po</h2><p class="section-intro">Porównanie zdjęć należących do tej realizacji.</p>'
            f'<ul class="comparisons">{"".join(comparison_items)}</ul>'
            "</div></section>"
        )

    related_links: list[tuple[str, str]] = []
    city_pages = {
        "Gliwice": ("../../montaz-mebli-gliwice/", "Montaż mebli w Gliwicach"),
        "Zabrze": ("../../montaz-mebli-zabrze/", "Montaż mebli w Zabrzu"),
    }
    related_links.append(city_pages.get(item["miasto"], ("../../#obszar", "Obszar działania MebloFix")))
    related_page = item.get("powiazanaStrona")
    if related_page:
        related_links.append(("../../" + related_page["url"], related_page["etykieta"]))
    for related_page in item.get("powiazaneStrony", []):
        related_links.append(("../../" + related_page["url"], related_page["etykieta"]))
    if item.get("marka") == "IKEA":
        related_links.append(("../../montaz-mebli-ikea-gliwice/", "Montaż mebli IKEA"))
    unique_links = []
    seen_hrefs = set()
    for href, label in related_links:
        if href not in seen_hrefs:
            unique_links.append(f'<a class="cta cta-secondary" href="{escape(href)}">{escape(label)}</a>')
            seen_hrefs.add(href)

    related_cards = []
    for related in related_realizations(data, item):
        related_photos = {photo["plik"]: photo for photo in related["zdjecia"]}
        related_cover = related_photos[related["okladka"]]
        related_cards.append(
            "<li>"
            f'<a class="related-case" href="../{escape(related["id"])}/">'
            f'<span class="related-case-image">{case_picture(related, related_cover)}</span>'
            '<span class="related-case-copy">'
            f'<strong>{escape(related["tytul"])}</strong>'
            f'<span>{escape(related["miasto"])}</span>'
            "</span></a></li>"
        )
    related_section = (
        '<section class="section section-muted related-cases"><div class="wrap">'
        '<h2>Podobne realizacje</h2>'
        f'<ul class="related-cases-grid">{"".join(related_cards)}</ul>'
        "</div></section>"
    )

    return f'''<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" sizes="96x96" href="../../favicon-96.png">
<link rel="apple-touch-icon" sizes="180x180" href="../../apple-touch-icon.png">
<title>{escape(title)}</title>
<meta name="description" content="{escape(description)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="{escape(page_url)}">
<meta property="og:type" content="article">
<meta property="og:title" content="{escape(title)}">
<meta property="og:description" content="{escape(description)}">
<meta property="og:url" content="{escape(page_url)}">
<meta property="og:locale" content="pl_PL">
<meta property="og:site_name" content="MebloFix Gliwice">
<meta property="og:image" content="{escape(cover_url)}">
<meta property="og:image:alt" content="{escape(cover["alt"])}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{escape(cover_url)}">
<link rel="preload" href="../../fonts/JTUSjIg69CK48gW7PXoo9Wdhyzbi.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="../../fonts/fonts.css">
<link rel="stylesheet" href="../../css/realizacje.css">
<script type="application/ld+json">
{breadcrumb}
</script>
{image_objects}
</head>
<body>
<a class="skip-link" href="#main-content">Przejdź do treści</a>
<header class="top">
  <a class="logo" href="../../">Meblo<span>Fix</span><sub>Gliwice</sub></a>
  <nav class="nav" aria-label="Główna nawigacja"><a href="../../#uslugi">Usługi</a><a href="../../#realizacje">Realizacje</a><a href="../../#cennik">Cennik</a><a href="../../#kontakt">Kontakt</a></nav>
</header>
<nav class="breadcrumbs" aria-label="Okruszki"><ol class="wrap"><li><a href="../../">Strona główna</a></li><li><a href="../../#realizacje">Realizacje</a></li><li aria-current="page">{escape(item["tytul"])}</li></ol></nav>
<main id="main-content" tabindex="-1">
  <article>
    <header class="hero"><div class="wrap"><div class="eyebrow">Realizacja · {escape(item["miasto"])}</div><h1>{escape(item["tytul"])}</h1><p class="lead">{escape(short_description(item))}</p><div class="facts">{facts_html}</div></div></header>
    {scope_html}
    <section class="section" id="galeria"><div class="wrap"><h2>Zdjęcia realizacji</h2><p class="section-intro">Galeria zawiera {photo_count_label(len(photos))} z tego zlecenia.</p><ul class="gallery">{"".join(gallery)}</ul></div></section>
    {comparisons_html}
    <section class="section"><div class="wrap"><h2>Podobny montaż</h2><p class="section-intro">Podeślij zdjęcia, instrukcję lub linki do produktów, aby otrzymać orientacyjną wycenę.</p><div class="links"><a class="cta" href="../../#kalkulator">Wyceń podobny montaż</a>{"".join(unique_links)}</div></div></section>
    {related_section}
  </article>
</main>
<dialog class="case-lightbox" id="caseLightbox" aria-label="Podgląd zdjęć realizacji">
  <button class="case-lightbox-close" type="button" data-lightbox-close aria-label="Zamknij podgląd">×</button>
  <button class="case-lightbox-nav case-lightbox-previous" type="button" data-lightbox-previous aria-label="Poprzednie zdjęcie">←</button>
  <div class="case-lightbox-media" data-lightbox-media></div>
  <button class="case-lightbox-nav case-lightbox-next" type="button" data-lightbox-next aria-label="Następne zdjęcie">→</button>
  <p class="case-lightbox-caption" data-lightbox-caption></p>
  <p class="case-lightbox-counter" data-lightbox-counter role="status" aria-live="polite"></p>
</dialog>
<footer><span>© 2026 MebloFix Gliwice</span><a href="../../#realizacje">Wszystkie realizacje</a></footer>
<script src="../../analytics.js"></script>
<script src="../../js/realizacje.js"></script>
</body>
</html>
'''


def write_case_pages(data: dict, pages_dir: Path) -> None:
    for item in ordered_realizations(data):
        target = pages_dir / item["id"] / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_case_page(data, item), encoding="utf-8")


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
    parser.add_argument("--pages-dir", type=Path)
    args = parser.parse_args()

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    document = args.template.read_text(encoding="utf-8")
    document = replace_generated(document, "image_objects", "<!-- Dane zdjęć są na stronach poszczególnych realizacji. -->")
    document = replace_generated(document, "cards", render_homepage_cards(data))
    document = replace_generated(document, "runtime_data", "<!-- Galeria została przeniesiona na trwałe strony realizacji. -->")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(document, encoding="utf-8")
    if args.pages_dir:
        write_case_pages(data, args.pages_dir)
    print(
        f"Wygenerowano realizacje: {len(data['realizacje'])} realizacji, "
        f"{sum(len(item['zdjecia']) for item in data['realizacje'])} zdjęcia -> {args.output}"
    )


if __name__ == "__main__":
    main()
