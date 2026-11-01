const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { slugify } = require('../utils/helpers');
const uploadToImgBB = require('../utils/imgbbHelper');
const { flags } = require('../config/schema');
const { firstInvalidImageMessage } = require('../utils/imageValidation');
const cache = require('../utils/cache');

const MAX_PRODUCT_IMAGES = 10;

// Average rating + review count, only selected once the reviews table exists
// so a failed schema upgrade can never break the product listing.
function ratingColumns() {
  return flags.reviews
    ? `, (SELECT ROUND(AVG(r.rating), 1) FROM product_reviews r WHERE r.product_id = p.id) AS avg_rating,
       (SELECT COUNT(*) FROM product_reviews r WHERE r.product_id = p.id) AS review_count`
    : '';
}


// ── Variants ─────────────────────────────────────────────────────────
// A product can have many styles (size / colour combinations) as ONE
// product — admins never need a separate product per colour.
function parseVariants(raw) {
  if (raw === undefined) return null;                // field not sent → leave variants alone
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!Array.isArray(list)) return null;
  return list.map(v => ({
    id: Number.isInteger(Number(v.id)) && Number(v.id) > 0 ? Number(v.id) : null,
    size: v.size ? String(v.size).trim().slice(0, 20) : null,
    color: v.color ? String(v.color).trim().slice(0, 40) : null,
    sku: v.sku ? String(v.sku).trim().slice(0, 80) : null,
    price_adjustment: Number.isFinite(Number(v.price_adjustment)) ? Number(v.price_adjustment) : 0,
    stock_quantity: Math.max(parseInt(v.stock_quantity, 10) || 0, 0),
    // Either an existing gallery image (image_id) or "the Nth image uploaded
    // in this same request" (image_new_index) — the latter lets an admin link
    // a variant to a photo they are uploading right now.
    image_id: Number.isInteger(Number(v.image_id)) && Number(v.image_id) > 0 ? Number(v.image_id) : null,
    image_new_index: v.image_new_index !== undefined && v.image_new_index !== null && v.image_new_index !== '' && Number.isInteger(Number(v.image_new_index))
      ? Number(v.image_new_index) : null
  })).filter(v => v.size || v.color);
}

// Writes the submitted variant list for a product. `newImageIds[i]` is the
// product_images.id created from the i-th uploaded file of this request.
// Returns a note (string) when something could not be removed.
async function syncVariants(productId, variants, newImageIds) {
  if (variants === null) return '';
  const [galleryRows] = await pool.query('SELECT id FROM product_images WHERE product_id = ?', [productId]);
  const galleryIds = new Set(galleryRows.map(r => r.id));
  const resolveImage = (v) => {
    if (v.image_new_index !== null && newImageIds[v.image_new_index]) return newImageIds[v.image_new_index];
    if (v.image_id && galleryIds.has(v.image_id)) return v.image_id;   // ignore ids from another product
    return null;
  };

  const [existing] = await pool.query('SELECT id FROM product_variants WHERE product_id = ?', [productId]);
  const existingIds = new Set(existing.map(r => r.id));
  const keepIds = new Set();

  for (const v of variants) {
    const imageId = resolveImage(v);
    if (v.id && existingIds.has(v.id)) {
      keepIds.add(v.id);
      if (flags.variantImages) {
        await pool.query(
          'UPDATE product_variants SET size = ?, color = ?, sku = ?, price_adjustment = ?, stock_quantity = ?, image_id = ? WHERE id = ? AND product_id = ?',
          [v.size, v.color, v.sku, v.price_adjustment, v.stock_quantity, imageId, v.id, productId]
        );
      } else {
        await pool.query(
          'UPDATE product_variants SET size = ?, color = ?, sku = ?, price_adjustment = ?, stock_quantity = ? WHERE id = ? AND product_id = ?',
          [v.size, v.color, v.sku, v.price_adjustment, v.stock_quantity, v.id, productId]
        );
      }
    } else if (flags.variantImages) {
      await pool.query(
        'INSERT INTO product_variants (product_id, size, color, sku, price_adjustment, stock_quantity, image_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [productId, v.size, v.color, v.sku, v.price_adjustment, v.stock_quantity, imageId]
      );
    } else {
      await pool.query(
        'INSERT INTO product_variants (product_id, size, color, sku, price_adjustment, stock_quantity) VALUES (?, ?, ?, ?, ?, ?)',
        [productId, v.size, v.color, v.sku, v.price_adjustment, v.stock_quantity]
      );
    }
  }

  // Variants the admin removed. One that appears on a past order is kept (with
  // stock 0) rather than deleted, so order history never loses which style was bought.
  let kept = 0;
  for (const id of existingIds) {
    if (keepIds.has(id)) continue;
    const [used] = await pool.query('SELECT 1 FROM order_items WHERE variant_id = ? LIMIT 1', [id]);
    if (used.length) {
      await pool.query('UPDATE product_variants SET stock_quantity = 0 WHERE id = ?', [id]);
      kept++;
    } else {
      await pool.query('DELETE FROM product_variants WHERE id = ?', [id]);
    }
  }
  return kept ? ` ${kept} removed variant${kept === 1 ? ' is' : 's are'} on past orders, so ${kept === 1 ? 'it was' : 'they were'} kept with stock set to 0.` : '';
}

