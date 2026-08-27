const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { slugify } = require('../utils/helpers');

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
            (SELECT image_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY sort_order ASC LIMIT 1) AS thumbnail
     FROM products p
     JOIN categories c ON c.id = p.category_id
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
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.slug = ?`,
    [req.params.slug]
  );
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const product = rows[0];

  const [images] = await pool.query(
    'SELECT id, image_path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC',
    [product.id]
  );
  const [variants] = await pool.query(
    'SELECT * FROM product_variants WHERE product_id = ?',
    [product.id]
  );

  res.json({ success: true, product: { ...product, images, variants } });
});

// GET /api/products/id/:id  (used internally by admin edit form)
const getProductById = asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const [images] = await pool.query(
    'SELECT id, image_path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC',
    [req.params.id]
  );
  const [variants] = await pool.query('SELECT * FROM product_variants WHERE product_id = ?', [req.params.id]);
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

  if (req.files && req.files.length > 0) {
    const values = req.files.map((file, idx) => [productId, `/uploads/products/${file.filename}`, idx]);
    await pool.query('INSERT INTO product_images (product_id, image_path, sort_order) VALUES ?', [values]);
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
    const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?', [id]);
    let sortOrder = countRows[0].c;
    const values = req.files.map(file => [id, `/uploads/products/${file.filename}`, sortOrder++]);
    await pool.query('INSERT INTO product_images (product_id, image_path, sort_order) VALUES ?', [values]);
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
