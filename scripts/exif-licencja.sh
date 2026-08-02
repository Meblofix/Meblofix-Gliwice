#!/usr/bin/env bash
#
# Osadza metadane licencyjne XMP w zdjeciach realizacji.
#
# Domyslnie pracuje NA KOPII: pliki zrodlowe pozostaja nietkniete, a wynik
# laduje w katalogu docelowym (domyslnie img-licencja/). Zapis w oryginalach
# wymaga jawnego --in-place i potwierdzenia.
#
# Uzycie:
#   scripts/exif-licencja.sh                    # kopia -> img-licencja/
#   scripts/exif-licencja.sh --out /tmp/zdjecia # kopia -> wskazany katalog
#   scripts/exif-licencja.sh --in-place         # nadpisanie oryginalow (pyta o zgode)
#   scripts/exif-licencja.sh --in-place --yes   # nadpisanie bez pytania (CI)
#   scripts/exif-licencja.sh --check            # tylko podglad obecnych metadanych

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FIRMA="MebloFix Gliwice"
CREDIT="fot. MebloFix Gliwice"
RIGHTS="© MebloFix Gliwice — wykorzystanie komercyjne wymaga pisemnej zgody"
LICENCJA="https://meblofix-gliwice.pl/licencja-zdjec/"

# Katalogi ze zdjeciami galerii (bez _surowe — to nieprzetworzone oryginaly).
KATALOGI=("img/realizacje/sieciowe" "img/realizacje/na-wymiar")

OUT_DIR="$PROJECT_DIR/img-licencja"
IN_PLACE=0
ASSUME_YES=0
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in-place) IN_PLACE=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --check)    CHECK_ONLY=1; shift ;;
    --out)      OUT_DIR="$(readlink -f -- "${2:?--out wymaga sciezki}")"; shift 2 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Nieznany argument: $1" >&2; exit 1 ;;
  esac
done

if ! command -v exiftool >/dev/null 2>&1; then
  echo "Brak exiftool. Instalacja: sudo apt install libimage-exiftool-perl" >&2
  exit 1
fi

for katalog in "${KATALOGI[@]}"; do
  if [[ ! -d "$PROJECT_DIR/$katalog" ]]; then
    echo "Brak katalogu: $katalog" >&2
    exit 1
  fi
done

# --- tryb podgladu ---------------------------------------------------------
if (( CHECK_ONLY )); then
  for katalog in "${KATALOGI[@]}"; do
    exiftool -r -G1 -s \
      -XMP-dc:Creator -XMP-dc:Rights -XMP-photoshop:Credit \
      -XMP-xmpRights:WebStatement -XMP-plus:LicensorURL \
      -ext jpg -ext webp "$PROJECT_DIR/$katalog"
  done
  exit 0
fi

# --- ustalenie celu zapisu -------------------------------------------------
if (( IN_PLACE )); then
  echo "UWAGA: metadane zostana zapisane w ORYGINALACH w:"
  printf '  %s\n' "${KATALOGI[@]}"
  if (( ! ASSUME_YES )); then
    read -r -p "Kontynuowac? [t/N] " odpowiedz
    case "$odpowiedz" in
      t|T|tak|TAK|y|Y|yes) ;;
      *) echo "Przerwano — oryginaly nietkniete."; exit 0 ;;
    esac
  fi
  CELE=()
  for katalog in "${KATALOGI[@]}"; do CELE+=("$PROJECT_DIR/$katalog"); done
else
  if [[ "$OUT_DIR" == "$PROJECT_DIR" || "$OUT_DIR" == "/" ]]; then
    echo "Nieprawidlowy katalog docelowy: $OUT_DIR" >&2
    exit 1
  fi
  echo "Tryb bezpieczny — pracuje na kopii w: $OUT_DIR"
  rm -rf -- "$OUT_DIR"
  mkdir -p -- "$OUT_DIR"
  CELE=()
  for katalog in "${KATALOGI[@]}"; do
    mkdir -p -- "$OUT_DIR/$katalog"
    cp -a -- "$PROJECT_DIR/$katalog/." "$OUT_DIR/$katalog/"
    CELE+=("$OUT_DIR/$katalog")
  done
fi

# --- zapis metadanych ------------------------------------------------------
exiftool -r -overwrite_original -preserve \
  -ext jpg -ext webp \
  -XMP-dc:Creator="$FIRMA" \
  -XMP-dc:Rights="$RIGHTS" \
  -XMP-photoshop:Credit="$CREDIT" \
  -XMP-xmpRights:WebStatement="$LICENCJA" \
  -XMP-plus:LicensorURL="$LICENCJA" \
  "${CELE[@]}"

echo
echo "Gotowe. Kontrola pierwszego pliku:"
pierwszy="$(find "${CELE[0]}" -type f \( -name '*.jpg' -o -name '*.webp' \) | sort | head -n1)"
exiftool -G1 -s \
  -XMP-dc:Creator -XMP-dc:Rights -XMP-photoshop:Credit \
  -XMP-xmpRights:WebStatement -XMP-plus:LicensorURL \
  "$pierwszy"

if (( ! IN_PLACE )); then
  echo
  echo "Oryginaly nietkniete. Aby podmienic je na wersje z metadanymi:"
  for katalog in "${KATALOGI[@]}"; do
    echo "  cp -a \"$OUT_DIR/$katalog/.\" \"$PROJECT_DIR/$katalog/\""
  done
  echo "albo uruchom ponownie z --in-place."
fi
