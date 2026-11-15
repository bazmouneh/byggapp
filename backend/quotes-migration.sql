CREATE TABLE IF NOT EXISTS project_quotes (
 id BIGSERIAL PRIMARY KEY,
 company_id BIGINT NOT NULL REFERENCES companies(id),
 project_id BIGINT NOT NULL REFERENCES projects(id),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','rejected')),
 description TEXT NOT NULL DEFAULT '',
 labor_amount NUMERIC(12,2) NOT NULL CHECK(labor_amount >= 0),
 material_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
 other_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(other_amount >= 0),
 discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),
 vat_rate NUMERIC(5,2) NOT NULL DEFAULT 25 CHECK(vat_rate BETWEEN 0 AND 30),
 sent_at TIMESTAMPTZ,
 decided_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_quotes_company_idx ON project_quotes(company_id,project_id,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS project_quotes_one_accepted ON project_quotes(company_id,project_id) WHERE status='accepted';
