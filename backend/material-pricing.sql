CREATE TABLE IF NOT EXISTS project_material_reviews (
  company_id BIGINT NOT NULL REFERENCES companies(id),
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by BIGINT REFERENCES app_users(id),
  PRIMARY KEY(company_id,project_id)
);
