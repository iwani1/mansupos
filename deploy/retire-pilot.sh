#!/usr/bin/env bash
# Switch off the old read-only pilot once the trading POS is trusted.
# Run as root:  bash retire-pilot.sh
# Keeps the pilot's files and data; undo with: systemctl enable --now mansu-pos-live-pilot
set -euo pipefail
fail() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"
curl -s https://pos.mansutrendzgh.com/api/health | grep -q '"liveReadOnly":false' \
  || fail "pos.mansutrendzgh.com is not serving the trading POS; the pilot was left running"
for unit in mansu-pos-live-pilot-backup.timer mansu-pos-live-pilot.service; do
  systemctl list-unit-files "$unit" >/dev/null 2>&1 && systemctl disable --now "$unit" 2>/dev/null || true
done
systemctl is-active --quiet mansu-pos-live-pilot && fail "pilot is still running" || true
echo "OK: read-only pilot stopped and disabled. Its key can now be revoked in WooCommerce."
echo "Note: 'pos-domain-switch.sh pilot' no longer works as a rollback. To lock selling instead:"
echo "  rm /etc/systemd/system/mansu-pos-live-trading.service.d/retail-cash.conf && systemctl daemon-reload && systemctl restart mansu-pos-live-trading"
