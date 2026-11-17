#!/usr/bin/env bash
# Make an ENCRYPTED copy of the newest verified POS backup, ready to download
# and keep off this server. It checks the backup first (restore drill), then
# packs the .db and its .manifest.json together and encrypts them with a
# passphrase you type (GnuPG, AES-256). The passphrase is never stored.
#
#   bash deploy/export-backup.sh [BACKUP_DIR] [OUTPUT_DIR]
#
# Defaults: BACKUP_DIR=/var/lib/mansu-pos-live-trading/backups, OUTPUT_DIR=/root/pos-exports
# Decrypt later (any computer with GnuPG / Gpg4win):
#   gpg -d pos-backup-....tar.gpg | tar -x
set -euo pipefail
umask 077
BACKUP_DIR="${1:-/var/lib/mansu-pos-live-trading/backups}"
OUT_DIR="${2:-/root/pos-exports}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v gpg >/dev/null || { echo 'gpg is not installed (apt-get install -y gnupg). Nothing was exported.' >&2; exit 1; }
[[ -d "$BACKUP_DIR" ]] || { echo "Backup folder not found: $BACKUP_DIR" >&2; exit 1; }

# Newest snapshot that has its manifest beside it.
latest=''
while IFS= read -r file; do
  if [[ -f "$file.manifest.json" ]]; then latest="$file"; break; fi
done < <(ls -1t "$BACKUP_DIR"/pos-*.db 2>/dev/null || true)
[[ -n "$latest" ]] || { echo "No verified backup (.db with .db.manifest.json) in $BACKUP_DIR" >&2; exit 1; }

echo "Checking $latest ..."
node "$HERE/server/restore-drill.js" "$latest"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
out="$OUT_DIR/$(basename "$latest" .db).tar.gpg"
[[ ! -e "$out" ]] || { echo "Already exported: $out" >&2; exit 0; }
tar -C "$(dirname "$latest")" -cf - "$(basename "$latest")" "$(basename "$latest").manifest.json" \
  | gpg --symmetric --cipher-algo AES256 --pinentry-mode loopback --output "$out"
echo
echo "Encrypted copy: $out"
echo "Download it to your own computer, then delete it here:"
echo "  scp root@SERVER:$out ."
echo "Keep the passphrase somewhere safe and separate (a password manager). Without it the copy cannot be opened."
