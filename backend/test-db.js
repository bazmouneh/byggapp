require("dotenv").config();
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.log("SAKNAS: DATABASE_URL i .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

async function test() {
  try {
    const result = await pool.query("SELECT NOW() AS server_time");
    console.log("LYCKADES! Byggapp är ansluten till PostgreSQL.");
    console.log("Databastid:", result.rows[0].server_time);
  } catch (error) {
    console.log("Anslutningen misslyckades.");
    console.log("Felkod:", error.code || "okänd");
    console.log("Kontrollera Neon-anslutningen och DATABASE_URL.");
  } finally {
    await pool.end();
  }
}

test();
