const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');

// Every logged-in user has exactly one cart row; create it lazily on first use.
async function getOrCreateCartId(userId) {
  const [rows] = await pool.query('SELECT id FROM carts WHERE user_id = ?', [userId]);
  if (rows.length > 0) return rows[0].id;
  const [result] = await pool.query('INSERT INTO carts (user_id) VALUES (?)', [userId]);
  return result.insertId;
}

// GET /api/cart
const getCart = asyncHandler(async (req, res) => {
  const cartId = await getOrCreateCartId(req.user.id);

  const [items] = await pool.query(
    `SELECT ci.id, ci.quantity, ci.variant_id,
            p.id AS product_id, p.name, p.slug, p.regular_price, p.sale_price, p.stock_quantity,
            (SELECT image_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY sort_order ASC LIMIT 1) AS thumbnail,
            v.size, v.color, v.price_adjustment, v.stock_quantity AS variant_stock
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     WHERE ci.cart_id = ?`,
    [cartId]
  );

  let subtotal = 0;
  const formatted = items.map(item => {
    const basePrice = item.sale_price ? Number(item.sale_price) : Number(item.regular_price);
    const unitPrice = basePrice + Number(item.price_adjustment || 0);
    const lineTotal = unitPrice * item.quantity;
    subtotal += lineTotal;
    return { ...item, unit_price: unitPrice, line_total: lineTotal };
  });

  res.json({ success: true, items: formatted, subtotal });
});

// POST /api/cart  { product_id, variant_id, quantity }
const addToCart = asyncHandler(async (req, res) => {
  const { product_id, variant_id, quantity = 1 } = req.body;
  if (!product_id) {
    return res.status(400).json({ success: false, message: 'product_id is required.' });
  }
  const qty = Math.max(parseInt(quantity, 10) || 1, 1);

  const [products] = await pool.query('SELECT stock_quantity, status FROM products WHERE id = ?', [product_id]);
  if (products.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  if (products[0].status !== 'active') {
    return res.status(400).json({ success: false, message: 'This product is not currently available.' });
  }
  if (qty > products[0].stock_quantity) {
    return res.status(400).json({ success: false, message: `Only ${products[0].stock_quantity} left in stock.` });
  }

  const cartId = await getOrCreateCartId(req.user.id);

  const [existing] = await pool.query(
    'SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_id <=> ?',
    [cartId, product_id, variant_id || null]
  );

  if (existing.length > 0) {
    const newQty = Math.min(existing[0].quantity + qty, products[0].stock_quantity);
    await pool.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [newQty, existing[0].id]);
  } else {
    await pool.query(
      'INSERT INTO cart_items (cart_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?)',
      [cartId, product_id, variant_id || null, qty]
    );
  }

  res.status(201).json({ success: true, message: 'Added to cart.' });
});

// PUT /api/cart/:itemId  { quantity }
const updateCartItem = asyncHandler(async (req, res) => {
  const { quantity } = req.body;
  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1) {
    return res.status(400).json({ success: false, message: 'Quantity must be at least 1.' });
  }

  const [rows] = await pool.query(
    `SELECT ci.id, ci.cart_id, p.stock_quantity, c.user_id
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     JOIN carts c ON c.id = ci.cart_id
     WHERE ci.id = ?`,
    [req.params.itemId]
  );
  if (rows.length === 0 || rows[0].user_id !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Cart item not found.' });
  }
  if (qty > rows[0].stock_quantity) {
    return res.status(400).json({ success: false, message: `Only ${rows[0].stock_quantity} left in stock.` });
  }

  await pool.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [qty, req.params.itemId]);
  res.json({ success: true, message: 'Cart updated.' });
});

// DELETE /api/cart/:itemId
const removeCartItem = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ci.id, c.user_id FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE ci.id = ?`,
    [req.params.itemId]
  );
  if (rows.length === 0 || rows[0].user_id !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Cart item not found.' });
  }
  await pool.query('DELETE FROM cart_items WHERE id = ?', [req.params.itemId]);
  res.json({ success: true, message: 'Item removed from cart.' });
});

module.exports = { getCart, addToCart, updateCartItem, removeCartItem, getOrCreateCartId };
