# Stock adjustment requests (owner-reviewed pilot)

**Status: draft branch, not deployed.** Live POS and WooCommerce are unchanged.
This feature is a staff accountability workflow, **not an automatic live stock editor**.
Do not advertise owner approval as proof that physical goods arrived or that WooCommerce stock changed.

## Workflow

1. In **Inventory → Stock adjustment requests**, a cashier, manager or owner selects the exact WooCommerce product/variation, enters the observed current count, proposed new count, reason and a detailed note.
2. The server fetches the exact stock-owner balance fresh from WooCommerce (never trusts the browser count). Unsupported/untracked and parent-managed variation edits are rejected. Only one open request per stock pool can exist at a time.
3. The **Owner** checks goods and approves or rejects. An approval fetches the exact Woo record again and refuses stale quantities or changed identity. Manager and cashier accounts cannot approve or verify.
4. **Demo only:** owner approval atomically updates local demo stock; no Woo requests are sent.
5. **Live and staging:** an approval does **not** change WooCommerce. The owner manually edits the verified stock quantity on the appropriate WooCommerce product/variation while the business controls sales, then uses **Verify website balance**. This is another fresh GET requiring the exact intended quantity and identity. A matching balance is an observation, not proof of how it changed.

The POS audit journal records requester and approver IDs, immutable action timestamps and request IDs; the request record retains the old count, proposed count, reason, status, and owner note. Cashiers see only their own requests. There are no customer details or product write credentials in the UI.

## What remains blocked

**Direct live POS-to-Woo stock edits are not implemented.** WooCommerce product `PUT stock_quantity` changes an absolute value and cannot atomically compare against concurrent website sales. A read-before-write check would still risk overwriting a website order, especially for a last unit. The release must stay request-only until a reviewed WooCommerce-side atomic compare-and-set stock adjustment endpoint, idempotency, independent backup/restore and actual shop concurrency tests are approved.

## Verification

Run `npm test`, `npm run lint`, `npm run build:live` and `npm run test:browser` on an isolated demo. Test cashier request, manager approval rejection, owner approve, demo stock changes, live zero Woo writes, stale count rejection, parent-managed variation block, duplicate queue handling, and audit history.

This draft adds a new v10 SQLite migration. Take a verified backup and test isolated restore before any deployment. Never deploy the draft directly to the live till without owner signoff.
