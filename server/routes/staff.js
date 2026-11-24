// Staff accounts (owner only).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, passwordProblem, userView, audit } from '../db.js';
import { AppError, now } from '../errors.js';
import { localTransaction } from '../sale-events.js';
import { passwordSchema } from '../session.js';

export function registerStaffRoutes(app, ctx) {
  const { config, db, auth, role, sensitiveLimit } = ctx;
  app.get('/api/staff', auth, role('owner'), (req, res) => res.json({ staff: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(userView) }));
  app.post('/api/staff', auth, role('owner'), (req, res, next) => {
    if (config.mode === 'demo') return next(new AppError('Staff creation is available only in a configured staging/live workspace.', 403));
    const input = z.object({ name: z.string().trim().min(2).max(80), username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,40}$/), role: z.enum(['cashier','manager']), password: passwordSchema }).parse(req.body);
    const problem = passwordProblem(input.password, input.username);
    if (problem) throw new AppError(problem, 400);
    if (db.prepare('SELECT id FROM users WHERE username=?').get(input.username.toLowerCase())) throw new AppError('That username is already in use.', 409);
    const id = randomUUID();
    localTransaction(db, () => {
      db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at,must_change_password) VALUES (?,?,?,?,?,?,1)').run(id,input.username.toLowerCase(),input.name,input.role,hashPassword(input.password),now());
      audit(db, req.user.id, 'staff.created', id);
    });
    res.status(201).json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });
  app.post('/api/staff/:id/password', auth, role('owner'), sensitiveLimit, (req, res) => {
    if (config.mode === 'demo') throw new AppError('Password changes are disabled in the demo workspace.', 403);
    const { newPassword } = z.object({ newPassword: passwordSchema }).parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Staff member not found.', 404);
    const problem = passwordProblem(newPassword, row.username);
    if (problem) throw new AppError(problem, 400);
    localTransaction(db, () => {
      db.prepare('UPDATE users SET password_hash=?,must_change_password=1,failed_attempts=0,locked_until=NULL WHERE id=?').run(hashPassword(newPassword), req.params.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
      audit(db, req.user.id, 'staff.password_reset', req.params.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/staff/:id/status', auth, role('owner'), (req, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    if (req.params.id === req.user.id) throw new AppError('You cannot deactivate your own account.', 400);
    localTransaction(db, () => {
      const result = db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0,req.params.id);
      if (!result.changes) throw new AppError('Staff member not found.', 404);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
      audit(db, req.user.id, active ? 'staff.activated' : 'staff.deactivated', req.params.id);
    });
    res.json({ ok: true });
  });
}
