# MansuPOS cash-only Retail launch — single public POS host

**Release state: HOLD — engineering review, not permission to activate checkout.**
Last updated: 2026-11-16 (Africa/Accra). Owner conditionally authorized final readiness checks and **one supervised real cash transaction only after all safeguards pass**.

## Fixed deployment constraints

- Sole POS domain: `https://pos.mansutrendzgh.com`; **no staging website, no second public domain**.
- Public current pilot: Contabo systemd `mansu-pos-live-pilot.service`, loopback `127.0.0.1:3187`, read-only, separate ledger identity `live-pilot`. Do not modify its env, Woo read key or ledger.
- Preinstalled distinct potential live trading service: `mansu-pos-live-trading.service`, loopback `127.0.0.1:3188`, separate ledger identity `live-trading`, code at `/opt/mansu-pos-live-trading`; its `/api/health` is 200 and `/api/ready` 503 while write gates are false. Port 3188's existence is **not** checkout readiness.
- WordPress/WooCommerce/Paystack remain on GreenGeeks; online Paystack checkout must not be interrupted. Owner reports WP 7.1.4, Woo 11.0.1, Paystack 5.8.6, PHP 8.4.27, HPOS on, stock management on, 60-minute online hold, Saved Cards enabled.
- Scope: **cash-only Retail**, one supervised operator and only reconciled Woo goods initially. Wholesale and historical 1,571 POS-source records stay locked. No POS-local inventory deduction for Woo goods.
- User reported verified off-host WordPress backup and tested recovery; encrypted trading-ledger backup transfer/readability was reported. Isolated trading-ledger restore from the off-host backup remains unproven.

## Why checkout is still blocked

Automated CI and disposable real-Woo 11.0.1 / Paystack 5.8.6 source tests pass for PR #4, including synthetic signed webhook/return and same-last-unit races. Test log explicitly emits `PAYSTACK_RELEASE_BLOCKED`: an externally settled token payment could still be acknowledged while Woo rejects fulfillment; installed site callbacks, refunds and real settlement are not verified. The uninstalled `woocommerce/mansu-online-bridge/mansu-online-bridge.php` is `0.2.0-dev`, has fixture `MANSU_ONLINE_HOLD_MINUTES=10` without approved operational policy, and deliberately reports `lateGatewayGuardVerified=false`. **Never edit the Boolean to make the readiness page green**.

## Release gate A — engineering signoff (all required)

- [ ] Independently review Phase 2 draft PR #1 and Paystack safeguard PR #4; resolve P0 findings, review and record immutable release commit.
- [ ] Fully reconcile already-settled gateway success versus rejected Woo payment, including saved card and a safe Owner/Manager incident path: no second charge, false paid status, automatic refund or fulfillment. Verify installed Paystack v5.8.6 signed webhook and return behavior under PHP 8.4.27/HPOS. `lateGatewayGuardVerified` must only become true after **actual evidence**, never by forcing a flag.
- [ ] Approve documented in-store reservation duration and reserve/release/expiry/cancel/idempotent-retry semantics. A website 60-minute Hold stock setting is not automatically a POS rule. Confirm exact Woo table/hook behavior and installed theme/plugin interactions.
- [ ] Inspect live shop side effects **read-only**, including Woo email, order notification, shipping, marketing, payment hooks and audit; agree who receives pending, paid, cancelled and review-required alerts. Do not send synthetic orders or emails on production.
- [ ] Confirm POS-cash order tax, gross, receipt business details and stock reduction under actual Woo settings; keep backorders disabled and stock owner stable.
- [ ] Owner/manager witness a **verified isolated recovery** of the trading ledger from secured off-Contabo archive. Do not run `server/restore.js` against either active volume; never replace a ledger with older transactions.
- [ ] Review dedicated production plugin package, scope/secret/role bindings and rollback of code **without** rolling back new sales. Obtain installation-specific owner approval after evidence has passed.

## Release gate B — LYSA available-to-promise safety (all required)

- [x] Owner reports physical count of LYSA S/M/L = 1/1/1, total three pieces.
- [x] Woo editor screenshots show S ID 10624, M ID 10625, L ID 10623, each individually managed quantity 1, enabled, no backorders, regular price GHS 490.
- [ ] Verify there are no unreviewed additional sellable variations and parent-managed variants; a parent quantity of 3 is **not additional** to individually managed variation units.
- [ ] Check current outstanding Woo checkout reservation rows and other orders **for each exact stock owner**. Use an authorized read-only integration or redacted database query run by an administrator; owner should not need repeated manual phpMyAdmin work. Fail closed if quantity is reserved.
- [ ] Confirm Woo canonical variation IDs (not apparently similar SKU strings) uniquely identify each sellable size; the source screenshots show similar SKU strings and do not verify mapping.
- [ ] Reconfirm physical one-piece-per-size stock and sellable price immediately before a genuine supervised sale; cancel if anything changed.

## Release gate C — tightly controlled supervised acceptance

Only after A and B are both accepted, document: shop operator, Owner observer, one actual buyer, single real LYSA variation, real full cash, expected tax/gross, shipping/pickup rule, receipt and notification recipients, recovery contact and stop condition. Explicitly approve reviewed live plugin installation and selected gates in the **separate trading service only**; test signed bridge health/ledger identity before checkout, never borrow pilot credentials. Observe one order end-to-end: cash-count → Woo order total and exact variation → one paid confirmation → one Woo stock decrement → POS ledger and printed/customer receipt → notification/fulfilment side effects. No repeat payment on timeout or uncertain response. Staff rollout remains locked until accepted.

## Release gate D — one-domain Nginx cutover and rollback

Only after supervised acceptance and final owner release authorization:

1. Save a private snapshot of the existing Nginx virtual host and `nginx -T` configuration. Verify the existing public POS is still read-only on 3187 and the trading app is loopback-only on 3188. Never touch the unrelated app on port 3000.
2. Change **only** the upstream for the existing `pos.mansutrendzgh.com` location from `127.0.0.1:3187` to `127.0.0.1:3188`. Do not create DNS/TLS hosts.
3. Run `nginx -t`; abort if it fails. Reload Nginx only after success. Confirm HTTPS TLS and trading service identity and complete a read-only product view before granting general staff access.
4. If a regression occurs: disable **trading** new writes, preserve all live Woo orders and trading ledger transactions; restore the saved upstream config, `nginx -t`, and reload. Do **not** restore old databases over new transactions. Escalate uncertain paid orders to Owner for manual reconciliation.

## Current decision record

**HOLD checkout and public cutover** until the release gates are evidenced and an independent reviewer signs off. The owner's conditional approval is permission to work through the gates, not evidence that they passed. Record pass/fail evidence and specific unresolved risk on issue #3. Do not request passwords, Woo keys, customer records, payment IDs or unredacted private backups in chat or GitHub.

Related: [Production issue #3](https://github.com/iwani1/mansupos/issues/3), [foundation PR #1](https://github.com/iwani1/mansupos/pull/1), [saved-card code review PR #4](https://github.com/iwani1/mansupos/pull/4).
