// Owner-only audit history.
import { z } from 'zod';

export function registerAuditRoutes(app, ctx) {
  const { db, auth, role } = ctx;
  // Owner-only audit history. Keyset pagination prevents the newest login
  // events from moving already inspected rows between pages. Search/period
  // filters are executed against the LOCAL POS ledger, not a browser subset.
  // This endpoint never modifies staff, payments, orders, stock or the audit.
  app.get('/api/audit', auth, role('owner'), (req, res) => {
    const input = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      cursor: z.coerce.number().int().positive().optional(),
      search: z.string().trim().max(80).default(''),
      category: z.enum(['all','auth','staff','shift','wholesale','operations']).default('all'),
      period: z.enum(['all','24h','7d','30d']).default('all'),
    }).strict().parse(req.query);
    const clauses = [], args = [];
    if (input.cursor !== undefined) {
      clauses.push('audit.id < ?');
      args.push(input.cursor);
    }
    if (input.period !== 'all') {
      const hours = { '24h':24, '7d':168, '30d':720 }[input.period];
      clauses.push('audit.created_at >= ?');
      args.push(new Date(Date.now() - hours * 3600000).toISOString());
    }
    if (input.category !== 'all') {
      clauses.push('audit.action LIKE ?');
      args.push(input.category + '.%');
    }
    if (input.search) {
      clauses.push("instr(lower(coalesce(users.name,audit.actor) || ' ' || audit.action || ' ' || audit.subject), lower(?)) > 0");
      args.push(input.search);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = db.prepare('SELECT audit.*, users.name AS actor_name FROM audit ' +
      'LEFT JOIN users ON users.id=audit.actor' + where +
      ' ORDER BY audit.id DESC LIMIT ?').all(...args, input.limit + 1);
    const hasMore = rows.length > input.limit;
    const shown = rows.slice(0,input.limit);
    res.json({
      kind:'owner-local-pos-audit-history',source:'local-pos-ledger',
      readOnly:true,websiteAuditIncluded:false,
      events:shown.map(r=>({
        id:r.id,actor:r.actor,actorName:r.actor_name||r.actor,
        action:r.action,subject:r.subject,createdAt:r.created_at,
      })),
      hasMore,nextCursor:hasMore?shown.at(-1).id:null,
      notice:'POS ledger activity only. This is not an independent or immutable audit provider and excludes website/WordPress/Paystack logs.',
    });
  });
}