// Inserts uploaded files as product_images (appended after existing ones) and
// returns their new ids in upload order.
async function insertNewImages(productId, urls, startOrder) {
  const ids = [];
  for (let i = 0; i < urls.length; i++) {
    const [r] = await pool.query(
      'INSERT INTO product_images (product_id, image_path, sort_order) VALUES (?, ?, ?)',
      [productId, urls[i], startOrder + i]
    );
    ids.push(r.insertId);
  }
  return ids;
}

// Checkbox values arrive from the admin form as the strings '1' / '0'. In JavaScript the
// string '0' is truthy, so the old `featured ? 1 : 0` marked EVERY saved product as
// featured and as a new arrival. This reads the value properly.
function toFlag(v) {
  if (v === true || v === 1) return 1;
  if (typeof v === 'string') return ['1', 'true', 'on', 'yes'].includes(v.trim().toLowerCase()) ? 1 : 0;
  return 0;
}

// Shared price sanity check. A sale price must be a positive number below the
// regular price — otherwise the storefront would show a "discount" that raises
// the price (the cart charges the sale price whenever one is set).
function validatePrices(regular, sale) {
  const reg = Number(regular);
  if (!Number.isFinite(reg) || reg <= 0) return 'Regular price must be a number greater than 0.';
  if (sale === null || sale === undefined || String(sale).trim() === '') return null;
  const sp = Number(sale);
  if (!Number.isFinite(sp) || sp <= 0 || sp >= reg) {
    return 'Sale price must be greater than 0 and lower than the regular price (leave it empty for no sale).';
  }
  return null;
}

// GET /api/products
// Supports: ?category=slug  ?search=term  ?sort=price_asc|price_low... ?featured=1
// ?new_arrival=1  ?gender=men  ?page=1  ?limit=12
// Escapes LIKE wildcards so a customer typing "50%" or "a_b" searches for
// those literal characters instead of matching everything.
function escapeLike(term) {
  return term.replace(/[\\%_]/g, '\\$&');
}

function isAdminUser(req) {
  return !!(req.user && ['admin', 'super_admin'].includes(req.user.role));
}

const LIST_STATUSES = ['active', 'inactive', 'out_of_stock'];

// The price a customer is actually charged: the sale price when one is set,
// otherwise the regular price (this matches what the cart and checkout use).
const EFFECTIVE_PRICE = 'COALESCE(NULLIF(p.sale_price, 0), p.regular_price)';
const ON_SALE_SQL = '(p.sale_price IS NOT NULL AND p.sale_price > 0 AND p.sale_price < p.regular_price)';

