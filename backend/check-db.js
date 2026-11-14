require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

async function main() {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log("BYGGAPP - DATABASTABELLER:");
    result.rows.forEach(row => console.log(row.table_name));
  } catch (error) {
    console.log("Fel vid kontroll av databasen.");
    console.log("Felkod:", error.code || "okänd");
  } finally {
    await pool.end();
  }
}

main();
