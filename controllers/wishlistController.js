// Customer wishlist ("heart" button). Requires login, like the cart.
// Table: wishlist_items (created by config/schema.js).

const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { flags } = require('../config/schema');

function unavailable(res) {
  return res.status(503).json({ success: false, message: 'The wishlist is temporarily unavailable. Please try again later.' });
}

// GET /api/wishlist  — full product cards, newest first
const getWishlist = asyncHandler(async (req, res) => {
  if (!flags.wishlist) return res.json({ success: true, products: [] });
  const rating = flags.reviews
    ? `, (SELECT ROUND(AVG(r.rating), 1) FROM product_reviews r WHERE r.product_id = p.id) AS avg_rating,
       (SELECT COUNT(*) FROM product_reviews r WHERE r.product_id = p.id) AS review_count`
    : '';
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.slug, p.brand, p.regular_price, p.sale_price, p.stock_quantity, p.status,
            c.name AS category_name, c.slug AS category_slug, w.created_at AS added_at,
            (SELECT image_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC, pi.id ASC LIMIT 1) AS thumbnail${rating}
       FROM wishlist_items w
       JOIN products p ON p.id = w.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE w.user_id = ? AND p.status != 'inactive'
      ORDER BY w.created_at DESC, w.id DESC`,
    [req.user.id]
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, products: rows });
});

// GET /api/wishlist/ids  — just the product ids (cheap; used to fill the hearts)
const getWishlistIds = asyncHandler(async (req, res) => {
  if (!flags.wishlist) return res.json({ success: true, ids: [] });
  const [rows] = await pool.query('SELECT product_id FROM wishlist_items WHERE user_id = ?', [req.user.id]);
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, ids: rows.map(r => r.product_id) });
});

// POST /api/wishlist  { product_id }
const addToWishlist = asyncHandler(async (req, res) => {
  if (!flags.wishlist) return unavailable(res);
  const productId = parseInt(req.body.product_id, 10);
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid product is required.' });
  }
  const [products] = await pool.query("SELECT id FROM products WHERE id = ? AND status != 'inactive'", [productId]);
  if (products.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  await pool.query('INSERT INTO wishlist_items (user_id, product_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.user.id, productId]);
  res.status(201).json({ success: true, message: 'Added to your wishlist.' });
});

// DELETE /api/wishlist/:productId
const removeFromWishlist = asyncHandler(async (req, res) => {
  if (!flags.wishlist) return unavailable(res);
  await pool.query('DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?', [req.user.id, req.params.productId]);
  res.json({ success: true, message: 'Removed from your wishlist.' });
});

module.exports = { getWishlist, getWishlistIds, addToWishlist, removeFromWishlist };
