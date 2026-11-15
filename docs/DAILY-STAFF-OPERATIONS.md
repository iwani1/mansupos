# Daily staff operations — task completion and owner review

**Status:** Source-code feature on the draft GitHub branch. It is NOT present in an earlier deployment of commit `8302d299` and has not been installed on the Contabo server by this GitHub work. Do not pull/restart the pilot just to enable this screen; deploy only after the normal backup, review, acceptance and maintenance checks.

## What the new page does

- **Owner** uses **Operations → Daily staff operations** to assign an active staff account to **Sales representative** or **Fulfilment officer**, or to unassign it. Existing names/accounts come from the POS users table; this feature does not create staff.
- **Cashier and manager** accounts can see their *own* assigned daily checklist, mark/reopen today's tasks, and submit or correct today's report.
- **Owner and manager** can view a seven-day team summary, including active/inactive accounts, each account's assigned duty, completed task count, submission time, and its self-reported daily figures and note. A manager cannot assign workstreams or edit another employee's entries.
- The business date comes from the server in the `Africa/Accra` time zone. Only today can be edited; a seven-day lookback is read-only. Dates, role IDs and staff identity cannot be chosen by a task/report POST.
- The two report counts are specific to the assigned workstream. Sales: follow-ups and orders requiring handover. Fulfilment: packages prepared and dispatch handovers. Both include the number of exceptions and a short note (maximum 280 characters).
- An owner-only Activity History filter **Daily staff operations** finds assignments, task completion/reopening and submitted reports.

## Data and safeguards

All staff events use **only the existing append-only `audit` journal in the v9 private SQLite ledger**: `operations.assignment`, `operations.task_done`, `operations.task_reopened` and `operations.report`. The staff member's session determines who is making a declaration. Owner assignments use the owner identity in the journal. This avoids a schema migration and preserves both original entries and subsequent corrections. The POS backup tool already snapshots this ledger, subject to its existing manifest/restore limitations.

The interface and API **do not** create WooCommerce requests, reserve goods, change inventory, record shifts, take payment, generate receipts or certify courier deliveries. Task checkmarks and reported counts are subjective staff declarations, not corroborated records. The existing read-only live-catalogue checkout locks remain in effect.

The note is kept in the protected journal (visible in the owner's audit view), so staff must not enter customer names, phone numbers, account details, payment references or secrets. This is an application-level append-only history, **not** cryptographically independent or off-server audit evidence. Owners should corroborate exceptions against original order, payment, stock, delivery and staff records.

The service cannot infer an employee's job from their `cashier` or `manager` permission role. An owner explicitly chooses the duty workstream, which is distinct from the access-control role. Inactive staff cannot be newly assigned, and the dashboard retains their previous self-reports for the selected date.

## Validation

`tests/daily-operations.test.js` covers owner-only assignment, cashier/manager boundaries, access to other staff reports, server-selected dates, idempotent completion, correction history, malformed payloads, and immutable audit entries. `tests/browser-workspace.mjs` checks the new owner screen using the isolated demo environment and ensures it does not make financial mutations.

The source is in a draft PR. Before any server upgrade, review production data and independent backups and verify the full health/read-only profile. A positive local test is **not** verification of the live WooCommerce store or a successful on-host rollout.
