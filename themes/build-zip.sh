#!/usr/bin/env bash
# Package a Mansu theme as an installable ZIP (Appearance → Themes → Add New → Upload Theme).
# Usage: themes/build-zip.sh [theme-folder] [output-dir]
#   themes/build-zip.sh                 → mansu-maison
#   themes/build-zip.sh mansu-rose      → mansu-rose
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
theme="${1:-mansu-maison}"
out="${2:-$here/dist}"
test -f "$here/$theme/style.css" || { echo "No theme at $here/$theme" >&2; exit 1; }
mkdir -p "$out"
version="$(sed -n 's/^Version: *//p' "$here/$theme/style.css" | head -1)"
zipfile="$out/$theme-$version.zip"
test ! -e "$zipfile" || mv -f "$zipfile" "$zipfile.old"
(cd "$here" && zip -qr "$zipfile" "$theme" -x '*.DS_Store' -x "$theme/README.md")
echo "$zipfile"
