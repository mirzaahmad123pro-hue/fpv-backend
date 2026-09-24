// Additive, idempotent database upgrade — runs once at server start.
//
// Everything here only ADDS things (new tables, one new column on `users`)
// and never drops, renames or rewrites existing data, so it is safe to run
// against your live database on every boot. It works on both MySQL 8 and
// MariaDB: columns/indexes are checked through information_schema instead of
// relying on "ADD COLUMN IF NOT EXISTS" (which MySQL does not support).
//
// The same statements are available as a manual script in
// database/migration_v3.sql if you would rather run them yourself.
//
// Adds:
//   users.google_id          — links a customer to their Google account
//   product_reviews          — 1–5 star ratings + written reviews
//   admin_messages           — messages the admin sends (all customers / one)
//   notifications            — one row per recipient of an admin message
//   announcements            — the website-wide announcement banner
//   support_tickets/messages — customer Help → admin conversations

const { pool } = require('./database');

// Read by controllers so they can degrade gracefully (instead of erroring
// the whole storefront) if the upgrade could not run, e.g. a DB user
// without CREATE/ALTER permission.
const flags = { reviews: false, support: false, messaging: false, google: false };

const CREATE_STATEMENTS = {
  reviews: `
    CREATE TABLE IF NOT EXISTS product_reviews (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      user_id    INT NOT NULL,
      rating     TINYINT NOT NULL,
      comment    TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_review_product_user (product_id, user_id),
      KEY idx_review_product (product_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

  adminMessages: `
    CREATE TABLE IF NOT EXISTS admin_messages (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      type            ENUM('broadcast','direct') NOT NULL,
      title           VARCHAR(150) NOT NULL,
      body            TEXT NOT NULL,
      recipient_id    INT DEFAULT NULL,
      sent_by         INT DEFAULT NULL,
      recipient_count INT NOT NULL DEFAULT 0,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,

  notifications: `
    CREATE TABLE IF NOT EXISTS notifications (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      message_id INT NOT NULL,
      is_read    TINYINT(1) NOT NULL DEFAULT 0,
      read_at    TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_notif_user (user_id, is_read),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES admin_messages(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

  announcements: `
    CREATE TABLE IF NOT EXISTS announcements (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      title      VARCHAR(150) DEFAULT NULL,
      message    TEXT NOT NULL,
      is_active  TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,

  supportTickets: `
    CREATE TABLE IF NOT EXISTS support_tickets (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      user_id         INT NOT NULL,
      subject         VARCHAR(200) NOT NULL,
      status          ENUM('open','replied') NOT NULL DEFAULT 'open',
      admin_unread    TINYINT(1) NOT NULL DEFAULT 1,
      customer_unread TINYINT(1) NOT NULL DEFAULT 0,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_ticket_user (user_id),
      KEY idx_ticket_admin_unread (admin_unread),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

  supportMessages: `
    CREATE TABLE IF NOT EXISTS support_messages (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id  INT NOT NULL,
      sender     ENUM('customer','admin') NOT NULL,
      sender_id  INT DEFAULT NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_smsg_ticket (ticket_id),
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`
};

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(table, indexName) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName]
  );
  return rows.length > 0;
}

// Indexes that speed up the product listing/detail queries in
// productController.js. Purely additive — no column, type, or data change —
// and checked individually first so re-running this never creates a
// duplicate index. category_id is deliberately not listed here: InnoDB
// already auto-creates an index for it to support the products.category_id
// foreign key, so adding another would be redundant.
const PRODUCT_INDEXES = [
  { table: 'products', name: 'idx_products_status', ddl: 'ALTER TABLE products ADD INDEX idx_products_status (status)' },
  { table: 'products', name: 'idx_products_created_at', ddl: 'ALTER TABLE products ADD INDEX idx_products_created_at (created_at)' },
  { table: 'products', name: 'idx_products_featured_created', ddl: 'ALTER TABLE products ADD INDEX idx_products_featured_created (featured, created_at)' },
  { table: 'products', name: 'idx_products_new_arrival_created', ddl: 'ALTER TABLE products ADD INDEX idx_products_new_arrival_created (new_arrival, created_at)' },
  { table: 'product_images', name: 'idx_product_images_product_sort', ddl: 'ALTER TABLE product_images ADD INDEX idx_product_images_product_sort (product_id, sort_order)' }
];

async function ensureProductIndexes(log) {
  for (const idx of PRODUCT_INDEXES) {
    if (!(await indexExists(idx.table, idx.name))) {
      await pool.query(idx.ddl);
      log(`added index ${idx.name} on ${idx.table}`);
    }
  }
}

async function ensureSchema() {
  const log = (msg) => console.log(`🗄️  schema: ${msg}`);
  try {
    // 1) Google sign-in: link column on users (nullable, unique).
    if (!(await columnExists('users', 'google_id'))) {
      await pool.query('ALTER TABLE users ADD COLUMN google_id VARCHAR(64) NULL DEFAULT NULL');
      log('added users.google_id');
    }
    if (!(await indexExists('users', 'uq_users_google_id'))) {
      await pool.query('ALTER TABLE users ADD UNIQUE KEY uq_users_google_id (google_id)');
    }
    flags.google = true;

    // 1b) Product listing performance indexes (see productController.js).
    await ensureProductIndexes(log);

    // 2) Reviews
    await pool.query(CREATE_STATEMENTS.reviews);
    flags.reviews = true;

    // 3) Admin messaging + announcement
    await pool.query(CREATE_STATEMENTS.adminMessages);
    await pool.query(CREATE_STATEMENTS.notifications);
    await pool.query(CREATE_STATEMENTS.announcements);
    flags.messaging = true;

    // 4) Help / support
    await pool.query(CREATE_STATEMENTS.supportTickets);
    await pool.query(CREATE_STATEMENTS.supportMessages);
    flags.support = true;

    // 5) Rebrand the two seeded settings — but only while they still hold the
    //    old default. Anything the admin customised is left alone.
    await pool.query(
      `UPDATE settings SET setting_value = 'Fast Global Eagle'
       WHERE setting_key IN ('store_name','payment_account_name')
         AND setting_value = 'Falcon Peak Venture'`
    );

    log('up to date');
  } catch (err) {
    console.error('⚠️  Database upgrade (config/schema.js) did not fully complete:', err.message);
    console.error('   The store keeps running; the affected new features stay disabled.');
    console.error('   Run database/migration_v3.sql manually with a user that has CREATE/ALTER rights.');
  }
}

module.exports = { ensureSchema, flags, CREATE_STATEMENTS };
