#!/usr/bin/env bash
set -euo pipefail
# Run from the application root. Example cron:
# 15 * * * * cd /opt/mansu-pos && /opt/mansu-pos/deploy/backup.sh /var/backups/mansu-pos >> /var/log/mansu-pos-backup.log 2>&1
DEST="${1:-/var/backups/mansu-pos}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$DEST"
chmod 700 "$DEST"
npm run backup -- "$DEST"
find "$DEST" -maxdepth 1 -type f -name 'pos-*.db' -mtime +"$RETENTION_DAYS" -delete
echo "Backup complete. Retention: ${RETENTION_DAYS} days. Remember: WordPress files/database need separate backups."
