# MansuPOS — Owner-only Staff Activity Review

**Development branch feature, not yet installed on pos.mansutrendzgh.com.** The live catalogue pilot and production cash/order/stock locks remain unchanged.

## Why this screen exists

The existing Audit log listed only the latest 200 POS events. The updated Administration → Audit log can now search and page through older POS audit history, helping the business owner investigate staff account access, account changes, cash shift actions and wholesale activity. This does NOT prove that staff physically handled money, received goods, or accessed WordPress directly.

## Using the screen

1. Sign in as an **Owner** and open **Administration → Audit log**. Managers and cashiers cannot use the endpoint or see its navigation item.
2. Use **Staff, action or reference** to search for a named employee, an event action or an identifier shown in POS audit history. Search is server-side across the local audit table; it is not limited to displayed rows.
3. Narrow activity to **All actions**, **Sign-ins and account security**, **Staff management**, **Cash shifts and drawer**, or **Wholesale**. Choose the last **24 hours**, **7 days**, **30 days**, or **All recorded history**.
4. Press **Search activity**. The displayed count is the number of matching records LOADED so far. Use **Load older events** to page further back. The server uses an ID cursor to avoid duplication if new activity arrives during review.
5. **Refresh** checks the current filters from the newest matching event; a failed refresh clears the older results so they cannot be mistaken for current verified evidence.

The API remains a read-only **GET /api/audit**. Parameters: optional integer limit (1–500), positive integer cursor, plain-text search (max 80 characters), category in all/auth/staff/shift/wholesale, period in all/24h/7d/30d. Unknown parameters, malformed cursors, and invalid category/period values return HTTP 400. The response includes a read-only local-POS source label, events, hasMore and nextCursor. No new database schema or migration is needed.

## Important limits and security

- Only the existing **owner-authorized** server endpoint may access records. A changed browser or intercepted response cannot grant staff access.
- The POS audit is a **local ledger**, not external tamper-proof custody. An administrator with DB access or a compromised server cannot be independently audited from this page alone.
- The screen does not show website/WordPress/Paystack account actions or external banking data. No external audit provider or incident-notification service has been installed.
- Values are React-rendered as text. Private events are not cached in browser localStorage, exported, or sent to third parties.
- There are no buttons for refunds, stock adjustments, changing staff privileges, confirming sales, accepting cash, releasing goods, or enabling checkout.
- Keyset pagination avoids duplicates from new higher-ID events, but a 30-day time boundary is calculated at each request and the source is not a cryptographically fixed audit snapshot. For serious incidents, independently preserve an authorized, verified, off-host evidence copy.
- Changing application code does not migrate or bind the existing read-only pilot database. Follow the separate approved maintenance and verified backup plan before any installation.

## Validation

Run the isolated automated checks on the development branch: npm test, npm run lint, npm run build:live, and browser workspace tests on a demo-only server. The audit-history regression covers server-side filters, pagination, unknown/unsafe parameters, manager/cashier denial and the append-only audit journal. Browser coverage checks search and loading older synthetic event pages without submitting any API write.

**A green test run is not permission to replace the existing live POS service.** Checkout and Woo stock writes remain disabled.
