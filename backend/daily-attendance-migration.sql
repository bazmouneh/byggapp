-- Safe, additive changes; existing project time and invoices are untouched.
ALTER TABLE daily_attendance
  ADD COLUMN IF NOT EXISTS manual_break_seconds INTEGER;
CREATE TABLE IF NOT EXISTS daily_attendance_edits (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  attendance_id BIGINT NOT NULL REFERENCES daily_attendance(id),
  edited_by BIGINT NOT NULL REFERENCES app_users(id),
  previous_check_in TIMESTAMPTZ NOT NULL,
  previous_check_out TIMESTAMPTZ,
  previous_manual_break_seconds INTEGER,
  new_check_in TIMESTAMPTZ NOT NULL,
  new_check_out TIMESTAMPTZ,
  new_manual_break_seconds INTEGER,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS daily_attendance_company_month
  ON daily_attendance(company_id,check_in);
CREATE INDEX IF NOT EXISTS daily_attendance_edits_lookup
  ON daily_attendance_edits(company_id,attendance_id,created_at);
