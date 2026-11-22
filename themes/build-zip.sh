#!/usr/bin/env bash
# Package the Mansu Maison theme as an installable ZIP (Appearance → Themes → Add New → Upload Theme).
# Usage: themes/build-zip.sh [output-dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/dist}"
mkdir -p "$out"
version="$(sed -n 's/^Version: *//p' "$here/mansu-maison/style.css" | head -1)"
zipfile="$out/mansu-maison-$version.zip"
rm -f "$zipfile"
(cd "$here" && zip -qr "$zipfile" mansu-maison -x '*.DS_Store' -x 'mansu-maison/README.md')
echo "$zipfile"
