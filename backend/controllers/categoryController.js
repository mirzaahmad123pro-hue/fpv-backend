const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { slugify } = require('../utils/helpers');

// GET /api/categories  (public — only active categories, unless ?all=1 and admin)
const getCategories = asyncHandler(async (req, res) => {
  const includeAll = req.query.all === '1' && req.user && ['admin', 'super_admin'].includes(req.user.role);
  const sql = includeAll
    ? 'SELECT * FROM categories ORDER BY name ASC'
    : "SELECT * FROM categories WHERE status = 'active' ORDER BY name ASC";
  const [rows] = await pool.query(sql);
  res.json({ success: true, categories: rows });
});

// GET /api/categories/:slug
const getCategoryBySlug = asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM categories WHERE slug = ?', [req.params.slug]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Category not found.' });
  }
  res.json({ success: true, category: rows[0] });
});

// POST /api/categories  (admin)
const createCategory = asyncHandler(async (req, res) => {
  const { name, description, status } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: 'Category name is required.' });
  }
  const slug = slugify(name);
  const image = req.file ? `/uploads/categories/${req.file.filename}` : null;

  const [existing] = await pool.query('SELECT id FROM categories WHERE slug = ?', [slug]);
  if (existing.length > 0) {
    return res.status(409).json({ success: false, message: 'A category with a similar name already exists.' });
  }

  const [result] = await pool.query(
    'INSERT INTO categories (name, slug, description, image, status) VALUES (?, ?, ?, ?, ?)',
    [name, slug, description || null, image, status || 'active']
  );

  res.status(201).json({ success: true, message: 'Category created.', categoryId: result.insertId });
});

// PUT /api/categories/:id  (admin)
const updateCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, status } = req.body;

  const [rows] = await pool.query('SELECT * FROM categories WHERE id = ?', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Category not found.' });
  }

  const slug = name ? slugify(name) : rows[0].slug;
  const image = req.file ? `/uploads/categories/${req.file.filename}` : rows[0].image;

  await pool.query(
    'UPDATE categories SET name = ?, slug = ?, description = ?, image = ?, status = ? WHERE id = ?',
    [name || rows[0].name, slug, description ?? rows[0].description, image, status || rows[0].status, id]
  );

  res.json({ success: true, message: 'Category updated.' });
});

// DELETE /api/categories/:id  (admin)
const deleteCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [products] = await pool.query('SELECT id FROM products WHERE category_id = ? LIMIT 1', [id]);
  if (products.length > 0) {
    return res.status(409).json({
      success: false,
      message: 'This category has products assigned to it. Reassign or delete those products first, or deactivate this category instead.'
    });
  }

  await pool.query('DELETE FROM categories WHERE id = ?', [id]);
  res.json({ success: true, message: 'Category deleted.' });
});

module.exports = { getCategories, getCategoryBySlug, createCategory, updateCategory, deleteCategory };