// Builds the full list response. Pure function of the query string so the
// result can be cached per URL for anonymous storefront traffic.
async function queryProducts(q, adminView) {
  const {
    category, search, sort, featured, new_arrival, gender, status,
    brand, min_price, max_price, in_stock, on_sale, min_rating, exclude, facets,
    page = 1, limit = 12
  } = q;

  // Scope = which products the visitor is browsing (visibility, category,
  // search, ...). Filters = the narrowing options in the sidebar. Facets
  // (brand list, price range) are computed over the scope only, so choosing
  // one brand doesn't make every other brand vanish from the sidebar.
  const scope = [];
  const scopeParams = [];
  if (adminView) {
    if (LIST_STATUSES.includes(status)) { scope.push('p.status = ?'); scopeParams.push(status); }
  } else {
    scope.push("p.status != 'inactive'");
  }

  if (category) {
    // The category relationship stored in the database (products.category_id →
    // categories.id) is the ONLY thing that decides which category a product
    // is in — never its title, keywords, or gender field. Browsing a parent
    // category also shows the products of its subcategories.
    if (flags.categoryParent) {
      scope.push('(c.slug = ? OR parent_cat.slug = ?)');
      scopeParams.push(category, category);
    } else {
      scope.push('c.slug = ?');
      scopeParams.push(category);
    }
  }
  if (search) {
    // Every word must match at least one of: name, SKU, brand, short
    // description or category name — so "Premium Leather Watch" finds that
    // product, "watch" finds every watch, and word order doesn't matter.
    // Case-insensitive under this schema's default *_ci collation. Values are
    // always bound parameters (never concatenated into the SQL).
    const tokens = String(search).trim().split(/\s+/).filter(Boolean).slice(0, 6);
    tokens.forEach(t => {
      scope.push('(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.short_description LIKE ? OR c.name LIKE ?)');
      const like = `%${escapeLike(t.slice(0, 60))}%`;
      scopeParams.push(like, like, like, like, like);
    });
  }
  if (featured === '1') scope.push('p.featured = 1');
  if (new_arrival === '1') scope.push('p.new_arrival = 1');
  if (gender) { scope.push('p.gender_or_target = ?'); scopeParams.push(gender); }
  if (exclude && Number.isInteger(Number(exclude))) { scope.push('p.id != ?'); scopeParams.push(Number(exclude)); }

  const filters = [];
  const filterParams = [];
  const minP = parseFloat(min_price);
  const maxP = parseFloat(max_price);
  if (Number.isFinite(minP) && minP > 0) { filters.push(`${EFFECTIVE_PRICE} >= ?`); filterParams.push(minP); }
  if (Number.isFinite(maxP) && maxP > 0) { filters.push(`${EFFECTIVE_PRICE} <= ?`); filterParams.push(maxP); }
  if (brand) {
    const brands = String(brand).split(',').map(b => b.trim()).filter(Boolean).slice(0, 10);
    if (brands.length) {
      filters.push(`p.brand IN (${brands.map(() => '?').join(',')})`);
      filterParams.push(...brands);
    }
  }
  if (in_stock === '1') filters.push("(p.status = 'active' AND p.stock_quantity > 0)");
  if (on_sale === '1') filters.push(ON_SALE_SQL);
  const minR = parseFloat(min_rating);
  if (flags.reviews && Number.isFinite(minR) && minR > 0) {
    filters.push('(SELECT AVG(r.rating) FROM product_reviews r WHERE r.product_id = p.id) >= ?');
    filterParams.push(minR);
  }

  let orderBy = 'p.created_at DESC';
  if (sort === 'price_asc') orderBy = `${EFFECTIVE_PRICE} ASC`;
  if (sort === 'price_desc') orderBy = `${EFFECTIVE_PRICE} DESC`;
  if (sort === 'name_asc') orderBy = 'p.name ASC';
  if (sort === 'newest') orderBy = 'p.created_at DESC';
  if (sort === 'popular') {
    orderBy = `(SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled'
                WHERE oi.product_id = p.id) DESC, p.created_at DESC`;
  }
  if (sort === 'rating' && flags.reviews) orderBy = 'COALESCE(avg_rating, 0) DESC, review_count DESC, p.created_at DESC';
  if (sort === 'discount') {
    orderBy = `CASE WHEN ${ON_SALE_SQL} THEN (p.regular_price - p.sale_price) / p.regular_price ELSE 0 END DESC, p.created_at DESC`;
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  const joins = `FROM products p
     JOIN categories c ON c.id = p.category_id
     ${flags.categoryParent ? 'LEFT JOIN categories parent_cat ON parent_cat.id = c.parent_id' : ''}`;
  const allWhere = [...scope, ...filters];
  const whereSql = allWhere.length ? `WHERE ${allWhere.join(' AND ')}` : '';
  const params = [...scopeParams, ...filterParams];

  const listPromise = pool.query(
    `SELECT p.id, p.category_id, p.name, p.slug, p.sku, p.brand, p.short_description,
            p.regular_price, p.sale_price, p.stock_quantity, p.status, p.featured,
            p.new_arrival, p.gender_or_target, p.created_at,
            c.name AS category_name, c.slug AS category_slug,
            (SELECT image_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC, pi.id ASC LIMIT 1) AS thumbnail${ratingColumns()}
     ${joins}
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );
  const countPromise = pool.query(`SELECT COUNT(*) AS total ${joins} ${whereSql}`, params);

  // Independent queries run side by side instead of one after the other.
  const [[rows], [countRows]] = await Promise.all([listPromise, countPromise]);
  const total = countRows[0].total;

  const result = {
    success: true,
    products: rows,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum)
    }
  };

  if (facets === '1') {
    const scopeSql = scope.length ? `WHERE ${scope.join(' AND ')}` : '';
    const [[brandRows], [rangeRows]] = await Promise.all([
      pool.query(
        `SELECT p.brand AS name, COUNT(*) AS count ${joins} ${scopeSql}${scope.length ? ' AND' : ' WHERE'} p.brand IS NOT NULL AND p.brand != ''
         GROUP BY p.brand ORDER BY count DESC, p.brand ASC LIMIT 30`,
        scopeParams
      ),
      pool.query(
        `SELECT MIN(${EFFECTIVE_PRICE}) AS min_price, MAX(${EFFECTIVE_PRICE}) AS max_price ${joins} ${scopeSql}`,
        scopeParams
      )
    ]);
    result.facets = {
      brands: brandRows,
      price_min: rangeRows[0].min_price === null ? null : Number(rangeRows[0].min_price),
      price_max: rangeRows[0].max_price === null ? null : Number(rangeRows[0].max_price)
    };
  }

  return result;
}

const getProducts = asyncHandler(async (req, res) => {
  // Admin Products page (?admin=1, logged-in admin only) also sees inactive
  // products and can filter by status. The public storefront never does.
  const adminView = req.query.admin === '1' && isAdminUser(req);

  if (adminView) {
    res.set('Cache-Control', 'no-store');
    return res.json(await queryProducts(req.query, true));
  }

  // Public listing: identical for every visitor, so it is cached briefly in
  // memory (cleared on every successful write — see server.js) and the
  // browser may reuse it for a few seconds.
  const key = `products:${req.originalUrl}`;
  const payload = await cache.wrap(key, 30 * 1000, () => queryProducts(req.query, false));
  res.set('Cache-Control', 'public, max-age=10');
  res.json(payload);
});

// GET /api/products/suggest?q=...  — lightweight type-ahead for the search box.
const suggestProducts = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) {
    return res.json({ success: true, products: [], categories: [] });
  }
  const like = `%${escapeLike(q)}%`;
  const startsLike = `${escapeLike(q)}%`;

  const payload = await cache.wrap(`suggest:${q.toLowerCase()}`, 60 * 1000, async () => {
    const [products] = await pool.query(
      `SELECT p.id, p.name, p.slug, p.regular_price, p.sale_price,
              (SELECT image_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC, pi.id ASC LIMIT 1) AS thumbnail
         FROM products p
         JOIN categories c ON c.id = p.category_id
        WHERE p.status != 'inactive' AND c.status = 'active'
          AND (p.name LIKE ? OR p.brand LIKE ? OR p.sku LIKE ?)
        ORDER BY (p.name LIKE ?) DESC, p.name ASC
        LIMIT 6`,
      [like, like, like, startsLike]
    );
    const [categories] = await pool.query(
      "SELECT name, slug FROM categories WHERE status = 'active' AND name LIKE ? ORDER BY name ASC LIMIT 3",
      [like]
    );
    return { products, categories };
  });

  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, ...payload });
});

// GET /api/products/:slug   (a numeric value is also accepted as a product id,
// so older links like product.html?id=12 keep working without the browser
// having to download the whole catalogue to find the product)
const getProductBySlug = asyncHandler(async (req, res) => {
  const key = String(req.params.slug);
  const hideInactive = isAdminUser(req) ? '' : " AND p.status != 'inactive'";
  const baseSql = `SELECT p.*, c.name AS category_name, c.slug AS category_slug${ratingColumns()}
     FROM products p JOIN categories c ON c.id = p.category_id`;

  let [rows] = await pool.query(`${baseSql} WHERE p.slug = ?${hideInactive}`, [key]);
  if (rows.length === 0 && /^\d+$/.test(key)) {
    [rows] = await pool.query(`${baseSql} WHERE p.id = ?${hideInactive}`, [Number(key)]);
  }
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const product = rows[0];

  const [images] = await pool.query(
    'SELECT id, image_path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
    [product.id]
  );
  const [variants] = await pool.query(
    'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id ASC',
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
    'SELECT id, image_path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
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
  const priceError = validatePrices(regular_price, sale_price);
  if (priceError) {
    return res.status(400).json({ success: false, message: priceError });
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
      status || 'active', toFlag(featured), toFlag(new_arrival),
      gender_or_target || 'n/a'
    ]
  );

  const productId = result.insertId;

  if (req.files && req.files.length > MAX_PRODUCT_IMAGES) {
    await pool.query('DELETE FROM products WHERE id = ?', [productId]);
    return res.status(400).json({ success: false, message: `Maximum ${MAX_PRODUCT_IMAGES} images are allowed per product.` });
  }

  if (req.files && req.files.length > 0) {
    const invalidMsg = firstInvalidImageMessage(req.files);
    if (invalidMsg) {
      await pool.query('DELETE FROM products WHERE id = ?', [productId]);
      return res.status(400).json({ success: false, message: invalidMsg });
    }
  }

  let newImageIds = [];
  if (req.files && req.files.length > 0) {
    try {
      const uploadedUrls = await Promise.all(
        req.files.map(file => uploadToImgBB(file))
      );
      newImageIds = await insertNewImages(productId, uploadedUrls, 0);
    } catch (uploadErr) {
      return res.status(502).json({
        success: false,
        message: `Product created, but uploading images failed: ${uploadErr.message}`,
        productId
      });
    }
  }

  let variantNote = '';
  try {
    variantNote = await syncVariants(productId, parseVariants(variants), newImageIds);
  } catch (e) {
    console.error('Variant save failed:', e.message);
    return res.status(500).json({ success: false, message: 'Product created, but its variants could not be saved. Edit the product to add them again.', productId });
  }

  res.status(201).json({ success: true, message: 'Product created.' + variantNote, productId });
});

// PUT /api/products/:id  (admin)
const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [existingRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
  if (existingRows.length === 0) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  const existing = existingRows[0];

  if (req.files && req.files.length > 0) {
    const [[{ c: currentImages }]] = await pool.query('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?', [id]);
    if (currentImages + req.files.length > MAX_PRODUCT_IMAGES) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${MAX_PRODUCT_IMAGES} images are allowed per product. This product already has ${currentImages}, so you can add up to ${Math.max(0, MAX_PRODUCT_IMAGES - currentImages)} more.`
      });
    }
  }

  const {
    category_id, name, sku, brand, short_description, full_description,
    regular_price, sale_price, stock_quantity, status, featured, new_arrival,
    gender_or_target
  } = req.body;

  const slug = name ? slugify(name) : existing.slug;

  const priceError = validatePrices(
    regular_price || existing.regular_price,
    sale_price === '' ? null : (sale_price ?? existing.sale_price)
  );
  if (priceError) {
    return res.status(400).json({ success: false, message: priceError });
  }

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
      featured !== undefined ? toFlag(featured) : existing.featured,
      new_arrival !== undefined ? toFlag(new_arrival) : existing.new_arrival,
      gender_or_target || existing.gender_or_target,
      id
    ]
  );

  let newImageIds = [];
  if (req.files && req.files.length > 0) {
    const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?', [id]);
    const currentCount = countRows[0].c;

    if (currentCount + req.files.length > MAX_PRODUCT_IMAGES) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${MAX_PRODUCT_IMAGES} images are allowed per product. This product already has ${currentCount}, so you can add up to ${Math.max(0, MAX_PRODUCT_IMAGES - currentCount)} more.`
      });
    }

    const invalidMsg = firstInvalidImageMessage(req.files);
    if (invalidMsg) {
      return res.status(400).json({ success: false, message: invalidMsg });
    }

    try {
      const uploadedUrls = await Promise.all(
        req.files.map(file => uploadToImgBB(file))
      );
      const [[{ maxOrder }]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM product_images WHERE product_id = ?', [id]);
      newImageIds = await insertNewImages(id, uploadedUrls, maxOrder + 1);
    } catch (uploadErr) {
      return res.status(502).json({
        success: false,
        message: `Product updated, but uploading new images failed: ${uploadErr.message}`
      });
    }
  }

  let variantNote = '';
  try {
    variantNote = await syncVariants(id, parseVariants(req.body.variants), newImageIds);
  } catch (e) {
    console.error('Variant save failed:', e.message);
    return res.status(500).json({ success: false, message: 'Product details were saved, but its variants could not be updated. Please try again.' });
  }

  res.json({ success: true, message: 'Product updated.' + variantNote });
});

// DELETE /api/products/:id  (admin) — blocks deletion if referenced by an order
const deleteProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [orderItems] = await pool.query('SELECT id FROM order_items WHERE product_id = ? LIMIT 1', [id]);
  if (orderItems.length > 0) {
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
  const [rows] = await pool.query('SELECT id, product_id FROM product_images WHERE id = ?', [req.params.imageId]);
  if (rows.length === 0) return res.status(404).json({ success: false, message: 'Image not found.' });

  const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?', [rows[0].product_id]);
  if (c <= 1) {
    return res.status(400).json({ success: false, message: 'A product needs at least 1 image. Upload another image before removing this one.' });
  }

  await pool.query('DELETE FROM product_images WHERE id = ?', [rows[0].id]);
  if (flags.variantImages) {
    await pool.query('UPDATE product_variants SET image_id = NULL WHERE image_id = ?', [rows[0].id]);
  }
  const [left] = await pool.query('SELECT id FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC', [rows[0].product_id]);
  for (let i = 0; i < left.length; i++) {
    await pool.query('UPDATE product_images SET sort_order = ? WHERE id = ?', [i, left[i].id]);
  }
  res.json({ success: true, message: 'Image removed.' });
});

// PUT /api/products/:id/images/reorder  (admin)  body: { image_ids: [3, 7, 1, ...] }
const reorderProductImages = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const imageIds = Array.isArray(req.body.image_ids) ? req.body.image_ids.map(Number) : [];

  const [existing] = await pool.query('SELECT id FROM product_images WHERE product_id = ?', [id]);
  const existingIds = existing.map(r => r.id);

  const sameSet = existingIds.length === imageIds.length &&
    existingIds.every(eid => imageIds.includes(eid));
  if (!sameSet) {
    return res.status(400).json({
      success: false,
      message: 'The image order must include every current image for this product exactly once.'
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < imageIds.length; i++) {
      await conn.query('UPDATE product_images SET sort_order = ? WHERE id = ? AND product_id = ?', [i, imageIds[i], id]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  res.json({ success: true, message: 'Image order updated.' });
});

module.exports = {
  getProducts, suggestProducts, queryProducts, getProductBySlug, getProductById,
  createProduct, updateProduct, deleteProduct, deleteProductImage,
  reorderProductImages
};
