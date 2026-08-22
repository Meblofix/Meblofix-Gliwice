#!/usr/bin/env python3
"""Sprawdza komplet i źródła metadanych Open Graph/Twitter."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import urlparse


SITE = "https://meblofix-gliwice.pl"
DEFAULT_IMAGE = f"{SITE}/img/social/meblofix-og-1200x630.jpg"
REQUIRED = ("og:locale", "og:site_name", "og:image", "og:image:alt")
TWITTER_REQUIRED = ("twitter:card", "twitter:image", "twitter:image:alt")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def meta_values(source: str, attribute: str, field: str) -> list[str]:
    return re.findall(
        rf'<meta\s+{attribute}="{re.escape(field)}"\s+content="([^"]+)"\s*/?>',
        source,
        re.IGNORECASE,
    )


def jpeg_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    require(data[:2] == b"\xff\xd8", f"To nie jest JPEG: {path}")
    position = 2
    while position + 9 < len(data):
        if data[position] != 0xFF:
            position += 1
            continue
        marker = data[position + 1]
        position += 2
        if marker in {0xD8, 0xD9}:
            continue
        length = int.from_bytes(data[position : position + 2], "big")
        if marker in range(0xC0, 0xC4):
            height = int.from_bytes(data[position + 3 : position + 5], "big")
            width = int.from_bytes(data[position + 5 : position + 7], "big")
            return width, height
        position += length
    raise AssertionError(f"Nie odczytano wymiarów JPEG: {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    args = parser.parse_args()

    default_file = args.dist / "img" / "social" / "meblofix-og-1200x630.jpg"
    require(default_file.is_file(), "Brak wspólnej grafiki Open Graph")
    require(jpeg_size(default_file) == (1200, 630), "Grafika Open Graph nie ma 1200×630")

    checked = 0
    for page in sorted(args.dist.rglob("index.html")):
        source = page.read_text(encoding="utf-8")
        relative = page.relative_to(args.dist).as_posix()
        for field in REQUIRED:
            values = meta_values(source, "property", field)
            require(len(values) == 1 and values[0], f"{relative}: nieunikalne lub puste {field}")
        for field in TWITTER_REQUIRED:
            values = meta_values(source, "name", field)
            require(len(values) == 1 and values[0], f"{relative}: nieunikalne lub puste {field}")

        image_url = meta_values(source, "property", "og:image")[0]
        parsed = urlparse(image_url)
        require(f"{parsed.scheme}://{parsed.netloc}" == SITE, f"{relative}: zewnętrzny og:image")
        require((args.dist / parsed.path.lstrip("/")).is_file(), f"{relative}: brak pliku og:image")
        require(meta_values(source, "name", "twitter:image") == [image_url], f"{relative}: różne obrazy OG/Twitter")
        if relative.startswith("realizacje/"):
            require(image_url != DEFAULT_IMAGE, f"{relative}: case study nie używa własnego zdjęcia")
        checked += 1

    print(f"OK: kompletne social meta na {checked} stronach; grafika wspólna ma 1200×630")


if __name__ == "__main__":
    main()
