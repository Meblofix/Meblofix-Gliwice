#!/usr/bin/env python3
"""Sprawdza techniczne SEO statycznego buildu Cloudflare Pages."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse
from xml.etree import ElementTree


SITE_ORIGIN = "https://meblofix-gliwice.pl"
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
IGNORED_SCHEMES = ("mailto:", "tel:", "javascript:", "data:")


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.h1_parts: list[list[str]] = []
        self.description = ""
        self.robots = ""
        self.canonicals: list[str] = []
        self.links: list[str] = []
        self.empty_hrefs: list[str] = []
        self.images: list[dict[str, str]] = []
        self.ids: set[str] = set()
        self.json_ld_raw: list[str] = []
        self.visible_parts: list[str] = []
        self._title = False
        self._h1 = False
        self._json_ld = False
        self._json_parts: list[str] = []
        self._hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if values.get("id"):
            self.ids.add(values["id"])
        if tag == "title":
            self._title = True
        elif tag == "h1":
            self._h1 = True
            self.h1_parts.append([])
        elif tag == "meta":
            name = values.get("name", "").lower()
            if name == "description":
                self.description = values.get("content", "").strip()
            elif name == "robots":
                self.robots = values.get("content", "").strip()
        elif tag == "link" and "canonical" in values.get("rel", "").lower().split():
            self.canonicals.append(values.get("href", "").strip())
        elif tag == "a" and "href" in values:
            href = values["href"].strip()
            if not href or href == "#":
                self.empty_hrefs.append(href)
            else:
                self.links.append(href)
        elif tag == "img":
            self.images.append(values)
        if tag == "script" and values.get("type", "").lower() == "application/ld+json":
            self._json_ld = True
            self._json_parts = []
        if tag in {"script", "style", "svg", "noscript"}:
            self._hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._title = False
        elif tag == "h1":
            self._h1 = False
        if tag == "script" and self._json_ld:
            self.json_ld_raw.append("".join(self._json_parts).strip())
            self._json_ld = False
            self._json_parts = []
        if tag in {"script", "style", "svg", "noscript"} and self._hidden_depth:
            self._hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._json_ld:
            self._json_parts.append(data)
        if self._title:
            self.title_parts.append(data)
        if self._h1 and self.h1_parts:
            self.h1_parts[-1].append(data)
        if not self._hidden_depth:
            compact = " ".join(data.split())
            if compact:
                self.visible_parts.append(compact)

    @property
    def title(self) -> str:
        return " ".join(" ".join(self.title_parts).split())

    @property
    def h1s(self) -> list[str]:
        return [" ".join(" ".join(parts).split()) for parts in self.h1_parts]

    @property
    def text(self) -> str:
        return " ".join(self.visible_parts)


def page_path(path: Path, dist: Path) -> str:
    relative = path.relative_to(dist).as_posix()
    if relative == "index.html":
        return "/"
    if relative.endswith("/index.html"):
        return "/" + relative[: -len("index.html")]
    return "/" + relative


def target_file(path: str, dist: Path) -> Path:
    clean = path.lstrip("/")
    if not clean:
        return dist / "index.html"
    candidate = dist / clean
    if path.endswith("/") or candidate.is_dir():
        return candidate / "index.html"
    return candidate


def schema_nodes(value: object):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from schema_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from schema_nodes(child)


def normalized_text(value: str) -> str:
    compact = re.sub(r"\s+", " ", value.lower()).strip()
    return re.sub(r"\s+([.,;:!?])", r"\1", compact)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, default=Path("dist"))
    args = parser.parse_args()
    dist = args.dist.resolve()
    errors: list[str] = []
    warnings: list[str] = []

    sitemap_path = dist / "sitemap.xml"
    try:
        root = ElementTree.parse(sitemap_path).getroot()
    except (OSError, ElementTree.ParseError) as error:
        print(f"BŁĄD: nie można odczytać sitemap.xml: {error}")
        return 1
    sitemap_urls = [node.text.strip() for node in root.findall("sm:url/sm:loc", SITEMAP_NS) if node.text]
    sitemap_paths: list[str] = []
    seen_urls: set[str] = set()
    for url in sitemap_urls:
        parsed = urlparse(url)
        if url in seen_urls:
            errors.append(f"duplikat w sitemapie: {url}")
        seen_urls.add(url)
        if f"{parsed.scheme}://{parsed.netloc}" != SITE_ORIGIN:
            errors.append(f"niekanoniczny host/schemat w sitemapie: {url}")
        if parsed.query or parsed.fragment:
            errors.append(f"parametr lub fragment w sitemapie: {url}")
        if parsed.path != "/" and not parsed.path.endswith("/"):
            errors.append(f"brak końcowego ukośnika w sitemapie: {url}")
        sitemap_paths.append(parsed.path)

    html_files = sorted(path for path in dist.rglob("*.html") if path.name == "index.html")
    pages: dict[str, PageParser] = {}
    schemas_by_page: dict[str, list[object]] = defaultdict(list)
    schema_types: Counter[str] = Counter()
    image_objects: list[tuple[str, dict]] = []
    titles: dict[str, list[str]] = defaultdict(list)
    h1_values: dict[str, list[str]] = defaultdict(list)
    canonical_values: dict[str, list[str]] = defaultdict(list)
    local_business_nodes: list[tuple[str, dict]] = []
    for html_file in html_files:
        path = page_path(html_file, dist)
        raw_source = html_file.read_text(encoding="utf-8")
        parsed_page = PageParser()
        parsed_page.feed(raw_source)
        pages[path] = parsed_page
        expected_canonical = SITE_ORIGIN + path
        if not parsed_page.title:
            errors.append(f"{path}: brak title")
        else:
            titles[parsed_page.title.casefold()].append(path)
        if not parsed_page.description:
            errors.append(f"{path}: brak meta description")
        is_noindex = "noindex" in parsed_page.robots.lower()
        if is_noindex and path in sitemap_paths:
            errors.append(f"{path}: strona noindex występuje w sitemapie")
        if parsed_page.robots and "index" not in parsed_page.robots.lower():
            warnings.append(f"{path}: nietypowe meta robots: {parsed_page.robots}")
        if parsed_page.canonicals != [expected_canonical]:
            errors.append(f"{path}: canonical {parsed_page.canonicals!r}, oczekiwano {expected_canonical}")
        for canonical in parsed_page.canonicals:
            canonical_values[canonical].append(path)
        if len(parsed_page.h1s) != 1 or not parsed_page.h1s[0]:
            errors.append(f"{path}: oczekiwano jednego niepustego H1, znaleziono {parsed_page.h1s!r}")
        elif parsed_page.h1s:
            h1_values[parsed_page.h1s[0].casefold()].append(path)
        if parsed_page.empty_hrefs:
            errors.append(f"{path}: pusty href lub href=\"#\"")
        for image in parsed_page.images:
            if not image.get("src", "").strip():
                errors.append(f"{path}: obraz bez src ({image.get('alt', 'bez alt')})")
            if not image.get("alt", "").strip():
                errors.append(f"{path}: obraz bez alt ({image.get('src', 'bez src')})")
        if re.search(r"\{\{[^{}]+\}\}", raw_source):
            errors.append(f"{path}: niewypełniony placeholder {{{{...}}}}")
        if re.search(r"\[\[[^\[\]]+\]\]", raw_source):
            errors.append(f"{path}: niewypełniony marker [[...]]")
        if not is_noindex and path not in sitemap_paths:
            errors.append(f"{path}: publiczna strona nieobecna w sitemapie")
        for raw in parsed_page.json_ld_raw:
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as error:
                errors.append(f"{path}: nieprawidłowy JSON-LD: {error}")
                continue
            schemas_by_page[path].append(payload)
            for node in schema_nodes(payload):
                kind = node.get("@type")
                kinds = [kind] if isinstance(kind, str) else kind if isinstance(kind, list) else []
                for schema_type in kinds:
                    if not isinstance(schema_type, str):
                        continue
                    schema_types[schema_type] += 1
                    if schema_type == "ImageObject":
                        image_objects.append((path, node))
                    elif schema_type == "FAQPage":
                        errors.append(f"{path}: niedozwolony FAQPage JSON-LD")
                    elif schema_type == "BreadcrumbList":
                        items = node.get("itemListElement", [])
                        positions = [item.get("position") for item in items if isinstance(item, dict)]
                        if len(items) < 2:
                            errors.append(f"{path}: BreadcrumbList ma mniej niż 2 elementy")
                        if positions != list(range(1, len(items) + 1)):
                            errors.append(f"{path}: nieciągłe pozycje BreadcrumbList: {positions}")
                    if schema_type == "LocalBusiness":
                        local_business_nodes.append((path, node))
                        for forbidden in ("aggregateRating", "review", "serviceArea", "geo"):
                            if forbidden in node:
                                errors.append(f"{path}: LocalBusiness zawiera niedozwolone pole {forbidden}")
                        if node.get("@id") != f"{SITE_ORIGIN}/#business":
                            errors.append(f"{path}: LocalBusiness nie ma stabilnego @id")
                if "serviceArea" in node:
                    errors.append(f"{path}: schema zawiera przestarzałe serviceArea")
                for key, value in node.items():
                    if key in {"url", "@id", "contentUrl", "thumbnailUrl", "license", "acquireLicensePage", "item"} and isinstance(value, str):
                        if "pages.dev" in value or "www.meblofix-gliwice.pl" in value or value.startswith("http://meblofix-gliwice.pl"):
                            errors.append(f"{path}: niekanoniczny URL w JSON-LD ({key}): {value}")

    for label, values in (("title", titles), ("H1", h1_values), ("canonical", canonical_values)):
        for value, paths in values.items():
            if len(paths) > 1:
                errors.append(f"nieunikalny {label} na {', '.join(paths)}: {value}")
    if len(local_business_nodes) != 1 or local_business_nodes[0][0] != "/":
        errors.append(f"oczekiwano jednego LocalBusiness na homepage, znaleziono {len(local_business_nodes)}")

    for path in sitemap_paths:
        if path not in pages:
            errors.append(f"{path}: URL z sitemapy nie ma strony index.html w dist")

    redirects_path = dist / "_redirects"
    redirect_sources: list[str] = []
    if redirects_path.is_file():
        redirect_targets: dict[str, str] = {}
        for line in redirects_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            if len(parts) < 3 or parts[-1] not in {"301", "302", "303", "307", "308"}:
                errors.append(f"nieprawidłowa reguła w _redirects: {line}")
                continue
            redirect_sources.append(parts[0])
            redirect_targets[parts[0]] = parts[1]
        for source, target in redirect_targets.items():
            if target in redirect_sources:
                errors.append(f"łańcuch przekierowań: {source} → {target}")
    for path in sitemap_paths:
        for source in redirect_sources:
            matched = path == source
            if "*" in source:
                prefix = source.split("*", 1)[0]
                matched = path.startswith(prefix)
            if matched:
                errors.append(f"{path}: URL z sitemapy pasuje do reguły redirectu {source}")

    for path, image in image_objects:
        for field in ("contentUrl", "thumbnailUrl", "license", "acquireLicensePage"):
            if not image.get(field):
                errors.append(f"{path}: ImageObject {image.get('@id', '(bez @id)')} nie ma {field}")
        for field in ("license", "acquireLicensePage"):
            value = image.get(field)
            if isinstance(value, str):
                parsed = urlparse(value)
                if parsed.netloc == "meblofix-gliwice.pl" and not target_file(parsed.path, dist).is_file():
                    errors.append(f"{path}: {field} prowadzi do brakującego pliku: {value}")

    robots_source = (dist / "robots.txt").read_text(encoding="utf-8")
    for protected_path in ("/css", "/js", "/img", "/cennik-montazu-mebli", "/realizacje"):
        if re.search(rf"^Disallow:\s*{re.escape(protected_path)}", robots_source, re.MULTILINE | re.IGNORECASE):
            errors.append(f"robots.txt blokuje zasób lub stronę: {protected_path}")

    inbound_sources: dict[str, set[str]] = defaultdict(set)
    broken_links: set[tuple[str, str]] = set()
    redirected_links: set[tuple[str, str]] = set()
    broken_fragments: set[tuple[str, str]] = set()
    for source_path, parsed_page in pages.items():
        base = SITE_ORIGIN + source_path
        for href in parsed_page.links:
            if not href or href.startswith(IGNORED_SCHEMES):
                continue
            absolute = urljoin(base, href)
            target_url, fragment = urldefrag(absolute)
            parsed = urlparse(target_url)
            if parsed.netloc and parsed.netloc != "meblofix-gliwice.pl":
                continue
            target_path = parsed.path or "/"
            if not target_path.endswith("/") and target_path + "/" in pages:
                redirected_links.add((source_path, href))
            file = target_file(target_path, dist)
            if not file.is_file():
                broken_links.add((source_path, href))
                continue
            if target_path in pages:
                if source_path != target_path:
                    inbound_sources[target_path].add(source_path)
                if fragment and fragment not in pages[target_path].ids:
                    broken_fragments.add((source_path, href))
            elif fragment and file.suffix == ".html":
                broken_fragments.add((source_path, href))

    for source, href in sorted(broken_links):
        errors.append(f"{source}: uszkodzony link wewnętrzny {href}")
    for source, href in sorted(redirected_links):
        errors.append(f"{source}: link wewnętrzny prowadzi przez redirect {href}")
    for source, href in sorted(broken_fragments):
        errors.append(f"{source}: nieistniejący fragment linku {href}")
    for path in pages:
        if path != "/" and not inbound_sources[path]:
            errors.append(f"{path}: strona osierocona (brak linków z innych stron)")

    similarities: list[tuple[float, str, str]] = []
    page_items = sorted(pages.items())
    for index, (left_path, left) in enumerate(page_items):
        for right_path, right in page_items[index + 1 :]:
            ratio = SequenceMatcher(None, normalized_text(left.text), normalized_text(right.text)).ratio()
            similarities.append((ratio, left_path, right_path))
    similarities.sort(reverse=True)
    for ratio, left, right in similarities:
        if ratio >= 0.80:
            warnings.append(f"wysokie podobieństwo treści {ratio:.1%}: {left} ↔ {right}")

    print("URL\tSITEMAP\tTITLE\tDESCRIPTION\tH1\tROBOTS\tCANONICAL\tLINKI_PRZYCHODZĄCE")
    for path, page in sorted(pages.items()):
        print(
            f"{path}\t{'tak' if path in sitemap_paths else 'nie'}\t{len(page.title)}\t"
            f"{len(page.description)}\t{len(page.h1s)}\t{page.robots or '(brak)'}\t"
            f"{page.canonicals[0] if len(page.canonicals) == 1 else page.canonicals!r}\t{len(inbound_sources[path])}"
        )
    print(f"\nSitemap: {len(sitemap_urls)} URL-i; publiczne HTML: {len(pages)}")
    print("Typy JSON-LD: " + ", ".join(f"{key}={value}" for key, value in sorted(schema_types.items())))
    print(f"ImageObject: {len(image_objects)}; z kompletem license/acquireLicensePage: "
          f"{sum(bool(node.get('license') and node.get('acquireLicensePage')) for _, node in image_objects)}")
    if similarities:
        print("Najwyższe podobieństwo treści: " + "; ".join(
            f"{ratio:.1%} {left} ↔ {right}" for ratio, left, right in similarities[:5]
        ))
    for warning in warnings:
        print(f"OSTRZEŻENIE: {warning}")
    for error in errors:
        print(f"BŁĄD: {error}")
    print(f"\nWynik: {len(errors)} błędów, {len(warnings)} ostrzeżeń")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
