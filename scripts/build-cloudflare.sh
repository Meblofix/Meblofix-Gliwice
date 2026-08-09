#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"

if [[ "$PROJECT_DIR" == "/" || "$DIST_DIR" != "$PROJECT_DIR/dist" ]]; then
  echo "Nieprawidłowa ścieżka katalogu dist: $DIST_DIR" >&2
  exit 1
fi

copy_file() {
  local source_path="$PROJECT_DIR/$1"
  if [[ ! -f "$source_path" ]]; then
    echo "Brak wymaganego pliku: $1" >&2
    exit 1
  fi
  cp -p -- "$source_path" "$DIST_DIR/$1"
}

copy_directory() {
  local source_path="$PROJECT_DIR/$1"
  if [[ ! -d "$source_path" ]]; then
    echo "Brak wymaganego katalogu: $1" >&2
    exit 1
  fi
  cp -a -- "$source_path" "$DIST_DIR/"
}

rm -rf -- "$DIST_DIR"
mkdir -p -- "$DIST_DIR"

for required_file in index.html 404.html _headers _redirects robots.txt sitemap.xml favicon.ico; do
  copy_file "$required_file"
done

python3 "$PROJECT_DIR/scripts/generate-realizacje.py" \
  --template "$PROJECT_DIR/index.html" \
  --output "$DIST_DIR/index.html"

shopt -s nullglob

icon_files=("$PROJECT_DIR"/icon-*.png)
if ((${#icon_files[@]} == 0)); then
  echo "Nie znaleziono ikon icon-*.png" >&2
  exit 1
fi
for icon_file in "${icon_files[@]}"; do
  cp -p -- "$icon_file" "$DIST_DIR/"
done

for required_directory in blog licencja-zdjec fonts css; do
  copy_directory "$required_directory"
done

service_directories=("$PROJECT_DIR"/montaz-mebli-*)
if ((${#service_directories[@]} == 0)); then
  echo "Nie znaleziono katalogów montaz-mebli-*" >&2
  exit 1
fi
for service_directory in "${service_directories[@]}"; do
  cp -a -- "$service_directory" "$DIST_DIR/"
done

mkdir -p -- "$DIST_DIR/img"
while IFS= read -r -d '' image_file; do
  relative_path="${image_file#"$PROJECT_DIR/"}"
  target_path="$DIST_DIR/$relative_path"
  mkdir -p -- "$(dirname "$target_path")"
  cp -p -- "$image_file" "$target_path"
done < <(find "$PROJECT_DIR/img" -type f ! -path "$PROJECT_DIR/img/realizacje/_surowe/*" -print0)

python3 "$PROJECT_DIR/scripts/test-realizacje.py" --html "$DIST_DIR/index.html"
python3 "$PROJECT_DIR/scripts/test-seo.py" --dist "$DIST_DIR"

FUNCTIONS_TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$FUNCTIONS_TEMP_DIR"' EXIT

(
  cd "$PROJECT_DIR"
  npx --no-install wrangler pages functions build "$PROJECT_DIR/functions" \
    --project-directory "$PROJECT_DIR" \
    --outdir "$FUNCTIONS_TEMP_DIR/_worker.js" \
    --output-routes-path "$FUNCTIONS_TEMP_DIR/_routes.json"
)
cp -a -- "$FUNCTIONS_TEMP_DIR/_worker.js" "$DIST_DIR/_worker.js"
cp -p -- "$FUNCTIONS_TEMP_DIR/_routes.json" "$DIST_DIR/_routes.json"

echo "Cloudflare Pages build gotowy: $DIST_DIR"
echo "Liczba plików: $(find "$DIST_DIR" -type f | wc -l)"
echo "Rozmiar: $(du -sh "$DIST_DIR" | cut -f1)"
