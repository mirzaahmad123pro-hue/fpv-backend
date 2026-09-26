const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { slugify } = require('../utils/helpers');
const { uploadToImgBB } = require('../utils/imgbbHelper');

// Safe import if config/schema.js does not exist
let flags = { reviews: false };
try {
  flags = require('../config/schema').flags || flags;
} catch (e) {
  // schema file missing fallback
}

// Average rating + review count, only selected once the reviews table exists
// so a failed schema upgrade can never break the product listing.
function ratingColumns() {
  return flags.reviews
    ? `, (SELECT ROUND(AVG(r.rating), 1) FROM product_reviews r WHERE r.product_id = p.id) AS avg_rating,
       (SELECT COUNT(*) FROM product_reviews r WHERE r.product_id = p.id) AS review_count`
    : '';
}

// ── List-query versions of the above ────────────────────────────────────
// getProducts() used to select the thumbnail, avg_rating and review_count
// via three correlated subqueries per row (so a 12-row page ran 36 extra
// lookups, and the admin panel's limit=100 view ran 300). These do the same
// job with one JOIN each, computed once per request instead of once per row.
//
// Thumbnail: one row per product_id — its image with the lowest sort_order —
// picked with ROW_NUMBER() instead of a per-product "ORDER BY ... LIMIT 1"
// subquery. Backed by the new (product_id, sort_order) index (see schema.js),
// which lets this run as an ordered index scan with no extra filesort.
// "id ASC" is a tiebreaker for the (unexpected) case of two images sharing
// a sort_order — the app always assigns unique sort_order values on upload,
// but this keeps the pick deterministic either way.
const THUMBNAIL_JOIN = `
     LEFT JOIN (
       SELECT product_id, image_path FROM (
         SELECT product_id, image_path,
                ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY sort_order ASC, id ASC) AS rn
         FROM product_images
       ) ranked
       WHERE rn = 1
     ) thumb ON thumb.product_id = p.id`;

// Ratings: AVG/COUNT computed once per product_id via GROUP BY, then joined
// in, instead of two correlated subqueries per row.
function ratingJoinClause() {
  return flags.reviews
    ? `LEFT JOIN (
         SELECT product_id, ROUND(AVG(rating), 1) AS avg_rating, COUNT(*) AS review_count
         FROM product_reviews
         GROUP BY product_id
       ) rv ON rv.product_id = p.id`
    : '';
}
function ratingJoinColumns() {
  // COALESCE the count to 0 (not null) for a product with no reviews yet —
  // matching the original COUNT(*) subquery, which returns 0 rather than
  // null for an empty set. avg_rating stays null in both versions, since
  // AVG() of an empty set is null either way.
  return flags.reviews ? ', rv.avg_rating, COALESCE(rv.review_count, 0) AS review_count' : '';
}

// GET /api/products
// Supports: ?category=slug  ?search=term  ?sort=price_asc|price_low... ?featured=1
// ?new_arrival=1  ?gender=men  ?page=1  ?limit=12
const getProducts = asyncHandler(async (req, res) => {
  const {
    category, search, sort, featured, new_arrival, gender,
    page = 1, limit = 12
  } = req.query;

  const where = ["p.status != 'inactive'"];
  const params = [];

  if (category) {
    where.push('c.slug = ?');
    params.push(category);
  }
  if (search) {
    where.push('(p.name LIKE ? OR p.short_description LIKE ? OR p.brand LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (featured === '1') {
    where.push('p.featured = 1');
  }
  if (new_arrival === '1') {
    where.push('p.new_arrival = 1');
  }
  if (gender) {
    where.push('p.gender_or_target = ?');
    params.push(gender);
  }

  let orderBy = 'p.created_at DESC';
  if (sort === 'price_asc') orderBy = 'COALESCE(p.sale_price, p.regular_price) ASC';
  if (sort === 'price_desc') orderBy = 'COALESCE(p.sale_price, p.regular_price) DESC';
  if (sort === 'name_asc') orderBy = 'p.name ASC';
  if (sort === 'newest') orderBy = 'p.created_at DESC';

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
            thumb.image_path AS thumbnail${ratingJoinColumns()}
     FROM products p
     JOIN categories c ON c.id = p.category_id
     ${THUMBNAIL_JOIN}
     ${ratingJoinClause()}
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM products p JOIN categories c ON c.id = p.category_id ${whereSql}`,
    params
  );
  const total = countRows[0].total;

  res.json({
    success: true,
    products: rows,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum)
    }
  });
});

// GET /api/products/:slug
const getProductBySlug = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug${ratingColumns()}
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.slug = ?`,
    [req.params.slug]
  );
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const product = rows[0];

  // Independent of each other — run together instead of one after the other.
  const [[images], [variants]] = await Promise.all([
    pool.query(
      'SELECT id, image_path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC',
      [product.id]
    ),
    pool.query('SELECT * FROM product_variants WHERE product_id = ?', [product.id])
  ]);

  res.json({ success: true, product: { ...product, images, variants } });
});

// GET /api/products/id/:id  (used internally by admin edit form)
const getProductById = asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const [[images], [variants]] = await Promise.all([
    pool.query(
      'SELECT id, image_path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC',
      [req.params.id]
    ),
    pool.query('SELECT * FROM product_variants WHERE product_id = ?', [req.params.id])
  ]);
  res.json({ success: true, product: { ...rows[0], images, variants } });
});

