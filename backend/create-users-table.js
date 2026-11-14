require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id),
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (
          role IN ('admin', 'employee', 'contractor')
        ),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, email)
      )
    `);

    console.log("KLART! Tabellen för användarkonton är skapad.");
  } catch (error) {
    console.log("Fel vid skapande av tabellen.");
    console.log("Felkod:", error.code || "okänd");
  } finally {
    await pool.end();
  }
}

main();
