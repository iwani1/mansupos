#!/usr/bin/env bash
# One-shot install of the cash-only Retail trading service on the Contabo VPS
# (runbook steps 1-6). Run as root:  sudo bash golive-retail-cash.sh
# It does NOT change Nginx or pos.mansutrendzgh.com; that cutover stays manual
# (runbook step 8). Safe to re-run: existing settings and ledger are kept.
set -euo pipefail

BRANCH=claude/gifted-ramanujan-wt9kjc
REPO=https://github.com/iwani1/mansupos.git
APP=/opt/mansu-pos-live-trading
DATA=/var/lib/mansu-pos-live-trading
ETC=/etc/mansu-pos-live-trading
ENVF=$ETC/pos.env
SVC=mansu-pos-live-trading
USR=mansu-pos-trading

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root (sudo bash $0)"

step "1/7 Checking the server"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)' \
  || fail "Node.js 22.13+ is required (found $(node -v 2>/dev/null || echo none))"
command -v git >/dev/null || fail "git is not installed"
[ -x /usr/bin/node ] || fail "the service runs /usr/bin/node, which is missing (Node is at $(command -v node)); link or install it there first"
# Never collide with another application: port 3188 must be free or already ours.
if ss -ltnH '( sport = :3188 )' 2>/dev/null | grep -q . && ! systemctl is-active --quiet "$SVC"; then
  fail "port 3188 is used by another program: $(ss -ltnpH '( sport = :3188 )' | head -1). Nothing was changed."
fi
systemctl is-active --quiet mansu-pos-live-pilot && echo "Read-only pilot is running (kept as rollback)." \
  || echo "Note: read-only pilot service is not running."

step "2/7 Backing up Nginx config and pilot data"
BK=/root/mansu-golive-backup-$(date +%F-%H%M); mkdir -p "$BK"
nginx -T >"$BK/nginx-full-before.txt" 2>&1 || true
for f in $(grep -rl "pos.mansutrendzgh.com" /etc/nginx/ 2>/dev/null || true); do cp -a "$f" "$BK/$(echo "$f" | tr / _).before"; done
[ -d /var/lib/mansu-pos-live-pilot ] && tar -czf "$BK/pilot-data.tgz" /var/lib/mansu-pos-live-pilot /etc/mansu-pos-live-pilot 2>/dev/null || true
echo "Backups in $BK"

step "3/7 Installing the trading code ($BRANCH)"
id "$USR" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin "$USR"
install -d -o "$USR" -g "$USR" -m 0700 "$DATA"
install -d -o "$USR" -g "$USR" -m 0755 "$APP"
systemctl stop "$SVC" 2>/dev/null || true
if [ -d "$APP/.git" ]; then
  sudo -u "$USR" -H git -C "$APP" fetch origin "$BRANCH"
  sudo -u "$USR" -H git -C "$APP" checkout -B live-retail-cash FETCH_HEAD
else
  [ -z "$(ls -A "$APP")" ] || fail "$APP exists but is not a git checkout; inspect it first"
  sudo -u "$USR" -H git clone --single-branch --branch "$BRANCH" "$REPO" "$APP"
fi
sudo -u "$USR" -H sh -c "cd '$APP' && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund && npm run build:live && test ! -e dist/demo && npm prune --omit=dev"
echo "Code version: $(sudo -u "$USR" -H git -C "$APP" rev-parse --short HEAD)"

step "4/7 Private settings"
install -d -m 0700 "$ETC"
setv() { KEY="$1" VAL="$2" awk 'BEGIN{k=ENVIRON["KEY"];v=ENVIRON["VAL"];d=0} index($0,k"=")==1{print k"="v;d=1;next}{print} END{if(!d)print k"="v}' "$ENVF" >"$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"; }
if [ -f "$ENVF" ] && grep -q '^WOO_CONSUMER_KEY=ck_' "$ENVF"; then
  echo "Existing $ENVF kept (delete it to re-enter values)."
else
  install -m 0600 "$APP/.env.live-trading.example" "$ENVF"
  PILOT_URL=$(grep -s '^WOO_BASE_URL=' /etc/mansu-pos-live-pilot/pos.env | cut -d= -f2- || true)
  read -rp "Shop (WooCommerce) URL, NOT the POS address [${PILOT_URL:-https://www.mansutrendzgh.com}]: " v; v=${v:-${PILOT_URL:-https://www.mansutrendzgh.com}}
  [[ $v =~ ^https://(www\.)?mansutrendzgh\.com/?$ ]] || fail "shop URL must be https://mansutrendzgh.com or https://www.mansutrendzgh.com (got: $v)"; setv WOO_BASE_URL "${v%/}"
  read -rp "NEW Read/Write WooCommerce consumer key (ck_...): " v; [[ $v == ck_* ]] || fail "key must start with ck_"; setv WOO_CONSUMER_KEY "$v"
  read -rsp "Consumer secret (cs_..., hidden): " v; echo; [[ $v == cs_* ]] || fail "secret must start with cs_"; setv WOO_CONSUMER_SECRET "$v"
  read -rp "Approval reference [owner-$(date +%F)-cash-retail]: " v; setv POS_OWNER_APPROVAL_REFERENCE "${v:-owner-$(date +%F)-cash-retail}"
  read -rsp "Temporary owner password (12+ chars, hidden): " v; echo; [ ${#v} -ge 12 ] || fail "password too short"; setv POS_OWNER_PASSWORD "$v"
  read -rp "Receipt business name [MansutRENDZGH]: " v; setv POS_BUSINESS_NAME "${v:-MansutRENDZGH}"
  read -rp "Receipt address: " v; setv POS_BUSINESS_ADDRESS "$v"
  read -rp "Receipt phone: " v; setv POS_BUSINESS_PHONE "$v"
  setv POS_OWNER_USERNAME owner; setv POS_WEBSITE_HOLD_MINUTES 60
fi
chown root:root "$ENVF"; chmod 0600 "$ENVF"

step "5/7 Installing the service with cash-only Retail switched on"
install -m 0644 "$APP/deploy/$SVC.service" "$APP/deploy/$SVC-backup.service" "$APP/deploy/$SVC-backup.timer" /etc/systemd/system/
install -d "/etc/systemd/system/$SVC.service.d"
install -m 0644 "$APP/deploy/$SVC.retail-cash.conf" "/etc/systemd/system/$SVC.service.d/retail-cash.conf"
systemctl daemon-reload
systemctl enable --now "$SVC" || { journalctl -u "$SVC" -n 40 --no-pager; fail "service did not start (log above)"; }
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:3188/api/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3188/api/health >/dev/null || { journalctl -u "$SVC" -n 40 --no-pager; fail "service not answering on 3188"; }
echo "health: $(curl -s http://127.0.0.1:3188/api/health)"
READY=$(curl -s http://127.0.0.1:3188/api/ready); echo "ready:  $READY"
echo "$READY" | grep -q '"ok":true' || fail "readiness check failed (see issues above)"

step "6/7 Ledger backups"
systemctl start "$SVC-backup" || fail "first backup failed: journalctl -u $SVC-backup"
systemctl enable --now "$SVC-backup.timer"
ls -1 "$DATA/backups" | tail -3

step "7/7 Done — trading service is running on 127.0.0.1:3188 (not public yet)"
cat <<EOF
Nginx file for the cutover: $(grep -rl "pos.mansutrendzgh.com" /etc/nginx/ 2>/dev/null | head -1 || echo "not found")
Next (go live):  bash $APP/deploy/pos-domain-switch.sh trading
Rollback:        bash $APP/deploy/pos-domain-switch.sh pilot
Rollback info and backups: $BK
EOF
