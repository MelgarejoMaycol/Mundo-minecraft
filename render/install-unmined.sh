#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$ROOT_DIR/.unmined"
TMP_DIR="$ROOT_DIR/.unmined-download"
ARCHIVE="/tmp/unmined-cli-linux-x64.tar.gz"
URL="${UNMINED_DOWNLOAD_URL:-https://unmined.net/download/unmined-cli-linux-x64-dev/}"

if [ -x "$TARGET_DIR/unmined-cli" ]; then
  echo "uNmINeD ya esta instalado."
  exit 0
fi

rm -rf "$TARGET_DIR" "$TMP_DIR"
mkdir -p "$TARGET_DIR" "$TMP_DIR"

echo "Descargando uNmINeD CLI Linux x64 desde el sitio oficial..."
curl -fL --retry 5 --retry-delay 3 "$URL" -o "$ARCHIVE"

echo "Extrayendo uNmINeD..."
tar -xzf "$ARCHIVE" -C "$TMP_DIR"

CLI_PATH="$(find "$TMP_DIR" -type f -name 'unmined-cli' | head -n 1)"
if [ -z "$CLI_PATH" ]; then
  echo "No se encontro unmined-cli dentro del paquete descargado." >&2
  exit 1
fi

CLI_DIR="$(dirname "$CLI_PATH")"
cp -R "$CLI_DIR"/. "$TARGET_DIR"/
chmod +x "$TARGET_DIR/unmined-cli"

echo "uNmINeD instalado en $TARGET_DIR"
"$TARGET_DIR/unmined-cli" web help >/dev/null || true
