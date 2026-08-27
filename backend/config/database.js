// Database connection pool for MySQL using mysql2 (promise API).
// A connection "pool" is reused across requests instead of opening
// a brand-new connection every time, which is much faster and safer.

const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'falcon_peak_venture',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

// Quick helper used at server startup to confirm the DB is reachable.
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Connected to MySQL database:', process.env.DB_NAME);
    conn.release();
  } catch (err) {
    console.error('❌ Could not connect to MySQL database.');
    console.error('   Check your .env DB_HOST / DB_USER / DB_PASSWORD / DB_NAME values.');
    console.error('   Error:', err.message);
  }
}

module.exports = { pool, testConnection };
