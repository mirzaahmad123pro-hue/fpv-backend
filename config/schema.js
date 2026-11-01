const { pool } = require('./database');

const flags = {
  reviews: false, support: false, messaging: false, google: false, reviewPhotos: false,
  socialMedia: false, variantImages: false,
  categoryParent: false, wishlist: false, statusHistory: false, banners: false
};

const CREATE_STATEMENTS = {
  reviews: `
    CREATE TABLE IF NOT EXISTS product_reviews (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL,
      user_id INT NOT NULL,
      rating SMALLINT NOT NULL,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_review_product_user UNIQUE (product_id, user_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,

  adminMessages: `
    CREATE TABLE IF NOT EXISTS admin_messages (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(150) NOT NULL,
      body TEXT NOT NULL,
      recipient_id INT DEFAULT NULL,
      sent_by INT DEFAULT NULL,
      recipient_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
    )`,

  notifications: `
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      message_id INT NOT NULL,
      is_read SMALLINT NOT NULL DEFAULT 0,
      read_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES admin_messages(id) ON DELETE CASCADE
    )`,

  announcements: `
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(150) DEFAULT NULL,
      message TEXT NOT NULL,
      is_active SMALLINT NOT NULL DEFAULT 1,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )`,

  supportTickets: `
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      subject VARCHAR(200) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'open',
      admin_unread SMALLINT NOT NULL DEFAULT 1,
      customer_unread SMALLINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,

  supportMessages: `
    CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INT NOT NULL,
      sender VARCHAR(50) NOT NULL,
      sender_id INT DEFAULT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    )`,

  socialMediaAccounts: `
    CREATE TABLE IF NOT EXISTS social_media_accounts (
      id SERIAL PRIMARY KEY,
      platform VARCHAR(40) NOT NULL,
      profile_url VARCHAR(500) NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'active',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

  wishlist: `
    CREATE TABLE IF NOT EXISTS wishlist_items (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      product_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_wishlist_user_product UNIQUE (user_id, product_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`,

  orderStatusHistory: `
    CREATE TABLE IF NOT EXISTS order_status_history (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL,
      status VARCHAR(30) NOT NULL,
      note VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )`,

  banners: `
    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      subtitle VARCHAR(255),
      image VARCHAR(500) NOT NULL,
      link_url VARCHAR(500),
      sort_order INT NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
};

async function columnExists(table, column) {
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM information_schema.columns 
       WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [table, column]
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureSchema() {
  const log = (msg) => console.log(`🗄️ schema: ${msg}`);
  try {
    // 1) Google sign-in
    if (!(await columnExists('users', 'google_id'))) {
      await pool.query('ALTER TABLE users ADD COLUMN google_id VARCHAR(64) NULL DEFAULT NULL');
      log('added users.google_id');
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

    // 5) Review photo attachments
    if (!(await columnExists('product_reviews', 'photo_path'))) {
      await pool.query('ALTER TABLE product_reviews ADD COLUMN photo_path VARCHAR(500) NULL DEFAULT NULL');
      log('added product_reviews.photo_path');
    }
    flags.reviewPhotos = true;

    // 5b) Variant image link
    if (!(await columnExists('product_variants', 'image_id'))) {
      await pool.query('ALTER TABLE product_variants ADD COLUMN image_id INT NULL DEFAULT NULL');
      log('added product_variants.image_id');
    }
    flags.variantImages = true;

    // 6) Social media accounts
    await pool.query(CREATE_STATEMENTS.socialMediaAccounts);
    flags.socialMedia = true;

    // 8) Rebrand settings
    await pool.query(
      `UPDATE settings SET setting_value = 'Fast Global Eagle'
       WHERE setting_key IN ('store_name','payment_account_name')
         AND setting_value = 'Falcon Peak Venture'`
    );

    log('up to date');
  } catch (err) {
    console.error('⚠️ Database upgrade (config/schema.js) did not fully complete:', err.message);
    console.error('   The store keeps running; the affected new features stay disabled.');
  }
}

async function ensureRedesignSchema() {
  const log = (msg) => console.log(`🗄️ schema: ${msg}`);
  const step = async (name, fn) => {
    try { await fn(); }
    catch (err) { console.error(`⚠️ schema step "${name}" failed:`, err.message); }
  };

  await step('categories.parent_id', async () => {
    if (!(await columnExists('categories', 'parent_id'))) {
      await pool.query('ALTER TABLE categories ADD COLUMN parent_id INT NULL DEFAULT NULL');
      log('added categories.parent_id');
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
}

module.exports = { ensureSchema, ensureRedesignSchema, flags, CREATE_STATEMENTS };
