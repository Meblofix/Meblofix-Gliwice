#!/usr/bin/env python3
"""Wstawia do zbudowanego HTML publiczne stawki z jednego configu."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "data" / "cennik.json"


def money(value: float, *, hourly: bool = False) -> str:
    amount = f"{value:.2f}".replace(".", ",") if value % 1 else str(int(value))
    return f"{amount} zł/h" if hourly else f"{amount} zł"


def replacements(config: dict) -> dict[str, str]:
    rates = config["publicRates"]
    travel = rates["travel"]
    rate = money(travel["outsideGliwicePerKilometer"])
    one_installer_two_hours = max(rates["minimumJob"], rates["hourlyOneInstaller"] * 2)
    two_installers_two_hours = max(rates["minimumJob"], rates["hourlyTwoInstallers"] * 2)
    travel_ten_kilometers = (
        travel["outsideGliwicePerKilometer"]
        * travel["roundTripMultiplier"]
        * 10
    )
    return {
        "[[MINIMUM_JOB]]": money(rates["minimumJob"]),
        "[[HOURLY_ONE]]": money(rates["hourlyOneInstaller"], hourly=True),
        "[[HOURLY_TWO]]": money(rates["hourlyTwoInstallers"], hourly=True),
        "[[FREE_ESTIMATE]]": money(rates["estimate"]),
        "[[MINIMUM_JOB_NUMBER]]": str(rates["minimumJob"]),
        "[[HOURLY_ONE_NUMBER]]": str(rates["hourlyOneInstaller"]),
        "[[HOURLY_TWO_NUMBER]]": str(rates["hourlyTwoInstallers"]),
        "[[TRAVEL_RATE]]": f"{rate}/km",
        "[[EXAMPLE_ONE_TWO_HOURS]]": money(one_installer_two_hours),
        "[[EXAMPLE_TWO_TWO_HOURS]]": money(two_installers_two_hours),
        "[[EXAMPLE_TRAVEL_TEN_KM]]": money(travel_ten_kilometers),
        "[[TRAVEL_RULE]]": (
            f"Dojazd poza Gliwicami kosztuje {rate} za kilometr liczony "
            f"w obie strony."
        ),
        "[[TRAVEL_RULE_LOWER]]": (
            f"dojazd poza Gliwicami kosztuje {rate} za kilometr liczony "
            f"w obie strony."
        ),
    }


def render_document(document: str, config: dict) -> str:
    for marker, value in replacements(config).items():
        document = document.replace(marker, value)
    return document


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    rendered = 0
    for html_path in sorted(args.dist.rglob("*.html")):
        source = html_path.read_text(encoding="utf-8")
        output = render_document(source, config)
        if output != source:
            html_path.write_text(output, encoding="utf-8")
            rendered += 1
    leftovers = []
    for html_path in sorted(args.dist.rglob("*.html")):
        if "[[" in html_path.read_text(encoding="utf-8"):
            leftovers.append(str(html_path.relative_to(args.dist)))
    if leftovers:
        raise ValueError("Niewypełnione markery configu: " + ", ".join(leftovers))
    print(f"Wstawiono publiczny cennik do {rendered} plików HTML")


if __name__ == "__main__":
    main()
