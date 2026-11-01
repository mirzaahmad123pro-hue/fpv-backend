// GET /api/home — everything the homepage needs in ONE request.
//
// Before, the homepage made five or six separate calls one after another.
// On a free-tier host that wakes up slowly, each extra round trip added
// seconds. This endpoint runs the same queries in parallel on the server and
// is cached briefly in memory (cleared on every successful write).

const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { flags } = require('../config/schema');
const cache = require('../utils/cache');
const { loadPublicSettings } = require('./settingsController');
const { listCategories } = require('./categoryController');
const { listActiveBanners } = require('./bannerController');
const { queryProducts } = require('./productController');

async function loadAnnouncement() {
  if (!flags.messaging) return null;
  const [rows] = await pool.query(
    'SELECT id, title, message, updated_at FROM announcements WHERE is_active = 1 ORDER BY id DESC LIMIT 1'
  );
  return rows[0] || null;
}

async function buildHome() {
  const [settings, categories, banners, announcement, flash, featured, arrivals, justForYou] = await Promise.all([
    loadPublicSettings(),
    listCategories(false),
    listActiveBanners(),
    loadAnnouncement(),
    queryProducts({ on_sale: '1', sort: 'discount', limit: 12 }, false),
    queryProducts({ featured: '1', limit: 12 }, false),
    queryProducts({ new_arrival: '1', limit: 12 }, false),
    queryProducts({ sort: 'newest', limit: 24, page: 1 }, false)
  ]);

  return {
    success: true,
    settings,
    categories,
    banners,
    announcement,
    sections: {
      flash_sale: flash.products,
      featured: featured.products,
      new_arrivals: arrivals.products,
      just_for_you: { products: justForYou.products, pagination: justForYou.pagination }
    }
  };
}

const getHome = asyncHandler(async (req, res) => {
  const payload = await cache.wrap('home', 30 * 1000, buildHome);
  res.set('Cache-Control', 'public, max-age=10');
  res.json(payload);
});

module.exports = { getHome };
