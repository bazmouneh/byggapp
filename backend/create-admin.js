require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const readline = require("readline");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  try {
    const email = (await ask("Ange admin e-post: ")).trim().toLowerCase();
    const password = await ask("Ange lösenord (minst 12 tecken): ");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
      console.log("Ogiltig e-post eller för kort lösenord.");
      return;
    }

    const company = await pool.query(
      "SELECT id FROM companies WHERE name = $1 LIMIT 1",
      ["KTG Rörservice AB"]
    );

    if (company.rows.length === 0) {
      console.log("Företaget hittades inte.");
      return;
    }

    const hash = await bcrypt.hash(password, 12);

    await pool.query(
      `INSERT INTO app_users
       (company_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')`,
      [company.rows[0].id, email, hash]
    );

    console.log("KLART! Administratörskontot är skapat.");
  } catch (error) {
    if (error.code === "23505") {
      console.log("Kontot finns redan.");
    } else {
      console.log("Fel vid registrering:", error.code || "okänt");
    }
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
