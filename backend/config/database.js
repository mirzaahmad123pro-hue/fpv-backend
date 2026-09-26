const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Helper function to map MySQL-style ? placeholders to Postgres $1, $2, etc.
function formatQuery(text) {
  let paramIndex = 1;
  return text.replace(/\?/g, () => `$${paramIndex++}`);
}

// Wrapper for query to keep compatibility with existing controller syntax ([rows])
async function queryWrapper(text, params = []) {
  const formattedSql = formatQuery(text);
  const res = await pool.query(formattedSql, params);
  return [res.rows, res.fields];
}

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ Connected to Supabase PostgreSQL database');
    client.release();
  } catch (err) {
    console.error('❌ Could not connect to Supabase PostgreSQL database:', err.message);
  }
}

const dbExport = {
  pool,
  db: pool,
  query: queryWrapper,
  execute: queryWrapper,
  getConnection: () => pool.connect(),
  testConnection
};

module.exports = dbExport;
