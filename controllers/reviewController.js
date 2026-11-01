const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { flags } = require('../config/schema');
const { uploadToImgBB } = require('../utils/imgbbHelper');
const { detectImageType } = require('../utils/imageValidation');

const MAX_COMMENT = 1000;

function unavailable(res) {
  return res.status(503).json({ success: false, message: 'Reviews are temporarily unavailable.' });
}

function publicName(first, last) {
  const f = (first || 'Customer').trim();
  const l = (last || '').trim();
  return l ? `${f} ${l[0].toUpperCase()}.` : f;
}

// GET /api/reviews/product/:productId
const getProductReviews = asyncHandler(async (req, res) => {
  if (!flags.reviews) return unavailable(res);
  const productId = parseInt(req.params.productId, 10);
  if (!productId) return res.status(400).json({ success: false, message: 'Invalid product.' });

  const [rows] = await pool.query(
    `SELECT r.id, r.user_id, r.rating, r.comment, r.photo_path, r.created_at, r.updated_at,
            u.first_name, u.last_name
     FROM product_reviews r JOIN users u ON u.id = r.user_id
     WHERE r.product_id = ?
     ORDER BY r.created_at DESC
     LIMIT 200`,
    [productId]
  );

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  rows.forEach(r => { distribution[r.rating] += 1; sum += r.rating; });

  const myId = req.user ? req.user.id : null;
  const reviews = rows.map(r => ({
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    photo_url: r.photo_path || null,
    author: publicName(r.first_name, r.last_name),
    created_at: r.created_at,
    updated_at: r.updated_at,
    is_mine: myId !== null && r.user_id === myId
  }));

  res.json({
    success: true,
    summary: {
      count: rows.length,
      average: rows.length ? Math.round((sum / rows.length) * 10) / 10 : 0,
      distribution
    },
    reviews,
    my_review: reviews.find(r => r.is_mine) || null
  });
});

// POST /api/reviews
const saveReview = asyncHandler(async (req, res) => {
  if (!flags.reviews) return unavailable(res);
  if (req.user.role !== 'customer') {
    return res.status(403).json({ success: false, message: 'Only customer accounts can review products.' });
  }

  const productId = parseInt(req.body.product_id, 10);
  const rawRating = req.body.rating;
  const rating = (typeof rawRating === 'number' || (typeof rawRating === 'string' && /^\s*\d+\s*$/.test(rawRating))) ? Number(rawRating) : NaN;
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';

  if (!productId) return res.status(400).json({ success: false, message: 'Product is required.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, message: 'Please choose a rating from 1 to 5 stars.' });
  }
  if (comment.length > MAX_COMMENT) {
    return res.status(400).json({ success: false, message: `Review must be ${MAX_COMMENT} characters or fewer.` });
  }

  // Verify that the customer has a DELIVERED order containing this product
  const [deliveredCheck] = await pool.query(
    `SELECT o.id FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = ? AND oi.product_id = ? AND o.status = 'delivered'
     LIMIT 1`,
    [req.user.id, productId]
  );

  if (deliveredCheck.length === 0) {
    return res.status(403).json({ 
      success: false, 
      message: 'You can only review products from successfully delivered orders.' 
    });
  }

  const [products] = await pool.query("SELECT id FROM products WHERE id = ? AND status != 'inactive'", [productId]);
  if (products.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  const [existing] = await pool.query(
    'SELECT id, photo_path FROM product_reviews WHERE product_id = ? AND user_id = ?',
    [productId, req.user.id]
  );

  let photoPath = existing.length ? existing[0].photo_path : null;
  if (req.file) {
    if (!flags.reviewPhotos) {
      return res.status(503).json({ success: false, message: 'Review photos are temporarily unavailable.' });
    }
    if (!detectImageType(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'That file is not a valid JPG, PNG, or WEBP image.' });
    }
    try {
      photoPath = await uploadToImgBB(req.file.buffer);
    } catch (uploadErr) {
      return res.status(502).json({ success: false, message: 'Your photo could not be uploaded. Please try again, or post the review without a photo.' });
    }
  } else if (req.body.remove_photo === '1' || req.body.remove_photo === 1 || req.body.remove_photo === true) {
    photoPath = null;
  }

  if (flags.reviewPhotos) {
    await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, rating, comment, photo_path)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (product_id, user_id) 
       DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, photo_path = EXCLUDED.photo_path`,
      [productId, req.user.id, rating, comment || null, photoPath]
    );
  } else {
    await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (product_id, user_id) 
       DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment`,
      [productId, req.user.id, rating, comment || null]
    );
  }

  res.status(existing.length ? 200 : 201).json({
    success: true,
    message: existing.length ? 'Your review was updated.' : 'Thanks! Your review was posted.'
  });
});

// DELETE /api/reviews/:id
const deleteMyReview = asyncHandler(async (req, res) => {
  if (!flags.reviews) return unavailable(res);
  const [result] = await pool.query(
    'DELETE FROM product_reviews WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ success: false, message: 'Review not found.' });
  }
  res.json({ success: true, message: 'Your review was removed.' });
});

module.exports = { getProductReviews, saveReview, deleteMyReview };
