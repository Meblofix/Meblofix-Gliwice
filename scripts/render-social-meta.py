#!/usr/bin/env python3
"""Ujednolica metadane społecznościowe w gotowym buildzie."""

from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SITE = "https://meblofix-gliwice.pl"
DEFAULT_IMAGE = f"{SITE}/img/social/meblofix-og-1200x630.jpg"
DEFAULT_ALT = "MebloFix Gliwice — montaż mebli, kuchni i zabudowy"
FIELDS = (
    "og:image",
    "og:image:secure_url",
    "og:image:width",
    "og:image:height",
    "og:image:alt",
    "og:locale",
    "og:site_name",
    "twitter:card",
    "twitter:image",
    "twitter:image:alt",
)
BLOCK_RE = re.compile(r"\n?<!-- SOCIAL_META:START -->.*?<!-- SOCIAL_META:END -->\n?", re.DOTALL)


def ordered_realizations() -> dict[str, dict]:
    data = json.loads((ROOT / "data" / "realizacje.json").read_text(encoding="utf-8"))
    return {item["id"]: item for item in data["realizacje"]}


def category_dir(item: dict) -> str:
    return "na-wymiar" if item["kategoria"] == "na-wymiar" else "sieciowe"


def remove_existing(document: str) -> str:
    document = BLOCK_RE.sub("\n", document)
    for field in FIELDS:
        pattern = re.compile(
            rf'\n?<meta\s+(?:property|name)="{re.escape(field)}"\s+content="[^"]*"\s*/?>',
            re.IGNORECASE,
        )
        document = pattern.sub("", document)
    return document


def social_block(image_url: str, image_alt: str, *, fixed_size: bool) -> str:
    escaped_url = html.escape(image_url, quote=True)
    escaped_alt = html.escape(image_alt, quote=True)
    dimensions = (
        '\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">'
        if fixed_size else ""
    )
    return f'''<!-- SOCIAL_META:START -->
<meta property="og:locale" content="pl_PL">
<meta property="og:site_name" content="MebloFix Gliwice">
<meta property="og:image" content="{escaped_url}">
<meta property="og:image:secure_url" content="{escaped_url}">{dimensions}
<meta property="og:image:alt" content="{escaped_alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{escaped_url}">
<meta name="twitter:image:alt" content="{escaped_alt}">
<!-- SOCIAL_META:END -->'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    args = parser.parse_args()
    realizations = ordered_realizations()
    rendered = 0

    for page in sorted(args.dist.rglob("index.html")):
        relative = page.relative_to(args.dist)
        image_url = DEFAULT_IMAGE
        image_alt = DEFAULT_ALT
        fixed_size = True
        if len(relative.parts) == 3 and relative.parts[0] == "realizacje":
            item = realizations.get(relative.parts[1])
            if item:
                cover = next(photo for photo in item["zdjecia"] if photo["plik"] == item["okladka"])
                image_url = f'{SITE}/img/realizacje/{category_dir(item)}/{cover["plik"]}-1200.jpg'
                image_alt = cover["alt"]
                fixed_size = False

        document = remove_existing(page.read_text(encoding="utf-8"))
        block = social_block(image_url, image_alt, fixed_size=fixed_size)
        if "</head>" not in document:
            raise ValueError(f"Brak </head> w {relative}")
        page.write_text(document.replace("</head>", f"{block}\n</head>", 1), encoding="utf-8")
        rendered += 1

    print(f"Ujednolicono social meta w {rendered} stronach")


if __name__ == "__main__":
    main()
