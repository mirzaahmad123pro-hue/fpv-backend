const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');

// GET /api/admin/dashboard
const getDashboard = asyncHandler(async (req, res) => {
  const [[{ totalSales }]] = await pool.query(
    "SELECT COALESCE(SUM(total_amount),0) AS totalSales FROM orders WHERE status != 'cancelled'"
  );
  const [[{ totalOrders }]] = await pool.query('SELECT COUNT(*) AS totalOrders FROM orders');
  const [[{ pendingOrders }]] = await pool.query("SELECT COUNT(*) AS pendingOrders FROM orders WHERE status = 'pending'");
  const [[{ totalCustomers }]] = await pool.query("SELECT COUNT(*) AS totalCustomers FROM users WHERE role = 'customer'");
  const [[{ lowStock }]] = await pool.query("SELECT COUNT(*) AS lowStock FROM products WHERE stock_quantity <= 5 AND status = 'active'");

  const [recentOrders] = await pool.query(
    `SELECT o.id, o.order_number, o.total_amount, o.status, o.payment_status, o.created_at,
            u.first_name, u.last_name
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC LIMIT 8`
  );

  const [topProducts] = await pool.query(
    `SELECT p.id, p.name, p.regular_price, p.sale_price, SUM(oi.quantity) AS sold
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     GROUP BY p.id ORDER BY sold DESC LIMIT 5`
  );

  const [recentCustomers] = await pool.query(
    "SELECT id, first_name, last_name, email, created_at FROM users WHERE role = 'customer' ORDER BY created_at DESC LIMIT 5"
  );

  res.json({
    success: true,
    stats: { totalSales, totalOrders, pendingOrders, totalCustomers, lowStock },
    recentOrders,
    topProducts,
    recentCustomers
  });
});

// GET /api/admin/orders  ?status=&payment_status=&search=&page=&limit=
const getAllOrders = asyncHandler(async (req, res) => {
  const { status, payment_status, search, page = 1, limit = 15 } = req.query;
  const where = [];
  const params = [];

  if (status) { where.push('o.status = ?'); params.push(status); }
  if (payment_status) { where.push('o.payment_status = ?'); params.push(payment_status); }
  if (search) {
    where.push('(o.order_number LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  const [orders] = await pool.query(
    `SELECT o.*, u.first_name, u.last_name, u.email
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${whereSql}
     ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereSql}`,
    params
  );

  res.json({ success: true, orders, pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) } });
});

// PUT /api/admin/orders/:id/status  { status }
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, notes } = req.body;
  const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid order status.' });
  }
  await pool.query(
    'UPDATE orders SET status = ?, notes = COALESCE(?, notes) WHERE id = ?',
    [status, notes, req.params.id]
  );
  res.json({ success: true, message: 'Order status updated.' });
});

// GET /api/admin/customers
const getCustomers = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const where = ["role = 'customer'"];
  const params = [];
  if (search) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const [customers] = await pool.query(
    `SELECT id, first_name, last_name, email, phone, status, created_at FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  res.json({ success: true, customers });
});

// GET /api/admin/customers/:id
const getCustomerDetail = asyncHandler(async (req, res) => {
  const [users] = await pool.query(
    "SELECT id, first_name, last_name, email, phone, status, created_at FROM users WHERE id = ? AND role = 'customer'",
    [req.params.id]
  );
  if (users.length === 0) return res.status(404).json({ success: false, message: 'Customer not found.' });

  const [orders] = await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.params.id]);
  res.json({ success: true, customer: users[0], orders });
});

// PUT /api/admin/customers/:id/status  { status: 'active'|'disabled' }
const updateCustomerStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  await pool.query("UPDATE users SET status = ? WHERE id = ? AND role = 'customer'", [status, req.params.id]);
  res.json({ success: true, message: 'Customer status updated.' });
});

// GET /api/admin/payments
const getPayments = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('pay.status = ?'); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [payments] = await pool.query(
    `SELECT pay.*, o.order_number, o.total_amount AS order_total
     FROM payments pay JOIN orders o ON o.id = pay.order_id
     ${whereSql} ORDER BY pay.created_at DESC`,
    params
  );
  res.json({ success: true, payments });
});

// PUT /api/admin/payments/:id  { status, admin_notes }
const updatePayment = asyncHandler(async (req, res) => {
  const { status, admin_notes } = req.body;
  const validStatuses = ['pending', 'verified', 'paid', 'rejected', 'failed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid payment status.' });
  }

  const [payments] = await pool.query('SELECT order_id FROM payments WHERE id = ?', [req.params.id]);
  if (payments.length === 0) return res.status(404).json({ success: false, message: 'Payment not found.' });

  await pool.query('UPDATE payments SET status = ?, admin_notes = ? WHERE id = ?', [status, admin_notes || null, req.params.id]);

  // Keep order.payment_status in sync with the payment record
  await pool.query('UPDATE orders SET payment_status = ? WHERE id = ?', [status, payments[0].order_id]);

  res.json({ success: true, message: 'Payment updated.' });
});

// GET /api/admin/settings
const getSettings = asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings');
  const settings = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  res.json({ success: true, settings });
});

// PUT /api/admin/settings   body: { key: value, key2: value2, ... }
const updateSettings = asyncHandler(async (req, res) => {
  const entries = Object.entries(req.body || {});
  if (entries.length === 0) {
    return res.status(400).json({ success: false, message: 'No settings provided.' });
  }
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, String(value)]
    );
  }
  res.json({ success: true, message: 'Settings updated.' });
});

module.exports = {
  getDashboard, getAllOrders, updateOrderStatus,
  getCustomers, getCustomerDetail, updateCustomerStatus,
  getPayments, updatePayment,
  getSettings, updateSettings
};
