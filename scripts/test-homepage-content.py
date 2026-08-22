#!/usr/bin/env python3
"""Pilnuje, aby homepage nie dublował pełnych artykułów blogowych."""

from __future__ import annotations

import argparse
from pathlib import Path


FULL_ARTICLE_FRAGMENTS = (
    "Rysy i zadrapania mogą powstać podczas przeprowadzki, wnoszenia paczek",
    "Stan mebla po kilku latach zależy od wielu czynników",
    "Podczas samodzielnego montażu łatwo przeoczyć obróconą płytę",
)

ARTICLE_LINKS = (
    "blog/jak-usunac-rysy-z-mebli/",
    "blog/jak-dbac-o-meble/",
    "blog/bledy-przy-montazu-ikea/",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--html", type=Path, required=True)
    args = parser.parse_args()

    source = args.html.read_text(encoding="utf-8")
    for fragment in FULL_ARTICLE_FRAGMENTS:
        require(fragment not in source, f"Homepage nadal zawiera pełny artykuł: {fragment}")
    for link in ARTICLE_LINKS:
        require(f'href="{link}"' in source, f"Homepage nie linkuje bezpośrednio do {link}")

    require('<div class="blog-modal-overlay"' not in source, "Homepage nadal zawiera modal pełnego artykułu")
    require(args.html.stat().st_size < 260_000, "Homepage ponownie urósł powyżej 260 kB")
    print(f"OK: homepage ma lekkie zajawki bloga i waży {args.html.stat().st_size} B")


if __name__ == "__main__":
    main()
