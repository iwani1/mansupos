# Documentation index

## Current

- [adr/0001-woocommerce-owns-stock.md](adr/0001-woocommerce-owns-stock.md) — Decision: WooCommerce is the only owner of stock
- [ARCHITECTURE.md](ARCHITECTURE.md) — How checkout, WooCommerce and the ledger fit together
- [BACKUP-AND-RESTORE-DRILL.md](BACKUP-AND-RESTORE-DRILL.md) — Monthly restore drill and encrypted off-server backup copies
- [DAILY-STAFF-OPERATIONS.md](DAILY-STAFF-OPERATIONS.md) — Staff task checklists
- [HARDWARE.md](HARDWARE.md) — Scanner, printer, drawer
- [INSTALLABLE-WEB-APP.md](INSTALLABLE-WEB-APP.md) — Installing the web app on a device
- [INVENTORY-MANAGEMENT.md](INVENTORY-MANAGEMENT.md) — Stock control: receive, remove, count and re-price shared website + shop stock
- [MONITORING.md](MONITORING.md) — Uptime alert for the POS and website
- [OPERATIONS.md](OPERATIONS.md) — Daily use: shifts, sales, reconciliation
- [OWNER-AUDIT-ACTIVITY.md](OWNER-AUDIT-ACTIVITY.md) — Owner audit history screen
- [CUSTOMER-RETURNS.md](CUSTOMER-RETURNS.md) — Returns from POS sales: Woo refund, cash out on the shift, restock choice
- [PLATFORM.md](PLATFORM.md) — Multi-shop SaaS platform (phases 1–5): isolation, sign-up, store connection, billing, console, multi-shop Windows till, backups, invitations, email, reminders, feedback, pilot health, deployment
- [PURCHASING.md](PURCHASING.md) — Suppliers, purchase orders, receiving deliveries, reorder list and stock value at cost
- [PRODUCT-MANAGEMENT.md](PRODUCT-MANAGEMENT.md) — Add and edit website products (photos, sizes, colours) from the POS
- [PRIVATE-WHOLESALE-PRICES.md](PRIVATE-WHOLESALE-PRICES.md) — Wholesale price defaults (feature locked)
- [REFUND-PROCEDURE.md](REFUND-PROCEDURE.md) — How to refund a sale until the POS has a return screen
- [RETAIL-CASH-GO-LIVE-RUNBOOK.md](RETAIL-CASH-GO-LIVE-RUNBOOK.md) — Install, update, switch-over, first sale and rollback for the live service
- [SECURITY.md](SECURITY.md) — Accounts, sessions, secrets
- [TAX-DECISION.md](TAX-DECISION.md) — Open tax question and checklist for the tax adviser
- [UI-DESIGN.md](UI-DESIGN.md) — Visual design notes
- [WEEKLY-STAFF-SCORECARD.md](WEEKLY-STAFF-SCORECARD.md) — Weekly staff review
- [WINDOWS-ONLINE-TILL.md](WINDOWS-ONLINE-TILL.md) — Mansu POS for Windows: the online till app, installer and shop-PC acceptance checklist
- [WORKSPACE-REDESIGN.md](WORKSPACE-REDESIGN.md) — Workspace layout

## Windows training and test apps (QA only, unsigned)

CI copies these into the matching installer bundles. The selling till is [WINDOWS-ONLINE-TILL.md](WINDOWS-ONLINE-TILL.md) above.

- [POS-PRACTICE-TRIAL.md](POS-PRACTICE-TRIAL.md) — Offline practice till for staff training
- [HARDWARE-TEST.md](HARDWARE-TEST.md) — Printer / scanner / drawer test app

## Archive — [archive/](archive/) (superseded plans, audits and locked features)

Kept for the record; Git history has every earlier version. These describe approaches that were not taken or gates that no longer apply; do not follow their instructions on the live service.

