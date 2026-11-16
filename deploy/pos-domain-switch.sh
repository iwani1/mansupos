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

# Only files Nginx ACTUALLY loads count (from `nginx -T`), so stray copies like
# *.before-proxy are ignored. Among those declaring this host, exactly one may
# proxy it to the port we are leaving (an HTTP->HTTPS redirect block is skipped).
nginx -t >/dev/null 2>&1 || fail "current Nginx config does not pass nginx -t; fix that first"
mapfile -t HOSTFILES < <(nginx -T 2>/dev/null | awk '/^# configuration file /{f=$4; sub(/:$/,"",f)} /server_name[^;]*pos\.mansutrendzgh\.com/{print f}' | sort -u)
[ "${#HOSTFILES[@]}" -ge 1 ] || fail "no loaded Nginx file declares pos.mansutrendzgh.com"
FILES=()
for x in "${HOSTFILES[@]}"; do grep -q "proxy_pass http://127.0.0.1:$FROM" "$x" && FILES+=("$x"); done
if [ "${#FILES[@]}" = 0 ]; then
  for x in "${HOSTFILES[@]}"; do grep -q "proxy_pass http://127.0.0.1:$TO" "$x" && { echo "Already pointing at $TO ($x). Nothing to do."; exit 0; }; done
  fail "no loaded file for pos.mansutrendzgh.com proxies to $FROM (files: ${HOSTFILES[*]}); inspect manually"
fi
[ "${#FILES[@]}" = 1 ] || fail "more than one loaded file proxies pos.mansutrendzgh.com to $FROM: ${FILES[*]}; inspect manually"
F=$(readlink -f "${FILES[0]}")
N=$(grep -c "proxy_pass http://127.0.0.1:$FROM" "$F")
# Show every host this file serves so the operator sees exactly what is affected.
HOSTS=$(grep -oE 'server_name[^;]*' "$F" | sed 's/server_name//' | tr -s ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
echo "Nginx file: $F  (hosts: $HOSTS)  lines to change: $N"

# Keep backups OUT of /etc/nginx so Nginx can never load a second copy of the site.
install -d -m 0700 /root/mansu-nginx-backups
BAK="/root/mansu-nginx-backups/$(basename "$F").before-$1-$(date +%F-%H%M%S)"
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
