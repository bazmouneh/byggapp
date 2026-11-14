CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT,
  role TEXT DEFAULT 'employee',
  hourly_rate NUMERIC(12,2)
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  customer_id BIGINT REFERENCES customers(id),
  project_number TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  UNIQUE(company_id, project_number)
);

CREATE TABLE IF NOT EXISTS time_entries (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT REFERENCES employees(id),
  project_id BIGINT REFERENCES projects(id),
  check_in TIMESTAMPTZ NOT NULL,
  check_out TIMESTAMPTZ,
  break_minutes INTEGER DEFAULT 0,
  work_type TEXT DEFAULT 'ordinary'
);

CREATE TABLE IF NOT EXISTS materials (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id),
  name TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2),
  supplier TEXT,
  source TEXT DEFAULT 'vehicle'
);
