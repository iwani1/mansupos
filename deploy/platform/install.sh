#!/usr/bin/env bash
# Mansu POS platform: install or upgrade on Ubuntu 24.04 (or Debian 12).
#
#   sudo deploy/platform/install.sh install mansupos.com   first time, from a checkout of this repository
#   sudo deploy/platform/install.sh upgrade                new code: backs up, rebuilds, restarts, checks
#   sudo deploy/platform/install.sh status                 is it running, and what still needs doing
#
# Safe to run again: it never overwrites the settings file, the master key or
# any data. It does not open firewall ports or get the certificate for you
# (the wildcard certificate needs your DNS provider); it tells you what to do.
set -euo pipefail

APP=/opt/mansu-platform
DATA=/var/lib/mansu-platform
ETC=/etc/mansu-platform
ENV_FILE=$ETC/platform.env
USER_NAME=mansu-platform
UNIT=mansu-platform
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
NODE_MAJOR=22

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mxx %s\033[0m\n' "$*" >&2; exit 1; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."
[ -f "$SRC/server/platform/index.js" ] || die "Run this from a checkout of the Mansu POS repository."

install_packages() {
  say "System packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg nginx rsync sqlite3 >/dev/null
  local have=0
  # The service runs /usr/bin/node, so that is the one that must be new enough.
  if [ -x /usr/bin/node ]; then have=$(/usr/bin/node -p 'process.versions.node.split(".").map(Number).reduce((a,b,i)=>i<2?a*1000+b:a,0)'); fi
  if [ "$have" -lt 22013 ]; then
    say "Node.js $NODE_MAJOR (NodeSource, signed apt repository)"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
  fi
  [ -x /usr/bin/node ] || die "Node.js did not install at /usr/bin/node (the service file uses that path)."
  echo "node $(/usr/bin/node -v)"
}

create_user_and_dirs() {
  say "Service account and folders"
  id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
  install -d -m 0755 -o root -g root "$APP"
  install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$DATA"
  install -d -m 0750 -o root -g "$USER_NAME" "$ETC"
}

deploy_code() {
  say "Code from $SRC (commit $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown))"
  local stage
  stage=$(mktemp -d /opt/.mansu-platform-build.XXXXXX)
  rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude 'data/' --exclude 'test-results/' --exclude '*.db' "$SRC/" "$stage/"
  # The Electron till is a dev dependency: no need to download its runtime here.
  (cd "$stage" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error && npm run build:live --silent && npm prune --omit=dev --no-audit --no-fund --loglevel=error)
  [ -f "$stage/dist/index.html" ] || die "Web build missing; nothing was changed."
  chown -R root:root "$stage" && chmod -R go-w "$stage"
  # Swap in one step, keeping the previous release for a quick roll-back.
  rm -rf "$APP.previous"
  [ -d "$APP" ] && mv "$APP" "$APP.previous"
  mv "$stage" "$APP"
  chmod 0755 "$APP"
}

write_settings() {
  if [ -f "$ENV_FILE" ]; then say "Settings: keeping existing $ENV_FILE"; return; fi
  say "Settings: creating $ENV_FILE with a new master key"
  local key
  key=$(openssl rand -hex 32)
  sed -e "s/^PLATFORM_BASE_DOMAIN=.*/PLATFORM_BASE_DOMAIN=$DOMAIN/" -e "s/^PLATFORM_MASTER_KEY=.*/PLATFORM_MASTER_KEY=$key/" \
    -e "s/@mansupos\.com/@$DOMAIN/g" "$SRC/deploy/platform/platform.env.example" > "$ENV_FILE"
  chown root:"$USER_NAME" "$ENV_FILE" && chmod 0640 "$ENV_FILE"
  warn "Save PLATFORM_MASTER_KEY from $ENV_FILE in your password manager NOW. Without it, no backup's store keys can be read."
}

install_service() {
  say "systemd service"
  install -m 0644 "$SRC/deploy/platform/mansu-platform.service" /etc/systemd/system/$UNIT.service
  # Admin commands run as the service account with the same settings:
  #   sudo mansu-platform list | backup | invite-create ... | restore ...
  cat > /usr/local/bin/mansu-platform <<WRAP
#!/bin/sh
cd $APP || exit 1
exec runuser -u $USER_NAME -- env NODE_ENV=production PLATFORM_DATA_DIR=$DATA NODE_NO_WARNINGS=1 /usr/bin/node --env-file=$ENV_FILE server/platform/cli.js "\$@"
WRAP
  chmod 0755 /usr/local/bin/mansu-platform
  systemctl daemon-reload
  systemctl enable $UNIT >/dev/null
}

install_nginx() {
  local domain cert
  domain=$(env_value PLATFORM_BASE_DOMAIN)
  cert=/etc/letsencrypt/live/$domain/fullchain.pem
  say "nginx for $domain and *.$domain"
  if [ ! -f "$cert" ]; then
    warn "No certificate at $cert yet. Get a wildcard certificate with your DNS provider's certbot plugin, e.g.:"
    warn "  apt-get install certbot python3-certbot-dns-cloudflare   # or your provider's plugin"
    warn "  certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.cf.ini -d $domain -d '*.$domain'"
    warn "Then run this script again. nginx is not configured until then."
    return
  fi
  local conf=/etc/nginx/sites-available/mansu-platform.conf link=/etc/nginx/sites-enabled/mansu-platform.conf was_enabled=no
  [ -L "$link" ] && was_enabled=yes
  rm -f "$conf.previous"; [ -f "$conf" ] && cp "$conf" "$conf.previous"
  local ipv6=(-e '')
  # Servers without IPv6 cannot listen on [::]; leave those lines out there.
  [ -s /proc/net/if_inet6 ] || ipv6=(-e '/listen \[::\]/d')
  sed -e "s/mansupos\.com/$domain/g" "${ipv6[@]}" "$SRC/deploy/platform/nginx-platform.conf" > "$conf"
  ln -sf "$conf" "$link"
  if ! nginx -t 2>/tmp/mansu-nginx-test.log; then
    cat /tmp/mansu-nginx-test.log >&2
    # Never leave nginx unable to reload: put back what was there before.
    if [ -f "$conf.previous" ]; then mv "$conf.previous" "$conf"; else rm -f "$conf"; fi
    [ "$was_enabled" = yes ] || rm -f "$link"
    die "The nginx configuration did not pass 'nginx -t'; nginx was left as it was."
  fi
  rm -f "$conf.previous"
  # The default site would answer for unknown names; this config covers the domain.
  rm -f /etc/nginx/sites-enabled/default
  systemctl reload nginx || systemctl restart nginx
}

missing_settings() {
  local missing=()
  [ "$(env_value PLATFORM_MAIL_DRIVER)" = resend ] && [ -z "$(env_value PLATFORM_RESEND_API_KEY)" ] && missing+=("PLATFORM_RESEND_API_KEY (or set PLATFORM_MAIL_DRIVER=outbox for now)")
  [ -z "$(env_value PLATFORM_PAYSTACK_SECRET_KEY)" ] && warn "PLATFORM_PAYSTACK_SECRET_KEY is empty: online payment stays off until you add it."
  printf '%s\n' "${missing[@]}"
}

health() {
  local domain
  domain=$(env_value PLATFORM_BASE_DOMAIN)
  for _ in $(seq 1 20); do
    if curl -fsS -H "Host: $domain" http://127.0.0.1:3100/api/signup/config >/dev/null 2>&1; then echo "Platform answers on 127.0.0.1:3100."; return 0; fi
    sleep 1
  done
  return 1
}

start_service() {
  local missing
  missing=$(missing_settings)
  if [ -n "$missing" ]; then
    warn "Not starting yet. Fill in $ENV_FILE:"; printf '   - %s\n' "$missing" >&2
    warn "Then: systemctl start $UNIT && sudo $0 status"
    return
  fi
  say "Starting"
  systemctl restart $UNIT
  health || { journalctl -u $UNIT -n 30 --no-pager; die "The platform did not come up."; }
}

status() {
  say "Status"
  systemctl is-active --quiet $UNIT && echo "Service: running" || echo "Service: NOT running (journalctl -u $UNIT -n 50)"
  [ -f "$ENV_FILE" ] && echo "Base domain: $(env_value PLATFORM_BASE_DOMAIN)" && echo "Sign-up: $(env_value PLATFORM_SIGNUP_MODE) · mail: $(env_value PLATFORM_MAIL_DRIVER)"
  health >/dev/null && echo "Health: OK" || echo "Health: no answer on 127.0.0.1:3100"
  [ -f /etc/nginx/sites-enabled/mansu-platform.conf ] && echo "nginx: configured" || echo "nginx: not configured (certificate missing?)"
  local backups
  backups=$(ls -1d "$DATA"/backups/*/ 2>/dev/null | tail -n1 || true)
  echo "Latest backup: ${backups:-none yet} (copy $DATA/backups off this server)"
  echo
  echo "Still to do by hand, if not done:"
  echo " - Console admin:   sudo mansu-platform admin-create --username <you>   (type a password, Enter; add the secret to an authenticator app)"
  echo " - Paystack:        webhook URL https://$(env_value PLATFORM_BASE_DOMAIN)/api/paystack/webhook, then: sudo mansu-platform billing-sync-plans"
  echo " - Firewall:        allow 22, 80, 443 only (e.g. ufw allow OpenSSH; ufw allow 'Nginx Full'; ufw enable)"
  echo " - Off-server copy of $DATA/backups, and the master key in your password manager"
}

case "${1:-}" in
  install)
    DOMAIN=${2:-}
    [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "Usage: $0 install <base domain, e.g. mansupos.com>"
    install_packages; create_user_and_dirs; deploy_code; write_settings; install_service; install_nginx; start_service; status ;;
  upgrade)
    [ -f "$ENV_FILE" ] || die "Not installed yet: run '$0 install <domain>' first."
    if systemctl is-active --quiet $UNIT; then say "Backup before upgrading"; /usr/local/bin/mansu-platform backup; fi
    install_nginx   # first: if nginx would fail, nothing else has changed yet
    deploy_code; install_service
    say "Restarting"; systemctl restart $UNIT
    if ! health; then
      warn "New version did not come up; rolling back to the previous release."
      rm -rf "$APP.failed"; mv "$APP" "$APP.failed"; mv "$APP.previous" "$APP"
      systemctl restart $UNIT; health || die "Previous release did not come up either: journalctl -u $UNIT -n 50"
      die "Upgrade rolled back. The failed build is in $APP.failed."
    fi
    status ;;
  status) status ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
