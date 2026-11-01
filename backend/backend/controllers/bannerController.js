// Promotional banners for the storefront homepage carousel.
// Public:  GET /api/banners                (active banners only)
// Admin:   GET/POST/PUT/DELETE /api/admin/banners
//
// Images go to ImgBB, exactly like product and category images.

const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { uploadToImgBB } = require('../utils/imgbbHelper');
const { detectImageType } = require('../utils/imageValidation');
const { flags } = require('../config/schema');
const cache = require('../utils/cache');

// A banner link may be an absolute http(s) URL or a site-relative path such as
// "shop.html?on_sale=1". Anything with another scheme (javascript:, data:, ...)
// is rejected so a banner can never become a script-injection vector.
// Returns: null (no link), a cleaned string, or false (invalid).
function cleanLink(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (v.length > 500) return false;
  if (/^https?:\/\/[^\s<>"']+$/i.test(v)) return v;
  if (/^[A-Za-z0-9_\-./?=&%#,+~]+$/.test(v) && !v.includes('..')) return v; // no ":" → no scheme
  return false;
}

async function listActiveBanners() {
  if (!flags.banners) return [];
  const [rows] = await pool.query(
    "SELECT id, title, subtitle, image, link_url, sort_order FROM banners WHERE status = 'active' ORDER BY sort_order ASC, id ASC LIMIT 10"
  );
  return rows;
}

// GET /api/banners  (public)
const getPublicBanners = asyncHandler(async (req, res) => {
  const banners = await cache.wrap('banners:active', 60 * 1000, listActiveBanners);
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, banners });
});

// GET /api/admin/banners
const getAllBanners = asyncHandler(async (req, res) => {
  if (!flags.banners) return res.json({ success: true, banners: [] });
  const [rows] = await pool.query('SELECT * FROM banners ORDER BY sort_order ASC, id ASC');
  res.json({ success: true, banners: rows });
});

function requireFeature(res) {
  if (flags.banners) return true;
  res.status(503).json({ success: false, message: 'Banners are unavailable: the database upgrade did not complete. Check the server log.' });
  return false;
}

// POST /api/admin/banners  (multipart: image, title, subtitle, link_url, sort_order, status)
const createBanner = asyncHandler(async (req, res) => {
  if (!requireFeature(res)) return;
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ success: false, message: 'Banner title is required.' });
  if (title.length > 200) return res.status(400).json({ success: false, message: 'Banner title is too long (max 200 characters).' });
  const subtitle = req.body.subtitle ? String(req.body.subtitle).trim().slice(0, 255) : null;
  const link = cleanLink(req.body.link_url);
  if (link === false) return res.status(400).json({ success: false, message: 'Link must be a full http(s) address or a page like shop.html?on_sale=1.' });
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  const sortOrder = parseInt(req.body.sort_order, 10) || 0;

  if (!req.file) return res.status(400).json({ success: false, message: 'Please choose a banner image.' });
  if (!detectImageType(req.file.buffer)) {
    return res.status(400).json({ success: false, message: 'That file is not a valid JPG, PNG, or WEBP image.' });
  }
  let image;
  try {
    image = await uploadToImgBB(req.file.buffer);
  } catch (e) {
    return res.status(502).json({ success: false, message: `Uploading the banner image failed: ${e.message}` });
  }

  const [result] = await pool.query(
    'INSERT INTO banners (title, subtitle, image, link_url, sort_order, status) VALUES (?, ?, ?, ?, ?, ?)',
    [title, subtitle, image, link, sortOrder, status]
  );
  res.status(201).json({ success: true, message: 'Banner created.', bannerId: result.insertId });
});

// PUT /api/admin/banners/:id  (all fields optional; image optional)
const updateBanner = asyncHandler(async (req, res) => {
  if (!requireFeature(res)) return;
  const [rows] = await pool.query('SELECT * FROM banners WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ success: false, message: 'Banner not found.' });
  const cur = rows[0];

  const title = req.body.title !== undefined ? String(req.body.title).trim() : cur.title;
  if (!title) return res.status(400).json({ success: false, message: 'Banner title is required.' });
  if (title.length > 200) return res.status(400).json({ success: false, message: 'Banner title is too long (max 200 characters).' });
  const subtitle = req.body.subtitle !== undefined ? (String(req.body.subtitle).trim().slice(0, 255) || null) : cur.subtitle;

  let link = cur.link_url;
  if (req.body.link_url !== undefined) {
    link = cleanLink(req.body.link_url);
    if (link === false) return res.status(400).json({ success: false, message: 'Link must be a full http(s) address or a page like shop.html?on_sale=1.' });
  }
  const status = req.body.status === 'inactive' ? 'inactive' : (req.body.status === 'active' ? 'active' : cur.status);
  const sortOrder = req.body.sort_order !== undefined ? (parseInt(req.body.sort_order, 10) || 0) : cur.sort_order;

  let image = cur.image;
  if (req.file) {
    if (!detectImageType(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'That file is not a valid JPG, PNG, or WEBP image.' });
    }
    try {
      image = await uploadToImgBB(req.file.buffer);
    } catch (e) {
      return res.status(502).json({ success: false, message: `Uploading the banner image failed: ${e.message}` });
    }
  }

  await pool.query(
    'UPDATE banners SET title = ?, subtitle = ?, image = ?, link_url = ?, sort_order = ?, status = ? WHERE id = ?',
    [title, subtitle, image, link, sortOrder, status, req.params.id]
  );
  res.json({ success: true, message: 'Banner updated.' });
});

// DELETE /api/admin/banners/:id
const deleteBanner = asyncHandler(async (req, res) => {
  if (!requireFeature(res)) return;
  const [result] = await pool.query('DELETE FROM banners WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Banner not found.' });
  res.json({ success: true, message: 'Banner deleted.' });
});

module.exports = { getPublicBanners, listActiveBanners, getAllBanners, createBanner, updateBanner, deleteBanner, cleanLink };
