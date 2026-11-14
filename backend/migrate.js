const db=require('./db');
const sql=`
CREATE TABLE IF NOT EXISTS companies (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS app_users (id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),email TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','employee','contractor')),active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(company_id,email));
CREATE TABLE IF NOT EXISTS customers (id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,phone TEXT,email TEXT,address TEXT);
CREATE TABLE IF NOT EXISTS projects (id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),customer_id BIGINT REFERENCES customers(id),project_number TEXT NOT NULL,title TEXT NOT NULL,status TEXT DEFAULT 'open',UNIQUE(company_id,project_number));
CREATE TABLE IF NOT EXISTS employees (id BIGSERIAL PRIMARY KEY,company_id BIGINT REFERENCES companies(id),name TEXT NOT NULL,email TEXT,role TEXT DEFAULT 'employee',hourly_rate NUMERIC(12,2));
CREATE TABLE IF NOT EXISTS time_entries (id BIGSERIAL PRIMARY KEY,employee_id BIGINT REFERENCES employees(id),project_id BIGINT REFERENCES projects(id),check_in TIMESTAMPTZ NOT NULL,check_out TIMESTAMPTZ,break_minutes INTEGER DEFAULT 0,work_type TEXT DEFAULT 'ordinary');
CREATE TABLE IF NOT EXISTS materials (id BIGSERIAL PRIMARY KEY,project_id BIGINT REFERENCES projects(id),name TEXT NOT NULL,quantity NUMERIC(12,2) NOT NULL,unit_price NUMERIC(12,2),supplier TEXT,source TEXT DEFAULT 'vehicle');
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS job_types TEXT[] DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS billing_mode TEXT DEFAULT 'hourly';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hourly_price NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fixed_price NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS min_billable_minutes INTEGER DEFAULT 120;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS vehicle_charge NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rot_percent NUMERIC(5,2) DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS rsk TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(12,2) DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT 'st';
ALTER TABLE materials ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id);
UPDATE materials m SET company_id=p.company_id FROM projects p WHERE m.project_id=p.id AND m.company_id IS NULL;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id);
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES app_users(id);
UPDATE time_entries t SET company_id=p.company_id FROM projects p WHERE t.project_id=p.id AND t.company_id IS NULL;
CREATE TABLE IF NOT EXISTS invoice_drafts(id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),project_id BIGINT NOT NULL REFERENCES projects(id),subtotal NUMERIC(12,2) NOT NULL,discount NUMERIC(12,2) NOT NULL DEFAULT 0,rot_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,total NUMERIC(12,2) NOT NULL,details JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE SEQUENCE IF NOT EXISTS byggapp_customer_seq;
CREATE SEQUENCE IF NOT EXISTS byggapp_project_seq;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_number TEXT;
UPDATE customers SET customer_number='K-'||lpad(id::text,6,'0') WHERE customer_number IS NULL;
SELECT setval('byggapp_customer_seq',GREATEST((SELECT COALESCE(MAX(id),0) FROM customers),1));
SELECT setval('byggapp_project_seq',GREATEST((SELECT COALESCE(MAX(id),0) FROM projects),1));
CREATE UNIQUE INDEX IF NOT EXISTS customer_number_company_unique ON customers(company_id,customer_number);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'service';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS project_assignments (company_id BIGINT NOT NULL REFERENCES companies(id),project_id BIGINT NOT NULL REFERENCES projects(id),user_id BIGINT NOT NULL REFERENCES app_users(id),assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(project_id,user_id));
CREATE INDEX IF NOT EXISTS project_assignments_user ON project_assignments(company_id,user_id);
CREATE TABLE IF NOT EXISTS material_catalog (id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,rsk TEXT,unit TEXT NOT NULL DEFAULT 'st',active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS material_catalog_unique ON material_catalog(company_id,name);
CREATE TABLE IF NOT EXISTS time_breaks (id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),time_entry_id BIGINT NOT NULL REFERENCES time_entries(id),started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),ended_at TIMESTAMPTZ);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_break ON time_breaks(time_entry_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_clock_per_user ON time_entries(user_id) WHERE check_out IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_tenant ON customers(company_id);
CREATE INDEX IF NOT EXISTS projects_tenant ON projects(company_id);
CREATE INDEX IF NOT EXISTS time_tenant ON time_entries(company_id);
CREATE INDEX IF NOT EXISTS materials_tenant ON materials(company_id);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS full_name TEXT;
UPDATE app_users SET full_name=COALESCE(NULLIF(full_name,''),split_part(email,'@',1)) WHERE full_name IS NULL OR full_name='';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pause_reason TEXT;
CREATE TABLE IF NOT EXISTS company_invoice_settings(
 company_id BIGINT PRIMARY KEY REFERENCES companies(id),
 org_number TEXT NOT NULL DEFAULT '', street_address TEXT NOT NULL DEFAULT '',
 postal_address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL DEFAULT '', bankgiro TEXT NOT NULL DEFAULT '',
 payment_terms INTEGER NOT NULL DEFAULT 30, vat_percent NUMERIC(5,2) NOT NULL DEFAULT 25,
 logo_data TEXT NOT NULL DEFAULT ''
);
ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS recipient_email TEXT;
CREATE SEQUENCE IF NOT EXISTS byggapp_invoice_seq;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_number_company_unique ON invoice_drafts(company_id,invoice_number);
CREATE TABLE IF NOT EXISTS employee_pay_rates(company_id BIGINT NOT NULL REFERENCES companies(id),user_id BIGINT NOT NULL REFERENCES app_users(id),ordinary_rate NUMERIC(10,2) NOT NULL DEFAULT 0,jour_rate NUMERIC(10,2) NOT NULL DEFAULT 0,overtime_rate NUMERIC(10,2) NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(company_id,user_id));

`;
(async()=>{try{await db.query(sql);console.log('Databasen uppdaterad!');}catch(e){console.error(e);process.exitCode=1;}finally{await db.end();}})();
