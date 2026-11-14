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

async function main() {
  try {
    const email = await new Promise(resolve =>
      rl.question("Ange din admin-e-post: ", resolve)
    );

    const password = await new Promise(resolve =>
      rl.question("Ange nytt lösenord (minst 12 tecken): ", resolve)
    );

    if (password.length < 12) {
      console.log("Lösenordet måste vara minst 12 tecken.");
      return;
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `UPDATE app_users
       SET password_hash = $1
       WHERE LOWER(email) = LOWER($2)
       AND company_id = 1
       AND role = 'admin'
       RETURNING id`,
      [hash, email.trim()]
    );

    console.log(result.rowCount === 1
      ? "KLART! Ditt lösenord har ändrats."
      : "Administratörskontot hittades inte.");

  } catch (error) {
    console.log("Ett fel uppstod:", error.message);
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