// POST /api/products  (admin) — multipart/form-data, field "images" (multiple)
const createProduct = asyncHandler(async (req, res) => {
  const {
    category_id, name, sku, brand, short_description, full_description,
    regular_price, sale_price, stock_quantity, status, featured, new_arrival,
    gender_or_target, variants
  } = req.body;

  if (!category_id || !name || !regular_price) {
    return res.status(400).json({ success: false, message: 'Category, name, and regular price are required.' });
  }

  const slug = slugify(name);
  const [existing] = await pool.query('SELECT id FROM products WHERE slug = ?', [slug]);
  if (existing.length > 0) {
    return res.status(409).json({ success: false, message: 'A product with a similar name already exists.' });
  }

  const [result] = await pool.query(
    `INSERT INTO products
     (category_id, name, slug, sku, brand, short_description, full_description,
      regular_price, sale_price, stock_quantity, status, featured, new_arrival, gender_or_target)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      category_id, name, slug, sku || null, brand || null,
      short_description || null, full_description || null,
      regular_price, sale_price || null, stock_quantity || 0,
      status || 'active', featured ? 1 : 0, new_arrival ? 1 : 0,
      gender_or_target || 'n/a'
    ]
  );

  const productId = result.insertId;

  // Upload each image buffer to ImgBB and store the returned CDN URLs.
  // The product row already exists at this point, so an upload failure
  // here is reported as a 502 (upstream/dependency failure) rather than
  // a generic 500 — the product itself was created successfully, it just
  // has no images yet and can be edited to add them once ImgBB is
  // reachable again.
  if (req.files && req.files.length > 0) {
    try {
      const uploadedUrls = await Promise.all(
        req.files.map(file => uploadToImgBB(file.buffer))
      );
      const values = uploadedUrls.map((url, idx) => [productId, url, idx]);
      await pool.query('INSERT INTO product_images (product_id, image_path, sort_order) VALUES ?', [values]);
    } catch (uploadErr) {
      return res.status(502).json({
        success: false,
        message: `Product created, but uploading images to ImgBB failed: ${uploadErr.message}`,
        productId
      });
    }
  }

  if (variants) {
    try {
      const parsedVariants = typeof variants === 'string' ? JSON.parse(variants) : variants;
      if (Array.isArray(parsedVariants) && parsedVariants.length > 0) {
        const values = parsedVariants.map(v => [
          productId, v.size || null, v.color || null, v.sku || null,
          v.price_adjustment || 0, v.stock_quantity || 0
        ]);
        await pool.query(
          'INSERT INTO product_variants (product_id, size, color, sku, price_adjustment, stock_quantity) VALUES ?',
          [values]
        );
      }
    } catch (e) {
      // Ignore malformed variants JSON rather than failing the whole request
      console.warn('Could not parse variants JSON:', e.message);
    }
  }

  res.status(201).json({ success: true, message: 'Product created.', productId });
});

// PUT /api/products/:id  (admin)
const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [existingRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
  if (existingRows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const existing = existingRows[0];

  const {
    category_id, name, sku, brand, short_description, full_description,
    regular_price, sale_price, stock_quantity, status, featured, new_arrival,
    gender_or_target
  } = req.body;

  const slug = name ? slugify(name) : existing.slug;

  await pool.query(
    `UPDATE products SET
       category_id = ?, name = ?, slug = ?, sku = ?, brand = ?,
       short_description = ?, full_description = ?, regular_price = ?,
       sale_price = ?, stock_quantity = ?, status = ?, featured = ?,
       new_arrival = ?, gender_or_target = ?
     WHERE id = ?`,
    [
      category_id || existing.category_id,
      name || existing.name,
      slug,
      sku ?? existing.sku,
      brand ?? existing.brand,
      short_description ?? existing.short_description,
      full_description ?? existing.full_description,
      regular_price || existing.regular_price,
      sale_price === '' ? null : (sale_price ?? existing.sale_price),
      stock_quantity ?? existing.stock_quantity,
      status || existing.status,
      featured !== undefined ? (featured ? 1 : 0) : existing.featured,
      new_arrival !== undefined ? (new_arrival ? 1 : 0) : existing.new_arrival,
      gender_or_target || existing.gender_or_target,
      id
    ]
  );

  if (req.files && req.files.length > 0) {
    try {
      const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?', [id]);
      let sortOrder = countRows[0].c;
      const uploadedUrls = await Promise.all(
        req.files.map(file => uploadToImgBB(file.buffer))
      );
      const values = uploadedUrls.map(url => [id, url, sortOrder++]);
      await pool.query('INSERT INTO product_images (product_id, image_path, sort_order) VALUES ?', [values]);
    } catch (uploadErr) {
      return res.status(502).json({
        success: false,
        message: `Product updated, but uploading new images to ImgBB failed: ${uploadErr.message}`
      });
    }
  }

  res.json({ success: true, message: 'Product updated.' });
});

// DELETE /api/products/:id  (admin) — blocks deletion if referenced by an order
const deleteProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [orderItems] = await pool.query('SELECT id FROM order_items WHERE product_id = ? LIMIT 1', [id]);
  if (orderItems.length > 0) {
    // Soft delete: mark inactive instead of destroying order history integrity
    await pool.query("UPDATE products SET status = 'inactive' WHERE id = ?", [id]);
    return res.json({
      success: true,
      message: 'This product has past orders, so it was deactivated instead of permanently deleted (to preserve order history).'
    });
  }

  await pool.query('DELETE FROM products WHERE id = ?', [id]);
  res.json({ success: true, message: 'Product permanently deleted.' });
});

// DELETE /api/products/images/:imageId  (admin)
const deleteProductImage = asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM product_images WHERE id = ?', [req.params.imageId]);
  res.json({ success: true, message: 'Image removed.' });
});

module.exports = {
  getProducts, getProductBySlug, getProductById,
  createProduct, updateProduct, deleteProduct, deleteProductImage
};
