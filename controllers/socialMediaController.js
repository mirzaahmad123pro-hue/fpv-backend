// Admin-managed social media accounts, shown as the "Follow Us" icons in the
// storefront footer. Stored in social_media_accounts (see config/schema.js).
//
// Nothing about a platform's URL is hardcoded anywhere in the frontend — the
// footer renders exactly what is active in this table, in sort_order.

const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { flags } = require('../config/schema');

// Icon identifiers the storefront knows how to draw (see SOCIAL_ICONS in
// assets/js/app.js). Anything outside this list is rejected, so a typo can
// never produce an icon-less, unclickable footer entry.
const PLATFORMS = [
  'facebook', 'instagram', 'tiktok', 'youtube', 'whatsapp',
  'x', 'linkedin', 'pinterest', 'snapchat', 'telegram'
];

function unavailable(res) {
  return res.status(503).json({ success: false, message: 'Social media settings are temporarily unavailable.' });
}

// Only absolute http(s) URLs are accepted. This is what stops
// "javascript:alert(1)" / "data:" style values from ever reaching an href.
function cleanUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { error: 'Please enter the profile URL.' };
  if (value.length > 500) return { error: 'The URL must be 500 characters or fewer.' };
  let parsed;
  try { parsed = new URL(value); } catch (e) {
    return { error: 'That does not look like a valid URL. Include https:// at the start.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only http:// or https:// links are allowed.' };
  }
  return { url: parsed.toString() };
}

function cleanPlatform(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!PLATFORMS.includes(value)) {
    return { error: `Platform must be one of: ${PLATFORMS.join(', ')}.` };
  }
  return { platform: value };
}

function cleanStatus(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === true || raw === 1 || raw === '1' || raw === 'active') return 'active';
  if (raw === false || raw === 0 || raw === '0' || raw === 'inactive') return 'inactive';
  return null;
}

// ───────────────────────── PUBLIC ─────────────────────────

// GET /api/settings/social-media  — active accounts only, in display order.
const getActiveSocialAccounts = asyncHandler(async (req, res) => {
  if (!flags.socialMedia) return res.json({ success: true, accounts: [] });
  const [accounts] = await pool.query(
    "SELECT id, platform, profile_url FROM social_media_accounts WHERE status = 'active' ORDER BY sort_order ASC, id ASC"
  );
  // Short cache: the footer is on every page, and this changes rarely.
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, accounts });
});

// ───────────────────────── ADMIN ─────────────────────────

// GET /api/admin/social-media
const getAllSocialAccounts = asyncHandler(async (req, res) => {
  if (!flags.socialMedia) return unavailable(res);
  const [accounts] = await pool.query(
    'SELECT id, platform, profile_url, status, sort_order, created_at FROM social_media_accounts ORDER BY sort_order ASC, id ASC'
  );
  res.json({ success: true, accounts, platforms: PLATFORMS });
});

// POST /api/admin/social-media  { platform, profile_url, status? }
const createSocialAccount = asyncHandler(async (req, res) => {
  if (!flags.socialMedia) return unavailable(res);
  const p = cleanPlatform(req.body.platform);
  if (p.error) return res.status(400).json({ success: false, message: p.error });
  const u = cleanUrl(req.body.profile_url);
  if (u.error) return res.status(400).json({ success: false, message: u.error });
  const status = cleanStatus(req.body.status, 'active');
  if (!status) return res.status(400).json({ success: false, message: 'Status must be active or inactive.' });

  // New accounts go to the end of the list.
  const [[{ nextOrder }]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM social_media_accounts');
  const [result] = await pool.query(
    'INSERT INTO social_media_accounts (platform, profile_url, status, sort_order) VALUES (?, ?, ?, ?)',
    [p.platform, u.url, status, nextOrder]
  );
  res.status(201).json({ success: true, message: 'Social media account added.', id: result.insertId });
});

// PUT /api/admin/social-media/reorder  { ids: [3, 1, 2] }  — registered BEFORE /:id in the router
const reorderSocialAccounts = asyncHandler(async (req, res) => {
  if (!flags.socialMedia) return unavailable(res);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const [existing] = await pool.query('SELECT id FROM social_media_accounts');
  const existingIds = existing.map(r => r.id);
  const sameSet = ids.length === existingIds.length && existingIds.every(id => ids.includes(id));
  if (!sameSet) {
    return res.status(400).json({ success: false, message: 'The new order must include every account exactly once.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < ids.length; i++) {
      await conn.query('UPDATE social_media_accounts SET sort_order = ? WHERE id = ?', [i, ids[i]]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  res.json({ success: true, message: 'Display order updated.' });
});

// PUT /api/admin/social-media/:id  { platform?, profile_url?, status? }
const updateSocialAccount = asyncHandler(async (req, res) => {
  if (!flags.socialMedia) return unavailable(res);
  const [rows] = await pool.query('SELECT * FROM social_media_accounts WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ success: false, message: 'Account not found.' });
  const current = rows[0];

  let platform = current.platform;
  if (req.body.platform !== undefined) {
    const p = cleanPlatform(req.body.platform);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    platform = p.platform;
  }
  let profileUrl = current.profile_url;
  if (req.body.profile_url !== undefined) {
    const u = cleanUrl(req.body.profile_url);
    if (u.error) return res.status(400).json({ success: false, message: u.error });
    profileUrl = u.url;
  }
  const status = cleanStatus(req.body.status, current.status);
  if (!status) return res.status(400).json({ success: false, message: 'Status must be active or inactive.' });

  await pool.query(
    'UPDATE social_media_accounts SET platform = ?, profile_url = ?, status = ? WHERE id = ?',
    [platform, profileUrl, status, current.id]
  );
  res.json({ success: true, message: 'Social media account updated.' });
});

// DELETE /api/admin/social-media/:id
const deleteSocialAccount = asyncHandler(async (req, res) => {
  if (!flags.socialMedia) return unavailable(res);
  const [result] = await pool.query('DELETE FROM social_media_accounts WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Account not found.' });
  res.json({ success: true, message: 'Social media account deleted.' });
});

module.exports = {
  PLATFORMS,
  getActiveSocialAccounts,
  getAllSocialAccounts, createSocialAccount, reorderSocialAccounts, updateSocialAccount, deleteSocialAccount
};
