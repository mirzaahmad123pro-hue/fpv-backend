// POST /api/reviews  (multipart/form-data)
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

  // ── Verify that the customer has a DELIVERED order containing this product ──
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
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), photo_path = VALUES(photo_path)`,
      [productId, req.user.id, rating, comment || null, photoPath]
    );
  } else {
    await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
      [productId, req.user.id, rating, comment || null]
    );
  }

  res.status(existing.length ? 200 : 201).json({
    success: true,
    message: existing.length ? 'Your review was updated.' : 'Thanks! Your review was posted.'
  });
});
