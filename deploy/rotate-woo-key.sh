#!/usr/bin/env bash
# Replace the trading service's WooCommerce API key. Run as root on the VPS:
#   bash rotate-woo-key.sh
# The new key is tested against the store BEFORE anything is changed.
set -euo pipefail
ENVF=/etc/mansu-pos-live-trading/pos.env; SVC=mansu-pos-live-trading
fail() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"; [ -f "$ENVF" ] || fail "$ENVF not found"
URL=$(grep '^WOO_BASE_URL=' "$ENVF" | cut -d= -f2-)
read -rp "NEW Read/Write consumer key (ck_...): " K; [[ $K == ck_* ]] || fail "key must start with ck_"
read -rsp "NEW consumer secret (cs_..., hidden): " S; echo; [[ $S == cs_* ]] || fail "secret must start with cs_"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "$K:$S" "$URL/wp-json/wc/v3/orders?per_page=1")
[ "$CODE" = 200 ] || fail "the store rejected this key (HTTP $CODE). Nothing was changed."
cp -a "$ENVF" "$ENVF.before-key-rotation"; chmod 0600 "$ENVF.before-key-rotation"
setv() { KEY="$1" VAL="$2" awk 'BEGIN{k=ENVIRON["KEY"];v=ENVIRON["VAL"];d=0} index($0,k"=")==1{print k"="v;d=1;next}{print} END{if(!d)print k"="v}' "$ENVF" >"$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"; }
setv WOO_CONSUMER_KEY "$K"; setv WOO_CONSUMER_SECRET "$S"; chown root:root "$ENVF"; chmod 0600 "$ENVF"
systemctl restart "$SVC"
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:3188/api/ready >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3188/api/ready | grep -q '"ok":true' || { cp -a "$ENVF.before-key-rotation" "$ENVF"; systemctl restart "$SVC"; fail "service not ready with the new key; old settings restored"; }
rm -f "$ENVF.before-key-rotation"
echo "OK: trading service is running on the new key. Now revoke the old key in WooCommerce > Settings > Advanced > REST API."
