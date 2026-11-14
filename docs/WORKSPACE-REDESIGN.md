# MansuPOS workspace UI redesign

This is an original, **Notion-inspired** document-workspace interface for the existing React POS. It does not copy Notion's trademark, logo, icons, proprietary graphics, or source. The business name remains MansuTRENDZGh and all financial and stock safeguards remain in the Node/PHP backend.

## Information architecture

The redesigned workspace keeps all existing features in four collapsible sections:

- **Workspace:** Overview, Point of sale, Wholesale management.
- **Catalogue:** Products, Categories, Inventory.
- **Operations:** Sales history, Orders, Recovery queue, Customers, Shifts & drawer, Reports & analytics, physical-source review where applicable.
- **Administration:** Staff, Audit log, Settings & connection.

Every page shares a document-like title, understated icon, context, primary actions, neutral surfaces, and compact tables. The register keeps its two-column catalogue/cart layout on desktop, with the original full-height mobile cart behavior. The cashier permission filtering is shared by the sidebar and the new command menu.

## Interaction design

- The sidebar has a visible primary **New sale** or **Open register** action; the wording reflects whether POS writes are allowed.
- **Ctrl+K / Cmd+K** opens a role-filtered page switcher. Search by page name or section; arrow keys and Enter select, Escape closes. The product search remains a separate button that places focus in the register's catalogue query. F2 scanner/register shortcuts are unchanged.
- The left directory collapses on desktop and becomes an accessible drawer below 1081 px. Navigation, search, stock badges, alert details, owner account functions and direct POS permissions remain functional.
- DM Sans, neutral paper/grey surfaces, charcoal primary actions, meaningful amber/red/green financial states, quiet borders and restrained motion replace the previous pink retail-studio framing.
- Read-only, demo, offline, stale stock and unresolved-transaction banners are **not** hidden or softened.
- All backend endpoints, ledger migration rules, HMAC, WooCommerce identifiers, cash custody and payment sequence are untouched by this redesign.

## Contabo installation

Use [CONTABO-WORKSPACE-DEPLOY.md](CONTABO-WORKSPACE-DEPLOY.md) for the standalone on-server deployment and pull process. This is not a request for a staging site and is not permission for cash trading. Existing pilot, Nginx apps, live store stock and gateway must stay unchanged until separately authorized.
