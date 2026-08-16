#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"

if [[ ! -d "$DIST_DIR" || "$DIST_DIR" != "$PROJECT_DIR/dist" ]]; then
  echo "Brak prawidłowego katalogu dist: $DIST_DIR" >&2
  exit 1
fi

for required_file in index.html _worker.js/index.js _routes.json; do
  if [[ ! -f "$DIST_DIR/$required_file" ]]; then
    echo "Brak wymaganego pliku dist/$required_file" >&2
    exit 1
  fi
done

for forbidden_file in data/realizacje.json data/cennik.json; do
  if [[ -e "$DIST_DIR/$forbidden_file" ]]; then
    echo "Niedozwolony plik w artefakcie: dist/$forbidden_file" >&2
    exit 1
  fi
done

forbidden_found=0
while IFS= read -r -d '' forbidden_path; do
  echo "Niedozwolona zawartość w artefakcie: ${forbidden_path#"$PROJECT_DIR/"}" >&2
  forbidden_found=1
done < <(
  find "$DIST_DIR" \
    \( -name '.env' \
    -o -name '.env.*' \
    -o -name '.git' \
    -o -name 'assets' \
    -o -name 'node_modules' \
    -o -name 'tests' \
    -o -name '*Zone.Identifier*' \) \
    -print0
)

if ((forbidden_found)); then
  exit 1
fi

echo "Kontrola dist: wymagane pliki istnieją, brak danych źródłowych i zawartości wrażliwej."
