// Customer Help / Support ↔ Admin conversations, stored in MySQL
// (support_tickets + support_messages — see config/schema.js).
//
// One customer message opens a ticket. The admin replies to that specific
// ticket, the reply appears in that customer's Help area, and the customer can
// answer back inside the same conversation.

const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { flags } = require('../config/schema');

const MAX_MESSAGE = 2000;

function unavailable(res) {
  return res.status(503).json({ success: false, message: 'Help & Support is temporarily unavailable.' });
}

function cleanBody(body) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { error: 'Please write your message.' };
  if (message.length > MAX_MESSAGE) return { error: `Message must be ${MAX_MESSAGE} characters or fewer.` };
  return { message };
}

function makeSubject(message) {
  const oneLine = message.replace(/\s+/g, ' ');
  return oneLine.length > 70 ? oneLine.slice(0, 67).trimEnd() + '…' : oneLine;
}

// ───────────────────────── CUSTOMER ─────────────────────────

// POST /api/support  { message }  — opens a new ticket
const createTicket = asyncHandler(async (req, res) => {
  if (!flags.support) return unavailable(res);
  if (req.user.role !== 'customer') {
    return res.status(403).json({ success: false, message: 'Help messages are for customer accounts.' });
  }
  const { error, message } = cleanBody(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [t] = await conn.query(
      "INSERT INTO support_tickets (user_id, subject, status, admin_unread, customer_unread) VALUES (?, ?, 'open', 1, 0)",
      [req.user.id, makeSubject(message)]
    );
    await conn.query(
      "INSERT INTO support_messages (ticket_id, sender, sender_id, body) VALUES (?, 'customer', ?, ?)",
      [t.insertId, req.user.id, message]
    );
    await conn.commit();
    res.status(201).json({ success: true, message: 'Your message was sent. We will reply here as soon as we can.', ticket_id: t.insertId });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// GET /api/support  — my conversations
const getMyTickets = asyncHandler(async (req, res) => {
  if (!flags.support) return res.json({ success: true, tickets: [], unread_count: 0 });
  const [tickets] = await pool.query(
    `SELECT t.id, t.subject, t.status, t.customer_unread, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = t.id) AS message_count
     FROM support_tickets t
     WHERE t.user_id = ?
     ORDER BY t.updated_at DESC, t.id DESC
     LIMIT 100`,
    [req.user.id]
  );
  res.json({ success: true, tickets, unread_count: tickets.filter(t => t.customer_unread).length });
});

// GET /api/support/:id  — one of my conversations (marks admin replies as seen)
const getMyTicket = asyncHandler(async (req, res) => {
  if (!flags.support) return unavailable(res);
  const [tickets] = await pool.query('SELECT * FROM support_tickets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Conversation not found.' });

  const [messages] = await pool.query(
    'SELECT id, sender, body, created_at FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC, id ASC',
    [tickets[0].id]
  );
  if (tickets[0].customer_unread) {
    // Keep updated_at as-is: viewing a reply must not re-sort the list.
    await pool.query('UPDATE support_tickets SET customer_unread = 0, updated_at = updated_at WHERE id = ?', [tickets[0].id]);
  }
  res.json({ success: true, ticket: { ...tickets[0], customer_unread: 0 }, messages });
});

// POST /api/support/:id/messages  { message }  — customer follow-up
const customerFollowUp = asyncHandler(async (req, res) => {
  if (!flags.support) return unavailable(res);
  const { error, message } = cleanBody(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  const [tickets] = await pool.query('SELECT id FROM support_tickets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Conversation not found.' });

  await pool.query(
    "INSERT INTO support_messages (ticket_id, sender, sender_id, body) VALUES (?, 'customer', ?, ?)",
    [tickets[0].id, req.user.id, message]
  );
  await pool.query("UPDATE support_tickets SET status = 'open', admin_unread = 1 WHERE id = ?", [tickets[0].id]);
  res.status(201).json({ success: true, message: 'Message sent.' });
});

// ───────────────────────── ADMIN ─────────────────────────

// GET /api/admin/support/unread-count  — drives the badge on the Help icon
const getAdminUnreadCount = asyncHandler(async (req, res) => {
  if (!flags.support) return res.json({ success: true, unread: 0 });
  const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM support_tickets WHERE admin_unread = 1');
  res.json({ success: true, unread: row.c });
});

// GET /api/admin/support  ?status=open|replied
const getAdminTickets = asyncHandler(async (req, res) => {
  if (!flags.support) return unavailable(res);
  const { status } = req.query;
  const where = [];
  const params = [];
  if (['open', 'replied'].includes(status)) { where.push('t.status = ?'); params.push(status); }

  const [tickets] = await pool.query(
    `SELECT t.id, t.subject, t.status, t.admin_unread, t.created_at, t.updated_at,
            u.first_name, u.last_name, u.email,
            (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = t.id) AS message_count
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.admin_unread DESC, t.updated_at DESC, t.id DESC
     LIMIT 200`,
    params
  );
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM support_tickets WHERE admin_unread = 1');
  res.json({ success: true, tickets, unread_count: unread });
});

// GET /api/admin/support/:id  — open a conversation (marks it read)
const getAdminTicket = asyncHandler(async (req, res) => {
  if (!flags.support) return unavailable(res);
  const [tickets] = await pool.query(
    `SELECT t.*, u.first_name, u.last_name, u.email, u.phone
     FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
    [req.params.id]
  );
  if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Conversation not found.' });

  const [messages] = await pool.query(
    'SELECT id, sender, body, created_at FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC, id ASC',
    [tickets[0].id]
  );
  if (tickets[0].admin_unread) {
    await pool.query('UPDATE support_tickets SET admin_unread = 0, updated_at = updated_at WHERE id = ?', [tickets[0].id]);
  }
  res.json({ success: true, ticket: { ...tickets[0], admin_unread: 0 }, messages });
});

// POST /api/admin/support/:id/reply  { message }
const adminReply = asyncHandler(async (req, res) => {
  if (!flags.support) return unavailable(res);
  const { error, message } = cleanBody(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  const [tickets] = await pool.query('SELECT id FROM support_tickets WHERE id = ?', [req.params.id]);
  if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Conversation not found.' });

  await pool.query(
    "INSERT INTO support_messages (ticket_id, sender, sender_id, body) VALUES (?, 'admin', ?, ?)",
    [tickets[0].id, req.user.id, message]
  );
  await pool.query(
    "UPDATE support_tickets SET status = 'replied', admin_unread = 0, customer_unread = 1 WHERE id = ?",
    [tickets[0].id]
  );
  res.status(201).json({ success: true, message: 'Reply sent to the customer.' });
});

module.exports = {
  createTicket, getMyTickets, getMyTicket, customerFollowUp,
  getAdminUnreadCount, getAdminTickets, getAdminTicket, adminReply
};
