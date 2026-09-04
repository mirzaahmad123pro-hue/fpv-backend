// Database connection pool for MySQL using mysql2 (promise API).
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'fpv-mysql-mirzaahmad123pro-se4b.i.aivencloud.com',
  port: process.env.DB_PORT || 15165,
  user: process.env.DB_USER || 'avnadmin',
  password: process.env.DB_PASSWORD || 'AVNS_GYUHL63Q1GjZU6EUtYX',
  database: process.env.DB_NAME || 'defaultdb',
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

// Quick helper used at server startup to confirm the DB is reachable.
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Connected to MySQL database:', process.env.DB_NAME || 'defaultdb');
    conn.release();
  } catch (err) {
    console.error('❌ Could not connect to MySQL database.');
    console.error('   Error:', err.message);
  }
}

module.exports = pool;
module.exports.testConnection = testConnection;
