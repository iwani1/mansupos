// Shifts and cash drawer.
import { z } from 'zod';
import { openShiftSchema, closeShiftSchema, cashMovementSchema } from '../shifts.js';
import { AppError } from '../errors.js';

export function registerShiftRoutes(app, ctx) {
  const { config, shifts, auth } = ctx;
  app.get('/api/shifts/current', auth, (req, res) => res.json({ shift: shifts.current(req.user.id), required: config.requireShift }));
  app.get('/api/shifts', auth, (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).parse(req.query.days || 7);
    res.json({ shifts: shifts.list(req.user, days) });
  });
  const requireTrading = (_req, _res, next) => config.liveReadOnly
    ? next(new AppError('Shifts and cash movements are disabled in the read-only live catalogue.', 403, 'CHECKOUT_LOCKED')) : next();
  app.post('/api/shifts/open', auth, requireTrading, async (req, res) => res.status(201).json({ shift: shifts.open(req.user, openShiftSchema.parse(req.body)) }));
  app.post('/api/shifts/:id/close', auth, requireTrading, async (req, res) => res.json({ shift: shifts.close(req.user, req.params.id, closeShiftSchema.parse(req.body)) }));
  app.post('/api/shifts/:id/cash', auth, requireTrading, async (req, res) => res.json({ shift: shifts.movement(req.user, req.params.id, cashMovementSchema.parse(req.body)) }));
}
