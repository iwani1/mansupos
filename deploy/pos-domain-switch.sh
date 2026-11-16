#!/usr/bin/env bash
# Point pos.mansutrendzgh.com at the trading POS (port 3188) or back to the
# read-only pilot (port 3187). Run as root:
#   bash pos-domain-switch.sh trading     # go live
#   bash pos-domain-switch.sh pilot       # roll back
# Changes ONLY "proxy_pass http://127.0.0.1:<port>" lines inside the single
# Nginx file that declares server_name pos.mansutrendzgh.com. Other sites and
# applications on the server are not touched. Tests with `nginx -t` and
# restores the original file automatically if anything fails.
set -euo pipefail
fail() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"
case "${1:-}" in
  trading) FROM=3187; TO=3188; WANT='"liveReadOnly":false' ;;
  pilot)   FROM=3188; TO=3187; WANT='"liveReadOnly":true' ;;
  *) fail "usage: bash $0 trading|pilot" ;;
esac

# The target service must be healthy BEFORE the domain points at it.
HEALTH=$(curl -sf "http://127.0.0.1:$TO/api/health") || fail "nothing healthy on 127.0.0.1:$TO; domain left unchanged"
echo "$HEALTH" | grep -q "$WANT" || fail "service on $TO is not the expected one ($HEALTH); domain left unchanged"

# Exactly one Nginx file may declare this host (symlinks resolved, deduplicated).
mapfile -t FILES < <(grep -rlE 'server_name[^;]*\bpos\.mansutrendzgh\.com\b' /etc/nginx/ 2>/dev/null | xargs -r -n1 readlink -f | sort -u)
[ "${#FILES[@]}" = 1 ] || fail "expected one Nginx file for pos.mansutrendzgh.com, found ${#FILES[@]}: ${FILES[*]:-none}"
F=${FILES[0]}
N=$(grep -c "proxy_pass http://127.0.0.1:$FROM" "$F" || true)
if [ "$N" = 0 ]; then
  grep -q "proxy_pass http://127.0.0.1:$TO" "$F" && { echo "Already pointing at $TO. Nothing to do."; exit 0; }
  fail "no 'proxy_pass http://127.0.0.1:$FROM' in $F; inspect it manually"
fi
# Show every host this file serves so the operator sees exactly what is affected.
HOSTS=$(grep -oE 'server_name[^;]*' "$F" | sed 's/server_name//' | tr -s ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
echo "Nginx file: $F  (hosts: $HOSTS)  lines to change: $N"

BAK="$F.before-$1-$(date +%F-%H%M%S)"
cp -a "$F" "$BAK"
sed -i "s#proxy_pass http://127.0.0.1:$FROM#proxy_pass http://127.0.0.1:$TO#g" "$F"
if ! nginx -t 2>&1; then cp -a "$BAK" "$F"; fail "nginx -t failed; original file restored, nothing reloaded"; fi
systemctl reload nginx
sleep 2
PUBLIC=$(curl -s https://pos.mansutrendzgh.com/api/health || true)
if ! echo "$PUBLIC" | grep -q "$WANT"; then
  cp -a "$BAK" "$F"; nginx -t && systemctl reload nginx
  fail "public check did not show the expected service ($PUBLIC); switched back and reloaded"
fi
echo "OK: https://pos.mansutrendzgh.com now serves port $TO -> $PUBLIC"
echo "Saved original: $BAK"
