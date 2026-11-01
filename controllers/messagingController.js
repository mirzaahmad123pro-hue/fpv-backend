// Admin → customer messaging, the website-wide announcement, and the
// customer-side notification inbox. All content is stored in MySQL
// (admin_messages / notifications / announcements — see config/schema.js).

const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { flags } = require('../config/schema');

const MAX_TITLE = 150;
const MAX_BODY = 2000;

function unavailable(res) {
  return res.status(503).json({ success: false, message: 'Messaging is temporarily unavailable.' });
}

function cleanMessage(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!title) return { error: 'Please add a subject/title.' };
  if (!message) return { error: 'Please write a message.' };
  if (title.length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or fewer.` };
  if (message.length > MAX_BODY) return { error: `Message must be ${MAX_BODY} characters or fewer.` };
  return { title, message };
}

// ───────────────────────── ADMIN ─────────────────────────

// POST /api/admin/messages/broadcast  { title, message }
const sendToAllCustomers = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  const { error, title, message } = cleanMessage(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [msg] = await conn.query(
      "INSERT INTO admin_messages (type, title, body, sent_by) VALUES ('broadcast', ?, ?, ?)",
      [title, message, req.user.id]
    );
    // One inbox row per active customer, created in a single statement.
    const [fan] = await conn.query(
      "INSERT INTO notifications (user_id, message_id) SELECT id, ? FROM users WHERE role = 'customer' AND status = 'active'",
      [msg.insertId]
    );
    if (fan.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'There are no registered customers to send this to yet.' });
    }
    await conn.query('UPDATE admin_messages SET recipient_count = ? WHERE id = ?', [fan.affectedRows, msg.insertId]);
    await conn.commit();
    res.status(201).json({
      success: true,
      message: `Message sent to ${fan.affectedRows} customer${fan.affectedRows === 1 ? '' : 's'}.`,
      recipients: fan.affectedRows
    });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// POST /api/admin/messages/direct  { user_id, title, message }
const sendToOneCustomer = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  const { error, title, message } = cleanMessage(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  const userId = parseInt(req.body.user_id, 10);
  if (!userId) return res.status(400).json({ success: false, message: 'Please choose a customer.' });

  const [users] = await pool.query(
    "SELECT id, first_name, last_name FROM users WHERE id = ? AND role = 'customer'",
    [userId]
  );
  if (users.length === 0) {
    return res.status(404).json({ success: false, message: 'Customer not found.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [msg] = await conn.query(
      "INSERT INTO admin_messages (type, title, body, recipient_id, sent_by, recipient_count) VALUES ('direct', ?, ?, ?, ?, 1)",
      [title, message, userId, req.user.id]
    );
    await conn.query('INSERT INTO notifications (user_id, message_id) VALUES (?, ?)', [userId, msg.insertId]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  res.status(201).json({
    success: true,
    message: `Message sent to ${users[0].first_name} ${users[0].last_name}.`.replace(/\s+\./, '.')
  });
});

// GET /api/admin/messages  — history of what the admin has sent
const getSentMessages = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  const [messages] = await pool.query(
    `SELECT m.id, m.type, m.title, m.body, m.recipient_count, m.created_at,
            u.first_name AS to_first_name, u.last_name AS to_last_name, u.email AS to_email,
            (SELECT COUNT(*) FROM notifications n WHERE n.message_id = m.id AND n.is_read = 1) AS read_count
     FROM admin_messages m LEFT JOIN users u ON u.id = m.recipient_id
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 100`
  );
  res.json({ success: true, messages });
});

// ── Announcement (one "current" announcement) ──────────────────────

// GET /api/admin/announcement
const getAdminAnnouncement = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  const [rows] = await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 1');
  res.json({ success: true, announcement: rows[0] || null });
});

// PUT /api/admin/announcement  { title?, message, is_active }  — create or edit
const saveAnnouncement = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const isActive = req.body.is_active === false || req.body.is_active === 0 || req.body.is_active === '0' ? 0 : 1;

  if (!message) return res.status(400).json({ success: false, message: 'Please write the announcement.' });
  if (message.length > MAX_BODY) return res.status(400).json({ success: false, message: `Announcement must be ${MAX_BODY} characters or fewer.` });
  if (title.length > MAX_TITLE) return res.status(400).json({ success: false, message: `Title must be ${MAX_TITLE} characters or fewer.` });

  const [rows] = await pool.query('SELECT id FROM announcements ORDER BY id DESC LIMIT 1');
  if (rows.length) {
    await pool.query(
      'UPDATE announcements SET title = ?, message = ?, is_active = ? WHERE id = ?',
      [title || null, message, isActive, rows[0].id]
    );
  } else {
    await pool.query(
      'INSERT INTO announcements (title, message, is_active, created_by) VALUES (?, ?, ?, ?)',
      [title || null, message, isActive, req.user.id]
    );
  }
  const [saved] = await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 1');
  res.json({ success: true, message: rows.length ? 'Announcement updated.' : 'Announcement published.', announcement: saved[0] });
});

// DELETE /api/admin/announcement
const removeAnnouncement = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  await pool.query('DELETE FROM announcements');
  res.json({ success: true, message: 'Announcement removed.' });
});

// ───────────────────────── PUBLIC / CUSTOMER ─────────────────────────

// GET /api/announcements/active  (public)
const getActiveAnnouncement = asyncHandler(async (req, res) => {
  if (!flags.messaging) return res.json({ success: true, announcement: null });
  const [rows] = await pool.query(
    'SELECT id, title, message, updated_at FROM announcements WHERE is_active = 1 ORDER BY id DESC LIMIT 1'
  );
  // Short cache so a busy storefront doesn't hit the DB on every page view.
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, announcement: rows[0] || null });
});

// GET /api/notifications  (logged in)
const getMyNotifications = asyncHandler(async (req, res) => {
  if (!flags.messaging) return res.json({ success: true, notifications: [], unread_count: 0 });
  const [notifications] = await pool.query(
    `SELECT n.id, n.is_read, n.created_at, m.title, m.body, m.type
     FROM notifications n JOIN admin_messages m ON m.id = n.message_id
     WHERE n.user_id = ?
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT 50`,
    [req.user.id]
  );
  const [[{ unread }]] = await pool.query(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0',
    [req.user.id]
  );
  res.json({ success: true, notifications, unread_count: unread });
});

// GET /api/notifications/unread-count  — light endpoint used for the badge
const getUnreadCounts = asyncHandler(async (req, res) => {
  let notifications = 0;
  let support = 0;
  if (flags.messaging) {
    const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
    notifications = row.c;
  }
  if (flags.support) {
    const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ? AND customer_unread = 1', [req.user.id]);
    support = row.c;
  }
  res.json({ success: true, notifications, support, total: notifications + support });
});

// PUT /api/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  await pool.query('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ success: true });
});

// PUT /api/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  if (!flags.messaging) return unavailable(res);
  await pool.query(
    'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND user_id = ? AND is_read = 0',
    [req.params.id, req.user.id]
  );
  res.json({ success: true });
});

module.exports = {
  sendToAllCustomers, sendToOneCustomer, getSentMessages,
  getAdminAnnouncement, saveAnnouncement, removeAnnouncement,
  getActiveAnnouncement, getMyNotifications, getUnreadCounts, markAllRead, markRead
};
