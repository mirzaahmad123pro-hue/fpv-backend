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
            COALESCE(
              (SELECT vi.image_path FROM product_images vi WHERE vi.id = v.image_id),
              (SELECT image_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC, pi.id ASC LIMIT 1)
            ) AS thumbnail,
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
  const { product_id, variant_id, quantity = 1, set_quantity } = req.body;
  if (!product_id) {
    return res.status(400).json({ success: false, message: 'product_id is required.' });
  }
  const qty = Math.max(parseInt(quantity, 10) || 1, 1);

  const [products] = await pool.query('SELECT stock_quantity, status FROM products WHERE id = ?', [product_id]);
  if (products.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  if (products[0].status !== 'active') {
    return res.status(400).json({ success: false, message: products[0].status === 'out_of_stock' ? 'Product is out of stock.' : 'This product is not currently available.' });
  }

  // Stock is tracked per variant when the product has styles/variants, so the
  // limit that applies here (and at order time) is the chosen variant's stock —
  // not the product-level number.
  const [variantRows] = await pool.query('SELECT id, stock_quantity FROM product_variants WHERE product_id = ?', [product_id]);
  let availableStock = products[0].stock_quantity;
  let chosenVariantId = null;
  if (variantRows.length > 0) {
    if (!variant_id) {
      return res.status(400).json({ success: false, message: 'Please choose a style/size option first.' });
    }
    const chosen = variantRows.find(v => v.id === Number(variant_id));
    if (!chosen) {
      return res.status(400).json({ success: false, message: 'That option is not available for this product.' });
    }
    availableStock = chosen.stock_quantity;
    chosenVariantId = chosen.id;
  } else if (variant_id) {
    return res.status(400).json({ success: false, message: 'That option is not available for this product.' });
  }
  if (availableStock <= 0) {
    return res.status(400).json({ success: false, message: 'Product is out of stock.' });
  }
  if (qty > availableStock) {
    return res.status(400).json({ success: false, message: `Only ${availableStock} left in stock.` });
  }

  const cartId = await getOrCreateCartId(req.user.id);

  const [existing] = await pool.query(
    'SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_id IS NOT DISTINCT FROM ?',
    [cartId, product_id, chosenVariantId]
  );

  // cartItemId is returned (additive — existing callers that only read
  // `success`/`message` are unaffected) so "Buy Now" can send the customer
  // straight to checkout for exactly this line, without touching the rest
  // of their cart. See orderController.createOrder's optional item_ids.
  let cartItemId;
  if (existing.length > 0) {
    // Normal Add to Cart adds to what is already in the cart. Buy Now sends
    // set_quantity so the line ends up at EXACTLY the quantity the customer
    // chose on the product page (qty is already checked against stock above).
    const newQty = set_quantity ? qty : Math.min(existing[0].quantity + qty, availableStock);
    await pool.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [newQty, existing[0].id]);
    cartItemId = existing[0].id;
  } else {
    const [result] = await pool.query(
      'INSERT INTO cart_items (cart_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?)',
      [cartId, product_id, chosenVariantId, qty]
    );
    cartItemId = result.insertId;
  }

  res.status(201).json({ success: true, message: 'Added to cart.', cart_item_id: cartItemId });
});

// PUT /api/cart/:itemId  { quantity }
const updateCartItem = asyncHandler(async (req, res) => {
  const { quantity } = req.body;
  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1) {
    return res.status(400).json({ success: false, message: 'Quantity must be at least 1.' });
  }

  const [rows] = await pool.query(
    `SELECT ci.id, ci.cart_id, ci.variant_id, p.stock_quantity, v.stock_quantity AS variant_stock, c.user_id
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     JOIN carts c ON c.id = ci.cart_id
     WHERE ci.id = ?`,
    [req.params.itemId]
  );
  if (rows.length === 0 || rows[0].user_id !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Cart item not found.' });
  }
  // Products with styles/sizes track stock per variant (same rule as addToCart
  // and checkout) — checking the product-level number here wrongly blocked or
  // allowed quantity changes for those items.
  const available = Number(rows[0].variant_id ? rows[0].variant_stock : rows[0].stock_quantity) || 0;
  if (qty > available) {
    return res.status(400).json({ success: false, message: `Only ${available} left in stock.` });
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
