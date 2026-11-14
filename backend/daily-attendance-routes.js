'use strict';
// Separate daily attendance API. Install after app.use('/api', auth, ...)
// and before app.use('/api', admin) in backend/index.js.
module.exports = function registerDailyAttendance(app, db) {
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const allowed = (req, res, next) => {
    if (!['admin', 'employee', 'contractor'].includes(req.user.role))
      return res.status(403).json({ error: 'Ingen behörighet' });
    next();
  };
  const mine = req => [req.user.companyId, req.user.userId];

  // Active shift with calculated break duration (including running break).
  app.get('/api/daily/current', allowed, wrap(async (req, res) => {
    const { rows } = await db.query(`
      SELECT a.id, a.check_in, a.check_out,
             b.started_at AS active_break_started_at,
             COALESCE(a.manual_break_seconds, t.break_seconds, 0)::float8 AS break_seconds,
             GREATEST(0, EXTRACT(EPOCH FROM (NOW() - a.check_in)) - COALESCE(a.manual_break_seconds, t.break_seconds, 0))::float8 AS worked_seconds
      FROM daily_attendance a
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))) AS break_seconds
        FROM daily_attendance_breaks
        WHERE attendance_id = a.id
      ) t ON TRUE
      LEFT JOIN LATERAL (
        SELECT started_at FROM daily_attendance_breaks
        WHERE attendance_id = a.id AND ended_at IS NULL
        ORDER BY id DESC LIMIT 1
      ) b ON TRUE
      WHERE a.company_id = $1 AND a.user_id = $2 AND a.check_out IS NULL
      LIMIT 1`, mine(req));
    res.json(rows[0] || null);
  }));

  app.post('/api/daily/start', allowed, wrap(async (req, res) => {
    const { rows } = await db.query(`
      INSERT INTO daily_attendance (company_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (company_id, user_id) WHERE check_out IS NULL DO NOTHING
      RETURNING id, check_in`, mine(req));
    if (!rows.length) return res.status(409).json({ error: 'Du har redan startat arbetsdagen' });
    res.status(201).json(rows[0]);
  }));

  app.post('/api/daily/break/start', allowed, wrap(async (req, res) => {
    const { rows } = await db.query(`
      INSERT INTO daily_attendance_breaks (attendance_id)
      SELECT a.id FROM daily_attendance a
      WHERE a.company_id = $1 AND a.user_id = $2 AND a.check_out IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM daily_attendance_breaks b
          WHERE b.attendance_id = a.id AND b.ended_at IS NULL
        )
      RETURNING id, attendance_id, started_at`, mine(req));
    if (!rows.length) return res.status(409).json({ error: 'Ingen aktiv arbetsdag eller rast pågår redan' });
    res.status(201).json(rows[0]);
  }));

  app.post('/api/daily/break/stop', allowed, wrap(async (req, res) => {
    const { rows } = await db.query(`
      UPDATE daily_attendance_breaks b SET ended_at = NOW()
      FROM daily_attendance a
      WHERE b.attendance_id = a.id
        AND a.company_id = $1 AND a.user_id = $2
        AND a.check_out IS NULL AND b.ended_at IS NULL
      RETURNING b.id, b.started_at, b.ended_at`, mine(req));
    if (!rows.length) return res.status(409).json({ error: 'Ingen aktiv rast hittades' });
    res.json(rows[0]);
  }));

  app.post('/api/daily/stop', allowed, wrap(async (req, res) => {
    // A running break is closed at the same server timestamp as the shift.
    const { rows } = await db.query(`
      WITH clock AS (SELECT NOW() AS ts),
      ended AS (
        UPDATE daily_attendance a SET check_out = clock.ts
        FROM clock
        WHERE a.company_id = $1 AND a.user_id = $2 AND a.check_out IS NULL
        RETURNING a.id, a.check_in, a.check_out
      ),
      breaks AS (
        UPDATE daily_attendance_breaks b SET ended_at = ended.check_out
        FROM ended
        WHERE b.attendance_id = ended.id AND b.ended_at IS NULL
        RETURNING b.id
      )
      SELECT ended.id, ended.check_in, ended.check_out,
             (SELECT COUNT(*) FROM breaks)::int AS closed_breaks
      FROM ended`, mine(req));
    if (!rows.length) return res.status(409).json({ error: 'Ingen aktiv arbetsdag hittades' });
    res.json(rows[0]);
  }));

  app.get('/api/daily/history', allowed, wrap(async (req, res) => {
    const { rows } = await db.query(`
      SELECT a.id, a.check_in, a.check_out,
        COALESCE(a.manual_break_seconds, b.break_seconds, 0)::float8 AS break_seconds,
        GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(a.check_out, NOW()) - a.check_in)) - COALESCE(a.manual_break_seconds, b.break_seconds, 0))::float8 AS worked_seconds
      FROM daily_attendance a
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))) AS break_seconds
        FROM daily_attendance_breaks WHERE attendance_id = a.id
      ) b ON TRUE
      WHERE a.company_id = $1 AND a.user_id = $2
      ORDER BY a.check_in DESC LIMIT 60`, mine(req));
    res.json(rows);
  }));

  // Admin sees everyone's shifts. No project-based time entries are modified.
  app.get('/api/daily/admin/history', allowed, wrap(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Endast administratör' });
    const { rows } = await db.query(`
      SELECT a.id, a.user_id, u.full_name, u.email, a.check_in, a.check_out,
        COALESCE(a.manual_break_seconds, b.break_seconds, 0)::float8 AS break_seconds,
        GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(a.check_out, NOW()) - a.check_in)) - COALESCE(a.manual_break_seconds, b.break_seconds, 0))::float8 AS worked_seconds
      FROM daily_attendance a
      JOIN app_users u ON u.id = a.user_id AND u.company_id = a.company_id
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))) AS break_seconds
        FROM daily_attendance_breaks WHERE attendance_id = a.id
      ) b ON TRUE
      WHERE a.company_id = $1
      ORDER BY a.check_in DESC LIMIT 300`, [req.user.companyId]);
    res.json(rows);
  }));
};
