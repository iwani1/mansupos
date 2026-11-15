# Phase 4.2 — Offline discrepancy triage and owner-review draft workflow

**DRAFT / read-only only.** No real WooCommerce, Paystack or Contabo access, checkout, product creation, import, quantity change, refund, cash, merge or release approval.

The existing Phase 4 SHA-bound assessment now supplies five prioritized review queues. There is no second stock ledger. The PDF stock quantities are historical; a Woo CSV export cannot prove live availability or the installed parent/variation stock owner.

## P0/P1 queues

| Task | Priority | Purpose |
| --- | --- | --- |
| quarantine | P0 | The 41 originally held items stay held |
| export_integrity | P0 | Invalid or orphan variation parents, duplicate IDs/SKUs, unsupported product types |
| identity | P1 | Unmapped or mismatched existing/new product and variation identities |
| physical_recount | P1 | No recent witnessed count claim, stale claim, historical discrepancies |
| variation_owner | P1 | Actual installed variation-vs-parent stock owner still unknown |

The report gives aggregate issue-event counts, unique source rows per task, bounded source-row examples, global-issue flags, provisional review-action counts and still-unannotated cases. **One physical row may appear in multiple queues:** never add queue totals to obtain quantities or unique products. At most 12 sample row numbers are disclosed per queue; never raw SKUs, Woo IDs, prices, per-item quantities or customer data.

## Optional third PRIVATE file: provisional review annotations

The exact CLI invocation is:

    node scripts/assess-shared-woo-cutover.mjs /private/woo-products.csv /private/cutover-evidence.json /private/owner-review-draft.json

The third file must be private (mode 0600 on Linux/macOS), regular and not a symlink. Use this strict JSON schema:

    {
      "schemaVersion": 1,
      "physicalManifestSha256": "64 lowercase hex digits from the original source manifest",
      "wooExportSha256": "64 lowercase hex digits of the exact fresh Woo export bytes",
      "cutoverEvidenceSha256": "64 lowercase hex digits of the exact crosswalk-and-count JSON bytes",
      "actions": [
        {
          "sourceRow": 1,
          "task": "physical_recount",
          "state": "recount_requested"
        }
      ]
    }

The example uses explanatory placeholders for the hash strings, not a runnable approved cutover. A valid input requires the real hashes, an existing review case and the matching physical row.

sourceRow is the one-based index in the pinned historical physical source. A global issue uses row 0, only when such an issue exists. Each task/sourceRow pair may appear once. States are restricted to: open, investigating, recount_requested, owner_decision_required, installed_site_check_required.

**There is deliberately no resolved, approved, release or signed-off state.** Reject arbitrary notes, reviewer names, customer contacts, unknown fields, duplicate actions, unrelated row/task actions, stale source hashes, changed export/evidence bytes and unsafe file permissions. These annotations are untrusted claims, NOT proof that an Owner, reviewer or counter performed a verification.

The CLI reads all input locally and prints aggregate-only Markdown to stdout. It does not save review actions, produce stock import files, change a Woo product, update a POS stock ledger, authorize checkout or signal completion of owner approval.

## Remaining external acceptance

1. Obtain a fresh COMPLETE private Woo export including all parent/variation identities.
2. Witness new physical stock counts by size and colour; reconcile pending and dispatched website orders, returns, damaged goods and reserved stock.
3. Independently verify installed-site stock OWNER (parent versus variation), backorder behavior, Woo/Paystack late callbacks and last-unit concurrency.
4. Resolve all 41 held cases individually, documenting independently authenticated Owner/security decisions outside this private draft tool.
5. Separately approve staging tests, tax-inclusive GHS retail prices, wholesale cash custody and any later proposal for stock changes.

All existing hard locks, including lateGatewayGuardVerified:false, remain in force. PR #1 must stay draft/unmerged; nothing in this milestone deploys to the website or store.