- [ACCEPTANCE.md](archive/ACCEPTANCE.md)
- [AUDIT-2026-11-04.md](archive/AUDIT-2026-11-04.md)
- [AUDIT-PERSISTENT-CUSTODY-AND-DELIVERY.md](archive/AUDIT-PERSISTENT-CUSTODY-AND-DELIVERY.md)
- [AUDIT-PROVIDER-PRODUCTION-ACCEPTANCE.md](archive/AUDIT-PROVIDER-PRODUCTION-ACCEPTANCE.md)
- [CONTABO-LIVE-PILOT.md](archive/CONTABO-LIVE-PILOT.md)
- [WINDOWS-ONLINE-PILOT.md](archive/WINDOWS-ONLINE-PILOT.md)
- [CONTABO-LIVE-TRADING.md](archive/CONTABO-LIVE-TRADING.md)
- [CONTABO-NATIVE.md](archive/CONTABO-NATIVE.md)
- [CONTABO-WORKSPACE-DEPLOY.md](archive/CONTABO-WORKSPACE-DEPLOY.md)
- [CONTABO.md](archive/CONTABO.md)
- [CROSS-CHANNEL-SKU-MATCHING.md](archive/CROSS-CHANNEL-SKU-MATCHING.md)
- [EVIDENCE-AUDIT-JOURNAL.md](archive/EVIDENCE-AUDIT-JOURNAL.md)
- [EVIDENCE-EXTERNAL-CUSTODY-PROTOCOL.md](archive/EVIDENCE-EXTERNAL-CUSTODY-PROTOCOL.md)
- [EVIDENCE-EXTERNAL-TRANSPORT.md](archive/EVIDENCE-EXTERNAL-TRANSPORT.md)
- [FOUR-TRACK-BUILD-AND-RELEASE-HOLDS.md](archive/FOUR-TRACK-BUILD-AND-RELEASE-HOLDS.md)
- [INSTORE-COLLECTION.md](archive/INSTORE-COLLECTION.md)
- [INTEGRATION-STATUS.md](archive/INTEGRATION-STATUS.md)
- [LIVE-CASH-ROLLOUT.md](archive/LIVE-CASH-ROLLOUT.md)
- [LIVE-READONLY-REVIEW.md](archive/LIVE-READONLY-REVIEW.md)
- [MERCHANT-EVIDENCE-PROVISIONING.md](archive/MERCHANT-EVIDENCE-PROVISIONING.md)
- [PHASE1-ACCEPTANCE-REVIEW.md](archive/PHASE1-ACCEPTANCE-REVIEW.md)
- [PHASE1-FINAL-REVIEW-COMMIT-READINESS.md](archive/PHASE1-FINAL-REVIEW-COMMIT-READINESS.md)
- [PHASE1-RELIABILITY.md](archive/PHASE1-RELIABILITY.md)
- [PHASE2-IMPLEMENTATION-AND-STAGING-PLAN.md](archive/PHASE2-IMPLEMENTATION-AND-STAGING-PLAN.md)
- [PHASE2-LOCAL-DEVELOPMENT-STATUS.md](archive/PHASE2-LOCAL-DEVELOPMENT-STATUS.md)
- [PHASE2-STOCK-SAFETY-AUDIT.md](archive/PHASE2-STOCK-SAFETY-AUDIT.md)
- [PHASE2A-INDEPENDENT-REVIEW-AND-READINESS.md](archive/PHASE2A-INDEPENDENT-REVIEW-AND-READINESS.md)
- [PHASE38-AND-4-UNIFIED-WOO-READINESS.md](archive/PHASE38-AND-4-UNIFIED-WOO-READINESS.md)
- [PHASE41-WOO-STOCK-OWNER-REVIEW.md](archive/PHASE41-WOO-STOCK-OWNER-REVIEW.md)
- [PHASE42-OWNER-INVENTORY-REVIEW.md](archive/PHASE42-OWNER-INVENTORY-REVIEW.md)
- [PHASE43-SECOND-RECOUNT-CLAIMS.md](archive/PHASE43-SECOND-RECOUNT-CLAIMS.md)
- [PHASE44-RECOUNT-PREPARATION.md](archive/PHASE44-RECOUNT-PREPARATION.md)
- [PHASE45-PHYSICAL-COUNT-CLAIMS.md](archive/PHASE45-PHYSICAL-COUNT-CLAIMS.md)
- [PHASE46-OWNER-COUNT-TRIAGE.md](archive/PHASE46-OWNER-COUNT-TRIAGE.md)
- [PHASE47-OWNER-MAPPING-EVIDENCE.md](archive/PHASE47-OWNER-MAPPING-EVIDENCE.md)
- [PHASE48-INVENTORY-DOSSIER.md](archive/PHASE48-INVENTORY-DOSSIER.md)
- [PHASE49-ACCEPTANCE-PREPARATION.md](archive/PHASE49-ACCEPTANCE-PREPARATION.md)
- [PHASE50-COUNT-SUPERVISION-EVIDENCE.md](archive/PHASE50-COUNT-SUPERVISION-EVIDENCE.md)
- [PHASE51-PRIVATE-COUNT-FILE-REGISTRY.md](archive/PHASE51-PRIVATE-COUNT-FILE-REGISTRY.md)
- [PHASE52-EVIDENCE-CUSTODY-REVIEW.md](archive/PHASE52-EVIDENCE-CUSTODY-REVIEW.md)
- [PHASE53-REVIEWER-RESPONSE-INTAKE.md](archive/PHASE53-REVIEWER-RESPONSE-INTAKE.md)
- [PHASE54-REVIEWER-ACCOUNT-ACCESS.md](archive/PHASE54-REVIEWER-ACCOUNT-ACCESS.md)
- [PHASE55-REVIEWER-HANDOFF-RECEIPT.md](archive/PHASE55-REVIEWER-HANDOFF-RECEIPT.md)
- [PHASE56-INVENTORY-EVIDENCE-EXCEPTIONS.md](archive/PHASE56-INVENTORY-EVIDENCE-EXCEPTIONS.md)
- [PHASE57-INVENTORY-VERIFICATION-READINESS.md](archive/PHASE57-INVENTORY-VERIFICATION-READINESS.md)
- [PHASE58-PROVISIONAL-RECONCILIATION-PACKETS.md](archive/PHASE58-PROVISIONAL-RECONCILIATION-PACKETS.md)
- [PHASE59-OFFLINE-INVENTORY-AUDIT-HANDOFF.md](archive/PHASE59-OFFLINE-INVENTORY-AUDIT-HANDOFF.md)
- [PRODUCTION.md](archive/PRODUCTION.md)
- [RETAIL-CASH-SINGLE-HOST-RELEASE-PLAN.md](archive/RETAIL-CASH-SINGLE-HOST-RELEASE-PLAN.md)
- [SETUP.md](archive/SETUP.md)
- [SHARED-WOO-STOCK.md](archive/SHARED-WOO-STOCK.md)
- [WINDOWS-OFFLINE-DESIGN.md](archive/WINDOWS-OFFLINE-DESIGN.md)
