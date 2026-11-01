// Run this ONCE to create your first admin account:
//   1. In backend/.env set INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD
//      (and optionally INITIAL_ADMIN_FIRST_NAME / INITIAL_ADMIN_LAST_NAME)
//   2. From the backend/ folder run:  npm run create-admin
//   3. Log in at /admin/login.html with those credentials
//   4. (Optional) blank out INITIAL_ADMIN_PASSWORD in .env afterwards
//
// This keeps admin credentials OUT of any SQL file or source code —
// they only ever exist in your local, git-ignored .env file.

require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');

async function run() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  const firstName = process.env.INITIAL_ADMIN_FIRST_NAME || 'Store';
  const lastName = process.env.INITIAL_ADMIN_LAST_NAME || 'Owner';

  if (!email || !password) {
    console.error('❌ Please set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD in your .env file first.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('❌ INITIAL_ADMIN_PASSWORD should be at least 8 characters.');
    process.exit(1);
  }

  const [existing] = await pool.query('SELECT id, role FROM users WHERE email = ?', [email]);

  const passwordHash = await bcrypt.hash(password, 12);

  if (existing.length > 0) {
    await pool.query(
      "UPDATE users SET password_hash = ?, role = 'super_admin', status = 'active' WHERE email = ?",
      [passwordHash, email]
    );
    console.log(`✅ Existing user "${email}" updated to super_admin with a new password.`);
  } else {
    await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, status)
       VALUES (?, ?, ?, ?, 'super_admin', 'active')`,
      [firstName, lastName, email, passwordHash]
    );
    console.log(`✅ Admin account created: ${email}`);
  }

  console.log('   You can now log in at /admin/login.html');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Failed to create admin account:', err.message);
  process.exit(1);
});
