CREATE TABLE IF NOT EXISTS daily_attendance (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  user_id BIGINT NOT NULL REFERENCES app_users(id),
  check_in TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  check_out TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (check_out IS NULL OR check_out >= check_in)
);

CREATE TABLE IF NOT EXISTS daily_attendance_breaks (
  id BIGSERIAL PRIMARY KEY,
  attendance_id BIGINT NOT NULL REFERENCES daily_attendance(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_daily_attendance
ON daily_attendance(company_id, user_id)
WHERE check_out IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_daily_break
ON daily_attendance_breaks(attendance_id)
WHERE ended_at IS NULL;