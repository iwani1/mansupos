// Offline Windows till enrolment, allocation and sync (separately gated).

export function registerDesktopRoutes(app, ctx) {
  const { desktop, auth, role, sensitiveLimit } = ctx;
  // Separately gated live trading service only. The read-only pilot, demo and
  // ordinary Woo checkout never enroll a device or issue offline allocations.
  app.post('/api/desktop/enroll', auth, role('owner'), sensitiveLimit, (req, res) => res.json(desktop.enroll(req.user, req.body)));
  app.get('/api/desktop/bootstrap', auth, async (req, res) => res.json(await desktop.bootstrap(req.user, req.query.deviceId)));
  app.post('/api/desktop/allocate', auth, role('owner'), sensitiveLimit, async (req, res) => res.json(await desktop.allocate(req.user, req.body)));
  app.post('/api/desktop/sync', auth, sensitiveLimit, async (req, res) => res.json(await desktop.sync(req.user, req.body)));
}
