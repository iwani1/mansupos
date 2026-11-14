#!/usr/bin/env bash
set -euo pipefail
# Generic legacy backup wrapper. The role-specific pilot/trading units invoke
# server/backup.js directly. Do not prune historical data by default: retention
# requires an explicit operator decision AFTER off-host copies are verified.
DEST="${1:-/var/backups/mansu-pos}"
RETENTION_DAYS="${RETENTION_DAYS:-}"
if [[ -n "$RETENTION_DAYS" && ! "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo 'RETENTION_DAYS must be a positive integer; no backups were pruned.' >&2
  exit 1
fi
mkdir -p "$DEST"
chmod 700 "$DEST"
npm run backup -- "$DEST"
if [[ -z "$RETENTION_DAYS" ]]; then
  echo 'Backup complete. No local pruning: preserve the .db and .db.manifest.json together until off-host backup/retention is approved.'
else
  # A pre-v9 backup without a manifest must be kept for manual provenance
  # review. Only delete a manifested backup pair when retention is explicit.
  while IFS= read -r -d '' file; do
    manifest="${file}.manifest.json"
    if [[ -f "$manifest" ]]; then
      rm -- "$file" "$manifest"
    else
      echo "Retaining legacy/incomplete backup without manifest for review: $file" >&2
    fi
  done < <(find "$DEST" -maxdepth 1 -type f -name 'pos-*.db' -mtime +"$RETENTION_DAYS" -print0)
  echo "Backup complete. Explicit local retention: $RETENTION_DAYS days. Confirm encrypted off-host copies and separate WordPress backups."
fi
