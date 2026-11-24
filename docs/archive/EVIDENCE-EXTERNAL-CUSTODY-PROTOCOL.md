# Phase 3.4 — Separated signed audit anchors, integrity alerts and recovery gate

**Status: DRAFT / OFFLINE SYNTHETIC SIMULATOR ONLY.** Not installed or enabled on Contabo, WooCommerce, Paystack or cashier POS. This does NOT create a real independently administered audit service, durable off-host storage, live monitoring or production backup/restore.

## Code added

- server/evidence-checkpoint-witness.js now exposes latestSyntheticSignedWitnessReceipt(): it validates the entire local checkpoint chain using a pinned Ed25519 public key and returns only its latest signed witness. The receipt contains no signing key, customer data or payment reference.
- server/evidence-separated-anchor-simulator.js adds SyntheticSeparatedAuditAnchorCustodian. It requires NODE_ENV=test and MANSU_CI_SYNTHETIC_EXTERNAL_ANCHOR=true. It receives a validated signed checkpoint and verifies the full local HMAC journal; it then signs a separate anchor with a DIFFERENT Ed25519 custodian key. Anchors bind a site UUID, witness digest, journal sequence/tag, previous anchor digest, and issue timestamp.
- The custodian keeps a **private in-memory high-watermark**. It refuses same-sequence forks, older heads, mismatched signatures/keys, stale journals and backwards timestamps; exact retries are idempotent. There is no production API, remote storage, scheduled task or POS import.
- check() emits either local_protocol_consistent or a critical blocked_manual_investigation alert for WITNESS_UNAVAILABLE or AUDIT_ANCHOR_OR_JOURNAL_DIVERGENCE. No notifications are actually delivered: alert codes are local test responses only. assessRecoveryCandidate() is read-only, and never performs or authorizes a restore.

## What tests show

tests/evidence-separated-anchor-simulator.test.js covers key separation, monotonic anchor receipts, signed witness validation, replay prevention, rollback, valid and invalid external receipt pinning, forged signature refusal, external outage alerts, unanchored journal entries, and immutable recovery assessment.

A deliberate negative control rolls back BOTH the local journal and witness files, while the simulated custodian still remembers the latest higher head: the check correctly blocks. But resetting that same-host in-memory custodian lets a previously valid old prefix be re-anchored. **Therefore the simulator does NOT prove independent custody, durability, or production-grade rollback protection.**

Every result keeps independentExternalCustodyVerified=false, publicKeyTrustRootIndependentlyVerified=false, productionRollbackProtectionVerified=false, bankSettlementVerified=false, and all payment/refund/stock/checkout authorization flags false. A valid signature never proves actual bank credit, physical customer refund, return inspection or permission to release goods.

## Necessary production implementation

1. **Off-host custody:** provision a different, independently administered permission boundary and durable append-only storage with retention/WORM controls. POS and Contabo operators must not be able to delete/overwrite the external watermark. Pin the custodian's public key out of band.
2. **Monotonic authority:** an actual external service must verify signed original witness receipts, preserve the full chain, reject replay/forks and persist a never-decreasing high watermark. Return authenticated acknowledgments. After network uncertainty, inquire using the original idempotency token rather than creating a new fork.
3. **Alert delivery:** integrate separately secured Owner/security notifications, incident records, replay/rate limiting, escalation and acknowledgment policy. Test that outages, missing receipts, key changes and rollback produce alerts without financial writes. The current code only returns an alert code; it sends no message.
4. **Manual recovery:** authorized Owner and an independent reviewer must compare immutable backups and external watermark in an isolated environment, preserve incident evidence, document the gap, and retest before any separately approved restore. Do not auto-truncate, auto-unlock, reset signing keys or silently re-anchor.
5. **Operational security:** establish key custody and rotations, trust-root revocation, incident/rollback runbook, retention, off-host backups, monitoring, privacy review, drill evidence and least-privilege operators. An independently audited implementation is required.
6. **Financial source access remains separate:** only with merchant authorization should a credential-isolated service inspect installed WooCommerce/Paystack transactions. A Paystack secret key may have write privileges; the original catalogue-only Woo credential must not be escalated.

## Release gate

The work remains draft and unmerged. No merchant Paystack or Woo financial integration, external witness service, Contabo deployment, real bank settlement, cash payout, refund, return, order write or stock change was performed. lateGatewayGuardVerified remains false and live checkout remains locked.
