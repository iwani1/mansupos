# Phase 4.3 — Independent second recount claim review

Status: DRAFT, offline and read-only. No product or stock import, Woo write, live payment, checkout, refund, cash, Contabo deployment or merge.

The Phase 4 original cutover evidence contains a first physical count with a counter UUID and witness UUID. The IDs and count are typed claims, not actual proof of staff identity or stock. Phase 4.3 lets a separately entered second claim be compared to that first claim. Two identical numbers are not an approved inventory balance.

## Using the existing offline command

The final optional input is a private second-recount JSON, positioned AFTER the existing Woo export CSV, private first-count/crosswalk JSON, and private Phase 4.2 review JSON:

    node scripts/assess-shared-woo-cutover.mjs /private/woo-products.csv /private/cutover-evidence.json /private/owner-review-draft.json /private/second-recounts.json

The final file must be regular, not a symlink, owner-only (0600 on Linux/macOS), and have exactly the following structure:

    {
      "schemaVersion": 1,
      "physicalManifestSha256": "<64 lowercase hex>",
      "wooExportSha256": "<64 lowercase hex>",
      "cutoverEvidenceSha256": "<64 lowercase hex>",
      "recounts": [
        {
          "sourceSku": "1234",
          "units": 2,
          "countedAt": "2026-11-15T17:00:00.000Z",
          "counterId": "<UUID>"
        }
      ]
    }

The values above are illustrative, not actual stock data. Hashes must refer to exact original physical manifest, fresh private Woo CSV, and original first count/crosswalk JSON bytes. Only integers from 0 to 1000000 are accepted as a per-row quantity claim; none becomes a stock import value. No free-text notes, names, phone numbers, customer data, extra JSON fields, duplicate source entries, or invalid dates.

The second counter UUID must be distinct from both original first counter and original witness UUID. This detects obvious role reuse but DOES NOT authenticate any actual person.

The aggregate report flags:
- Matching or conflicting first-versus-second typed count claims.
- A second count with no first-count claim.
- Eligible goods lacking a second claim, if the second file was supplied.
- Unrecognized source codes and second counts of held goods (held goods stay held).
- Stale/future second timestamps (suggested 24-hour recency heuristic).
- Counts over four hours apart (review heuristic, not a live operating SLA).

No raw SKU, Woo ID, name, quantity, employee UUID or private review note is printed, and no file is written or Woo request made. A source row may have several blocker codes; issue counts must not be added as inventory quantities. The previous CLI forms without a second-count file remain supported.

Independent verification of two actual counter identities, physical count sheets, real Woo parent/variation stock ownership, open website orders and reservations, returns, refunds, tax and last-unit concurrency is REQUIRED outside this tool. The 41 held historical records do not become sellable. All stock writes, payment, refunds and checkout remain blocked, including lateGatewayGuardVerified:false. PR #1 stays draft/unmerged.
