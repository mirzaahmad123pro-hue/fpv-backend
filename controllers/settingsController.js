const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const cache = require('../utils/cache');

// Only these keys are safe to expose publicly. Admin-only settings (if any
// get added later) stay out of this list — the full key/value set is still
// available to admins via GET /api/admin/settings.
const PUBLIC_SETTING_KEYS = [
  'store_name',
  'store_currency',
  'shipping_fee',
  'free_shipping_threshold',
  'payment_account_name',
  'jazzcash_number',
  'easypaisa_number',
  'bank_name',
  'bank_account_number',
  'whatsapp_number',
  'hero_banner_image',
  // Homepage flash-sale block (Admin → Settings). The countdown only shows
  // while flash_sale_ends_at is set and still in the future.
  'flash_sale_title',
  'flash_sale_ends_at'
];

async function loadPublicSettings() {
  const [rows] = await pool.query(
    `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${PUBLIC_SETTING_KEYS.map(() => '?').join(',')})`,
    PUBLIC_SETTING_KEYS
  );
  const settings = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));

  // Always return every key (even if not yet set in the DB) so the
  // frontend never has to guard against `undefined`.
  PUBLIC_SETTING_KEYS.forEach(key => {
    if (!(key in settings)) settings[key] = '';
  });
  return settings;
}

// GET /api/settings  (public — used by the storefront for checkout, cart
// shipping calculations, the WhatsApp widget, and the homepage hero banner)
const getPublicSettings = asyncHandler(async (req, res) => {
  const settings = await cache.wrap('settings:public', 60 * 1000, loadPublicSettings);
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, settings });
});

module.exports = { getPublicSettings, loadPublicSettings, PUBLIC_SETTING_KEYS };
