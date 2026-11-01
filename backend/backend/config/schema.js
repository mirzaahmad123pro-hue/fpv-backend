// Additive, idempotent database upgrade — runs once at server start.
//
// Everything here only ADDS things (new tables, one new column on `users`)
// and never drops, renames or rewrites existing data, so it is safe to run
// against your live database on every boot. It works on both MySQL 8 and
// MariaDB: columns/indexes are checked through information_schema instead of
// relying on "ADD COLUMN IF NOT EXISTS" (which MySQL does not support).
//
// The same statements are available as manual scripts in
// database/migration_v3.sql and database/migration_v4.sql if you would
// rather run them yourself.
//
// Adds:
//   users.google_id          — links a customer to their Google account
//   product_reviews          — 1–5 star ratings + written reviews
//   admin_messages           — messages the admin sends (all customers / one)
//   notifications            — one row per recipient of an admin message
//   announcements            — the website-wide announcement banner
//   support_tickets/messages — customer Help → admin conversations
//   product_reviews.photo_path   — optional customer photo on a review
//   product_variants.image_id    — links a style/colour to its own gallery photo
//   social_media_accounts        — Admin → Settings → footer "Follow Us" icons
//   categories.parent_id         — subcategories (one level: parent → child)
//   wishlist_items               — customer wishlists (heart button)
//   order_status_history         — timestamps for the order-tracking timeline
//   banners                      — promotional banners for the homepage carousel

const { pool } = require('./database');

// Read by controllers so they can degrade gracefully (instead of erroring
// the whole storefront) if the upgrade could not run, e.g. a DB user
// without CREATE/ALTER permission.
const flags = {
  reviews: false, support: false, messaging: false, google: false, reviewPhotos: false,
  socialMedia: false, variantImages: false,
  categoryParent: false, wishlist: false, statusHistory: false, banners: false
};

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
    ) ENGINE=InnoDB`,

  socialMediaAccounts: `
    CREATE TABLE IF NOT EXISTS social_media_accounts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      platform     VARCHAR(40) NOT NULL,
      profile_url  VARCHAR(500) NOT NULL,
      status       ENUM('active','inactive') NOT NULL DEFAULT 'active',
      sort_order   INT NOT NULL DEFAULT 0,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_social_status_order (status, sort_order)
    ) ENGINE=InnoDB`,

  wishlist: `
    CREATE TABLE IF NOT EXISTS wishlist_items (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      product_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wishlist_user_product (user_id, product_id),
      KEY idx_wishlist_product (product_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

  orderStatusHistory: `
    CREATE TABLE IF NOT EXISTS order_status_history (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      order_id   INT NOT NULL,
      status     VARCHAR(30) NOT NULL,
      note       VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_osh_order (order_id, created_at),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

  banners: `
    CREATE TABLE IF NOT EXISTS banners (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      title      VARCHAR(200) NOT NULL,
      subtitle   VARCHAR(255),
      image      VARCHAR(500) NOT NULL,
      link_url   VARCHAR(500),
      sort_order INT NOT NULL DEFAULT 0,
      status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // 5) Review photo attachments — optional image on a product review.
    if (!(await columnExists('product_reviews', 'photo_path'))) {
      await pool.query('ALTER TABLE product_reviews ADD COLUMN photo_path VARCHAR(500) NULL DEFAULT NULL AFTER comment');
      log('added product_reviews.photo_path');
    }
    flags.reviewPhotos = true;

    // 5b) Variant → image link: lets a style/colour (e.g. "Golden") point at its
    //     own photo in the product gallery. Nullable, so every existing variant
    //     keeps working untouched. No hard FK on purpose: deleting a gallery
    //     image must never be blocked (or cascade) because a variant used it —
    //     the controller nulls stale links instead.
    if (!(await columnExists('product_variants', 'image_id'))) {
      await pool.query('ALTER TABLE product_variants ADD COLUMN image_id INT NULL DEFAULT NULL');
      log('added product_variants.image_id');
    }
    flags.variantImages = true;

    // 6) Admin-managed social media accounts (footer "Follow Us" links)
    await pool.query(CREATE_STATEMENTS.socialMediaAccounts);
    flags.socialMedia = true;

    // 7) Search / filter performance indexes (safe to (re)run — each is
    //    checked individually so an index that already exists is skipped).
    const wantedIndexes = [
      ['product_images', 'idx_pimages_product_order', 'product_id, sort_order'],
      ['products', 'idx_products_sku', 'sku'],
      ['products', 'idx_products_category', 'category_id'],
      ['products', 'idx_products_status', 'status'],
      ['products', 'idx_products_created', 'created_at'],
      ['product_reviews', 'idx_reviews_user', 'user_id'],
      ['orders', 'idx_orders_user', 'user_id']
    ];
    for (const [table, indexName, column] of wantedIndexes) {
      if (!(await indexExists(table, indexName))) {
        await pool.query(`ALTER TABLE ${table} ADD INDEX ${indexName} (${column})`);
        log(`added index ${indexName} on ${table}(${column})`);
      }
    }

    // 8) Rebrand the two seeded settings — but only while they still hold the
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

// Storefront-redesign upgrades. Kept in their own function with one try/catch
// per step, so a failure in one of them (for example a database user without
// ALTER rights) only disables that one feature and can never affect the
// original upgrade steps above.
async function ensureRedesignSchema() {
  const log = (msg) => console.log(`🗄️  schema: ${msg}`);
  const step = async (name, fn) => {
    try { await fn(); }
    catch (err) { console.error(`⚠️  schema step "${name}" failed:`, err.message); }
  };

  // Subcategories: a nullable self-reference (no hard FK on purpose, so an old
  // database can never be blocked from upgrading; the controller keeps it tidy).
  await step('categories.parent_id', async () => {
    if (!(await columnExists('categories', 'parent_id'))) {
      await pool.query('ALTER TABLE categories ADD COLUMN parent_id INT NULL DEFAULT NULL');
      log('added categories.parent_id');
    }
    if (!(await indexExists('categories', 'idx_categories_parent'))) {
      await pool.query('ALTER TABLE categories ADD INDEX idx_categories_parent (parent_id)');
    }
    flags.categoryParent = true;
  });

  await step('wishlist_items', async () => {
    await pool.query(CREATE_STATEMENTS.wishlist);
    flags.wishlist = true;
  });

  await step('order_status_history', async () => {
    await pool.query(CREATE_STATEMENTS.orderStatusHistory);
    flags.statusHistory = true;
  });

  await step('banners', async () => {
    await pool.query(CREATE_STATEMENTS.banners);
    flags.banners = true;
  });

  // Helpful extra indexes for the new listing filters / best-seller sort.
  await step('indexes', async () => {
    const wanted = [
      ['order_items', 'idx_order_items_product', 'product_id'],
      ['products', 'idx_products_featured', 'featured'],
      ['products', 'idx_products_new_arrival', 'new_arrival']
    ];
    for (const [table, indexName, column] of wanted) {
      if (!(await indexExists(table, indexName))) {
        await pool.query(`ALTER TABLE ${table} ADD INDEX ${indexName} (${column})`);
        log(`added index ${indexName} on ${table}(${column})`);
      }
    }
  });
}

module.exports = { ensureSchema, ensureRedesignSchema, flags, CREATE_STATEMENTS };
