const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { slugify } = require('../utils/helpers');
const axios = require('axios');
const FormData = require('form-data');

// Helper function to upload file to ImgBB
const uploadToImgBB = async (fileBuffer) => {
  const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '0257924d31bc4310078776acd495e8db';
  const formData = new FormData();
  formData.append('image', fileBuffer.toString('base64'));

  const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, formData, {
    headers: formData.getHeaders(),
  });

  if (response.data && response.data.data && response.data.data.url) {
    return response.data.data.url;
  } else {
    throw new Error('Image upload to ImgBB failed');
  }
};

// GET /api/products
const getProducts = asyncHandler(async (req, res) => {
  const { category, search, sort, featured, new_arrival, gender, page = 1, limit = 12 } = req.query;

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
    where.push('(p.gender = ? OR p.gender = "unisex")');
    params.push(gender);
  }

  let orderBy = 'p.created_at DESC';
  if (sort === 'price_asc') orderBy = 'p.price ASC';
  if (sort === 'price_desc') orderBy = 'p.price DESC';
  if (sort === 'rating') orderBy = 'p.rating DESC';
  if (sort === 'newest') orderBy = 'p.created_at DESC';

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const countSql = `SELECT COUNT(DISTINCT p.id) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause}`;
  const [countResult] = await pool.execute(countSql, params);
  const total = countResult[0].total;

  const sql = `
    SELECT 
      p.*,
      c.name as category_name, c.slug as category_slug,
      (SELECT JSON_ARRAYAGG(image_url) FROM product_images WHERE product_id = p.id) as images,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('size', size, 'color', color, 'stock', stock)) FROM product_variants WHERE product_id = p.id) as variants
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const [products] = await pool.execute(sql, [...params, String(parseInt(limit)), String(offset)]);

  const formatted = products.map(p => ({
    ...p,
    images: typeof p.images === 'string' ? JSON.parse(p.images) : (p.images || []),
    variants: typeof p.variants === 'string' ? JSON.parse(p.variants) : (p.variants || [])
  }));

  res.json({
    success: true,
    data: formatted,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// GET /api/products/:slug
const getProductBySlug = asyncHandler(async (req, res) => {
  const sql = `
    SELECT 
      p.*,
      c.name as category_name, c.slug as category_slug,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'image_url', image_url, 'is_primary', is_primary)) FROM product_images WHERE product_id = p.id) as images,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'size', size, 'color', color, 'stock', stock, 'sku', sku)) FROM product_variants WHERE product_id = p.id) as variants
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.slug = ? AND p.status != 'inactive'
  `;

  const [products] = await pool.execute(sql, [req.params.slug]);

  if (!products.length) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const product = products[0];
  product.images = typeof product.images === 'string' ? JSON.parse(product.images) : (product.images || []);
  product.variants = typeof product.variants === 'string' ? JSON.parse(product.variants) : (product.variants || []);

  const [related] = await pool.execute(
    `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
      (SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary = 1 LIMIT 1) as primary_image
     FROM products p WHERE p.category_id = ? AND p.id != ? AND p.status = 'active' LIMIT 4`,
    [product.category_id, product.id]
  );

  res.json({ success: true, data: { ...product, relatedProducts: related } });
});

// POST /api/products (Admin create product)
const createProduct = asyncHandler(async (req, res) => {
  const { name, category_id, description, short_description, price, sale_price, sku, gender, featured, new_arrival, status, variants } = req.body;

  const slug = slugify(name) + '-' + Date.now();

  const [result] = await pool.execute(
    `INSERT INTO products (name, slug, category_id, description, short_description, price, sale_price, sku, gender, featured, new_arrival, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, slug, category_id, description, short_description, price, sale_price || null, sku, gender || 'unisex', featured ? 1 : 0, new_arrival ? 1 : 0, status || 'active']
  );

  const productId = result.insertId;

  // Handle uploaded files via ImgBB
  if (req.files && req.files.length > 0) {
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const imageUrl = await uploadToImgBB(file.buffer);
      await pool.execute(
        `INSERT INTO product_images (product_id, image_url, is_primary, display_order) VALUES (?, ?, ?, ?)`,
        [productId, imageUrl, i === 0 ? 1 : 0, i]
      );
    }
  }

  // Handle variants
  if (variants) {
    const parsedVariants = typeof variants === 'string' ? JSON.parse(variants) : variants;
    for (const v of parsedVariants) {
      await pool.execute(
        `INSERT INTO product_variants (product_id, size, color, stock, sku) VALUES (?, ?, ?, ?, ?)`,
        [productId, v.size, v.color, v.stock || 0, v.sku || `${sku}-${v.size}-${v.color}`]
      );
    }
  }

  res.status(201).json({ success: true, message: 'Product created successfully', data: { id: productId, slug } });
});

// PUT /api/products/:id (Admin update product)
const updateProduct = asyncHandler(async (req, res) => {
  const productId = req.params.id;
  const { name, category_id, description, short_description, price, sale_price, sku, gender, featured, new_arrival, status } = req.body;

  await pool.execute(
    `UPDATE products SET name=?, category_id=?, description=?, short_description=?, price=?, sale_price=?, sku=?, gender=?, featured=?, new_arrival=?, status=? WHERE id=?`,
    [name, category_id, description, short_description, price, sale_price || null, sku, gender, featured ? 1 : 0, new_arrival ? 1 : 0, status, productId]
  );

  if (req.files && req.files.length > 0) {
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const imageUrl = await uploadToImgBB(file.buffer);
      await pool.execute(
        `INSERT INTO product_images (product_id, image_url, is_primary, display_order) VALUES (?, ?, ?, ?)`,
        [productId, imageUrl, 0, i]
      );
    }
  }

  res.json({ success: true, message: 'Product updated successfully' });
});

// DELETE /api/products/:id (Admin delete product)
const deleteProduct = asyncHandler(async (req, res) => {
  await pool.execute(`UPDATE products SET status = 'inactive' WHERE id = ?`, [req.params.id]);
  res.json({ success: true, message: 'Product deleted successfully' });
});

module.exports = {
  getProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct
};
