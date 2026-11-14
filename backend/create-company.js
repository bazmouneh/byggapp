require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

async function main() {
  try {
    const existing = await pool.query(
      "SELECT id, name FROM companies WHERE name = $1 LIMIT 1",
      ["KTG Rörservice AB"]
    );

    if (existing.rows.length > 0) {
      console.log("Företaget finns redan:", existing.rows[0]);
    } else {
      const result = await pool.query(
        "INSERT INTO companies (name) VALUES ($1) RETURNING id, name",
        ["KTG Rörservice AB"]
      );
      console.log("Företaget registrerat:", result.rows[0]);
    }
  } catch (error) {
    console.log("Fel:", error.message);
  } finally {
    await pool.end();
  }
}

main();
