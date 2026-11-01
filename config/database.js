const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

const pgPool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl: { rejectUnauthorized: false }
      }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: { rejectUnauthorized: false }
      }
);

// MySQL (?) queries ko PostgreSQL ($1, $2) mein auto-convert karne ka function
function convertSql(sql) {
  let index = 1;
  let converted = sql.replace(/\?/g, () => `$${index++}`);
  // MySQL backticks (`) ko hatayein
  converted = converted.replace(/`/g, '');
  return converted;
}

const pool = {
  query: async (sql, params = []) => {
    const pgSql = convertSql(sql);
    const isInsert = /^\s*INSERT\s+INTO/i.test(pgSql) && !/RETURNING\s+/i.test(pgSql);
    const finalSql = isInsert ? `${pgSql} RETURNING id` : pgSql;

    try {
      const res = await pgPool.query(finalSql, params);
      if (isInsert) {
        const arr = res.rows;
        arr.insertId = res.rows[0]?.id;
        arr.affectedRows = res.rowCount;
        arr.rows = res.rows;
        return [arr, res.fields];
      }
      if (/^\s*(UPDATE|DELETE)/i.test(pgSql)) {
        return [{ affectedRows: res.rowCount, rows: res.rows }, res.fields];
      }
      const rows = res.rows;
      rows.rows = res.rows;
      return [rows, res.fields];
    } catch (err) {
      // Agar RETURNING id kisi table (jaise settings) par na chale toh normal query chalayein
      if (isInsert && err.message.includes('column "id" does not exist')) {
        const res = await pgPool.query(pgSql, params);
        return [{ insertId: null, affectedRows: res.rowCount, rows: res.rows }, res.fields];
      }
      throw err;
    }
  },

  connect: async () => {
    const client = await pgPool.connect();
    return {
      query: async (sql, params = []) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
          return client.query(sql);
        }
        const pgSql = convertSql(sql);
        const isInsert = /^\s*INSERT\s+INTO/i.test(pgSql) && !/RETURNING\s+/i.test(pgSql);
        const finalSql = isInsert ? `${pgSql} RETURNING id` : pgSql;
        const res = await client.query(finalSql, params);
        if (isInsert) {
          const arr = res.rows;
          arr.insertId = res.rows[0]?.id;
          arr.affectedRows = res.rowCount;
          arr.rows = res.rows;
          return [arr, res.fields];
        }
        const rows = res.rows;
        rows.rows = res.rows;
        return [rows, res.fields];
      },
      beginTransaction: () => client.query('BEGIN'),
      commit: () => client.query('COMMIT'),
      rollback: () => client.query('ROLLBACK'),
      release: () => client.release()
    };
  },

  getConnection: async function () {
    return this.connect();
  }
};

async function testConnection() {
  try {
    await pgPool.query('SELECT 1');
    console.log('✅ Connected to PostgreSQL database successfully.');
    return true;
  } catch (err) {
    console.error('❌ Could not connect to PostgreSQL database:', err.message);
    return false;
  }
}

module.exports = { pool, testConnection };
