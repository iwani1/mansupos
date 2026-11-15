# Weekly staff performance scorecard (draft)

**Status:** Github draft branch only, not installed on Contabo by this update. Previous owner-reported deployment of `8302d299` is a different commit. Keep the existing pilot checkout locks and never pull into a live service without a verified backup, full recovery review, a maintenance plan and separate release approval.

## What it measures

From **Operations → Weekly staff scorecard**, the Owner and Manager can choose the current or previous seven Ghana business weeks (Monday through Sunday, with **Monday–Saturday** counted as workdays). For each employee with an existing POS account, it shows:

- **Assigned days** within the selected week, based on their recorded Sales Representative or Fulfilment Officer workstream assignment effective on each day. Unassigned days and Sundays are not counted; this is not attendance or an approved work schedule.
- **Checklist completion**: number of currently checked staff-declared tasks divided by tasks assigned on those days. Unassigned employees have a dash, not 100%.
- **Daily report coverage**: latest submitted reports, missing reports and latest self-reported issue totals. Corrections replace the displayed count while earlier submissions remain in the POS audit journal.
- **Owner review**: the owner can append a short `reviewed` or `follow_up` annotation for an assigned day. A day with no staff report cannot be marked `reviewed`, although a missing report can be flagged for follow-up. **A staff checklist or report changed after the owner's review flags `needs_recheck`**, without erasing the older review. Managers can read team history, but only the owner may record review annotations.

The server chooses the Accra date and enforces the eight-week lookback. Existing staff role permissions remain enforced server-side. Staff cannot access the team scorecard; managers cannot forge owner reviews. The review note is limited to one line and 160 characters and must contain no customer names, payment information or secrets.

## Source of evidence

The scorecard reads the existing append-only SQLite `audit` journal: `operations.assignment`, `operations.task_done`, `operations.task_reopened`, `operations.report` and the new `operations.day_review`. The new feature adds **no schema migration** and performs **no WooCommerce, Paystack, checkout, stock allocation, shift, refund, cash or dispatch mutation**. It does not read the Woo website's order or customer data.

**Critical limitation:** these are self-attested tasks and counts, with manual owner annotations. They are NOT verified staff attendance, employee productivity ratings, physical inventory, paid order totals, successful courier delivery or proof of completed stock reconciliation. No manager should treat a percentage as justification for penalties, commissions, performance ratings or releasing goods without independently checking the original records.

## Validation and rollout

`tests/weekly-operations.test.js` covers weekly totals, past-week assignment history, permission boundaries, validation, late reviews, corrected reports and the forced recheck status. The isolated browser test confirms the role-protected page renders and does not perform sales/stock mutations.

Keep the development PR in draft pending normal code review and successful CI. Deploying the code to an operating POS requires a separate owner-approved read-only pilot release; the GitHub changes do not update the running server.
