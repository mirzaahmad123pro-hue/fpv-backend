const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { slugify } = require('../utils/helpers');
const { uploadToImgBB } = require('../utils/imgbbHelper');
const { detectImageType } = require('../utils/imageValidation');
const { flags } = require('../config/schema');

// Subcategories are one level deep: a top-level category can have children,
// a child cannot have children of its own. That is what the storefront menu
// (parent → flyout of children) and the filter sidebar are built for.

// Turns the form value into a number or null ('' / 'null' / undefined → null).
function parseParentId(raw) {
  if (raw === undefined) return undefined;            // field not sent → leave unchanged
  if (raw === null || raw === '' || raw === 'null' || raw === '0') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// Returns an error message when `parentId` is not a valid parent for the
// category `selfId` (null selfId = a brand new category), otherwise null.
async function validateParent(parentId, selfId) {
  if (parentId === null || parentId === undefined) return null;
  if (Number.isNaN(parentId)) return 'Invalid parent category.';
  if (selfId && parentId === Number(selfId)) return 'A category cannot be its own parent.';
  const [rows] = await pool.query('SELECT id, parent_id FROM categories WHERE id = ?', [parentId]);
  if (rows.length === 0) return 'The selected parent category does not exist.';
  if (rows[0].parent_id) return 'Subcategories can only be one level deep — pick a top-level category as the parent.';
  if (selfId) {
    const [kids] = await pool.query('SELECT id FROM categories WHERE parent_id = ? LIMIT 1', [selfId]);
    if (kids.length > 0) return 'This category already has subcategories, so it cannot become a subcategory itself.';
  }
  return null;
}

// GET /api/categories  (public — only active categories, unless ?all=1 and admin)
// Every row carries parent_id (null for top-level) and product_count (visible
// products directly in that category) so the storefront can build its menu.
const getCategories = asyncHandler(async (req, res) => {
  const includeAll = req.query.all === '1' && req.user && ['admin', 'super_admin'].includes(req.user.role);
  const rows = await listCategories(includeAll);
  res.json({ success: true, categories: rows });
});

async function listCategories(includeAll) {
  const [rows] = await pool.query(
    `SELECT c.*, COALESCE(pc.n, 0) AS product_count
       FROM categories c
       LEFT JOIN (SELECT category_id, COUNT(*) AS n FROM products WHERE status != 'inactive' GROUP BY category_id) pc
              ON pc.category_id = c.id
      ${includeAll ? '' : "WHERE c.status = 'active'"}
      ORDER BY c.name ASC`
  );
  return rows;
}

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

  let parentId = null;
  if (flags.categoryParent) {
    parentId = parseParentId(req.body.parent_id);
    if (parentId === undefined) parentId = null;
    const parentError = await validateParent(parentId, null);
    if (parentError) return res.status(400).json({ success: false, message: parentError });
  }

  let image = null;
  if (req.file) {
    if (!detectImageType(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'That file is not a valid JPG, PNG, or WEBP image.' });
    }
    try {
      image = await uploadToImgBB(req.file.buffer);
    } catch (uploadErr) {
      return res.status(502).json({ success: false, message: `Uploading category image to ImgBB failed: ${uploadErr.message}` });
    }
  }

  const [existing] = await pool.query('SELECT id FROM categories WHERE slug = ?', [slug]);
  if (existing.length > 0) {
    return res.status(409).json({ success: false, message: 'A category with a similar name already exists.' });
  }

  const [result] = flags.categoryParent
    ? await pool.query(
        'INSERT INTO categories (name, slug, description, image, status, parent_id) VALUES (?, ?, ?, ?, ?, ?)',
        [name, slug, description || null, image, status || 'active', parentId]
      )
    : await pool.query(
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
  if (slug !== rows[0].slug) {
    const [clash] = await pool.query('SELECT id FROM categories WHERE slug = ? AND id != ?', [slug, id]);
    if (clash.length > 0) {
      return res.status(409).json({ success: false, message: 'A category with a similar name already exists.' });
    }
  }

  let parentId = rows[0].parent_id === undefined ? null : rows[0].parent_id;
  if (flags.categoryParent) {
    const sent = parseParentId(req.body.parent_id);
    if (sent !== undefined) {
      const parentError = await validateParent(sent, id);
      if (parentError) return res.status(400).json({ success: false, message: parentError });
      parentId = sent;
    }
  }

  let image = rows[0].image;
  if (req.file) {
    if (!detectImageType(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'That file is not a valid JPG, PNG, or WEBP image.' });
    }
    try {
      image = await uploadToImgBB(req.file.buffer);
    } catch (uploadErr) {
      return res.status(502).json({ success: false, message: `Uploading category image to ImgBB failed: ${uploadErr.message}` });
    }
  }

  if (flags.categoryParent) {
    await pool.query(
      'UPDATE categories SET name = ?, slug = ?, description = ?, image = ?, status = ?, parent_id = ? WHERE id = ?',
      [name || rows[0].name, slug, description ?? rows[0].description, image, status || rows[0].status, parentId, id]
    );
  } else {
    await pool.query(
      'UPDATE categories SET name = ?, slug = ?, description = ?, image = ?, status = ? WHERE id = ?',
      [name || rows[0].name, slug, description ?? rows[0].description, image, status || rows[0].status, id]
    );
  }

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

  if (flags.categoryParent) {
    const [children] = await pool.query('SELECT id FROM categories WHERE parent_id = ? LIMIT 1', [id]);
    if (children.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'This category has subcategories. Move or delete those first, or deactivate this category instead.'
      });
    }
  }

  await pool.query('DELETE FROM categories WHERE id = ?', [id]);
  res.json({ success: true, message: 'Category deleted.' });
});

module.exports = { getCategories, getCategoryBySlug, createCategory, updateCategory, deleteCategory, listCategories };
