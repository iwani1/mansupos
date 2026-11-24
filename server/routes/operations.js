// Daily staff checklists and weekly scorecards (local self-reports).
import { z } from 'zod';

export function registerOperationsRoutes(app, ctx) {
  const { operations, weekly, auth, role, sensitiveLimit } = ctx;
  // Staff checklists are LOCAL self-reports, not WooCommerce writes.
  // New entries append to the existing protected v9 audit journal.
  app.get('/api/operations/day', auth, (req,res) => {
    const {date}=z.object({date:z.string().optional()}).strict().parse(req.query);
    res.json(operations.self(req.user,date));
  });
  app.get('/api/operations/team', auth, role('owner','manager'), (req,res) => {
    const {date}=z.object({date:z.string().optional()}).strict().parse(req.query);
    res.json(operations.team(date));
  });
  app.post('/api/operations/assign', auth, role('owner'), sensitiveLimit, (req,res) => {
    res.json(operations.assign(req.user,req.body));
  });
  // Management scorecards are local POS self-reports, not verified sales or staff attendance.
  app.get('/api/operations/scorecard', auth, role('owner','manager'), (req,res) => {
    const {week}=z.object({week:z.string().optional()}).strict().parse(req.query);
    res.json(weekly.scorecard(week));
  });
  app.post('/api/operations/review', auth, role('owner'), sensitiveLimit, (req,res) => {
    res.json(weekly.review(req.user,req.body));
  });
  app.post('/api/operations/task', auth, sensitiveLimit, (req,res) => {
    res.json(operations.setTask(req.user,req.body));
  });
  app.post('/api/operations/report', auth, sensitiveLimit, (req,res) => {
    res.json(operations.submit(req.user,req.body));
  });
}
