#!/usr/bin/env python3
"""Pilnuje kompletności podstrony współpracy montażowej B2B."""

from __future__ import annotations

import argparse
from pathlib import Path


B2B_PATH = "wspolpraca-b2b-montaz-mebli-slask/"
B2B_URL = f"https://meblofix-gliwice.pl/{B2B_PATH}"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    args = parser.parse_args()

    page_path = args.dist / B2B_PATH / "index.html"
    require(page_path.is_file(), f"Brak strony {B2B_PATH}")
    page = page_path.read_text(encoding="utf-8")
    homepage = (args.dist / "index.html").read_text(encoding="utf-8")
    sitemap = (args.dist / "sitemap.xml").read_text(encoding="utf-8")
    robots = (args.dist / "robots.txt").read_text(encoding="utf-8")
    llms = (args.dist / "llms.txt").read_text(encoding="utf-8")

    required_page_fragments = (
        '<h1>Podwykonawca montażu mebli B2B na Śląsku</h1>',
        f'<link rel="canonical" href="{B2B_URL}">',
        '"@type": "Service"',
        '"@type":"BusinessAudience"',
        "Producenci mebli",
        "Sklepy i e-commerce",
        'href="tel:+48784878197"',
        "https://wa.me/48784878197",
        "../realizacje/kuchnia-obi-gliwice/",
        "../realizacje/kuchnia-ikea-pogrzebien/",
        "../realizacje/zabudowa-i-lozko-gliwice/",
    )
    for fragment in required_page_fragments:
        require(fragment in page, f"Strona B2B nie zawiera: {fragment}")

    page_casefolded = page.casefold()
    for phrase in ("montaż u klienta końcowego", "montaż próbny"):
        require(phrase in page_casefolded, f"Strona B2B nie zawiera frazy: {phrase}")

    for unsupported_claim in ("NIP", "ubezpieczenie OC", "certyfikat SEP", "wystawiam faktury"):
        require(unsupported_claim not in page, f"Strona B2B zawiera niepotwierdzone twierdzenie: {unsupported_claim}")

    require(f'href="{B2B_PATH}"' in homepage, "Homepage nie linkuje bezpośrednio do strony B2B")
    require(B2B_URL in sitemap, "Strona B2B nie występuje w sitemap.xml")
    require(B2B_URL in llms, "llms.txt nie wskazuje strony B2B")

    for crawler in ("OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Claude-SearchBot", "Claude-User"):
        block = f"User-agent: {crawler}\nAllow: /"
        require(block in robots, f"robots.txt nie zezwala robotowi {crawler}")

    print("OK: oferta B2B, linkowanie, sitemap, llms.txt i reguły robotów są kompletne")


if __name__ == "__main__":
    main()
