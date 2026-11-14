require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

async function main() {
  try {
    const sql = fs.readFileSync("schema.sql", "utf8");
    await pool.query(sql);
    console.log("KLART! Byggapps databastabeller är skapade.");
  } catch (error) {
    console.error("Databasen kunde inte uppdateras:", error.message);
  } finally {
    await pool.end();
  }
}

main();
