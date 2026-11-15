# Phase 3.2 — Synthetic financial-evidence audit journal

**Status: draft, synthetic-only, not deployed or enabled for MansuPOS.** This is a local integrity-test prototype for evidence-access events, not a production tamper-proof ledger, bank settlement record, independent witness service or refund authorization. No live website/Paystack credentials, Contabo changes, POS API, background job, cash or stock transaction is involved. The existing lateGatewayGuardVerified safety flag stays FALSE.

## Built

- server/evidence-audit-journal.js implements SyntheticEvidenceAuditJournal. It stores the strictly pseudonymized buildMerchantEvidenceAuditEvent() format from Phase 3.1, using HMAC-SHA256-linked JSONL rows with monotonically increasing sequence, previous tag and keyed tag. It rejects changed/reused correlation IDs, unexpected event fields, invalid identities or financial actions, modified rows, missing final newlines, malformed JSON, reordered lines, symlinks, weak file permissions, oversized files and existing exclusive locks.
- **Crash and concurrency handling:** an O_EXCL local lock serializes normal successful writers; the journal data is fsynced before success is reported. An interrupted append or stale lock fails closed, without force-unlock, truncation, or automatic repair. This is not a transaction across several stores, nor a recoverable remote quorum.
- **Execution is synthetic-only:** the constructor requires NODE_ENV=test, MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT=true, separate pseudonymization and chain keys (minimum 32 bytes), and a private CI directory directly under OS temp with the mansu-evidence-audit-ci- prefix. No production constructor, POS app route, external account or network transport is connected.
- tests/evidence-audit-journal.test.js verifies integrity checking, retry idempotency, conflicting duplicate IDs, permissions, symlink refusal, exclusive lock refusal, tampering, row reordering, truncated writes, tail rollback, independent expected-head checking and privacy of order/customer/payment identifiers.

## Precisely what is—and is not—proven

The local verify() recomputes the HMAC chain from genesis through the records actually present, checks strict event schemas and unique correlation IDs, and reports localHmacChainValid=true only for those records.

An actor able to delete the file or roll it back to an earlier valid prefix may leave a locally valid chain. Full-file loss, rollback or compromise of both host and HMAC key **cannot be ruled out** without a separate trusted witness. A separately retained trusted {sequence,tag} head supplied to verify({expectedHead}) catches a missing tail, but the code cannot establish the witness's ownership or authenticity. Even after an expected-head match, independentAnchorAuthenticated, rollbackProtectionVerified, and productionAuditAccepted remain false.

This journal only indicates that a synthetic evidence-access event was recorded with local keys. It never establishes a paid customer transaction, Paystack or bank settlement, returned physical cash, an inspected garment, goods-release eligibility or stock-restoration authority.

## Mandatory production dependencies

1. Owner-authorized, separate Woo order/refund read credentials and a provider-approved least-privilege Paystack read mechanism, plus actual Woo/Paystack/HPOS/plugin compatibility verification.
2. A separately administered and durable append-only audit destination with independent chain-head anchoring and verification, retention controls, access restrictions and monitoring.
3. Backups and incident recovery protocols for corruption/stale locks, key rotation, revocation, retention, and operator sign-off. No silent repair.
4. Privacy review for pseudonymous identifiers, role separation and secrets never shared with cashiers or written to logs.
5. Staging and tightly scoped approved read-only source tests; merchant identity/settlement evidence must be authenticated separately. No payout, refund, order or inventory write testing against live accounts.
6. Separate Owner deployment approval; do not merge or install the draft, alter the existing read-only catalogue pilot or change lateGatewayGuardVerified from false.

The existing POS SQLite ledger, website Paystack payments and WooCommerce stock remain unchanged.
