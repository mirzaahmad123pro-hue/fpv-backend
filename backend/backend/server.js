require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');

const { testConnection } = require('./config/database');
const { ensureSchema, ensureRedesignSchema } = require('./config/schema');
const cache = require('./utils/cache');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
// const { UPLOAD_ROOT } = require('./middleware/uploadMiddleware'); // ImgBB migration ke baad disabled

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const cartRoutes = require('./routes/cartRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const supportRoutes = require('./routes/supportRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const homeRoutes = require('./routes/homeRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const wishlistRoutes = require('./routes/wishlistRoutes');

const app = express();

// ── Render Proxy Fix ────────────────────────────────
app.set('trust proxy', 1);

// ── Security middleware ─────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── Response compression (JSON/HTML shrink to roughly a quarter of their size,
//    which matters a lot on slow mobile connections) ───────────────────────────
app.use(compression());

// ── Cross-Domain CORS Fix ────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'https://regal-druid-93caf2.netlify.app',
  credentials: true
}));

// Basic rate limiting to slow down brute-force / abuse. Tune as needed.
//
// Many customers on mobile networks share ONE public IP address, so a plain "per IP" cap could lock
// real shoppers out. Therefore:
//   • logged-in requests are counted per verified user (their token), not per IP;
//   • cheap, cached public reads (home, categories, banners, settings, plain product lists) are not
//     counted at all — searching and everything that writes or touches an account still is;
//   • only FAILED logins count towards the login limit (see authLimiter below).
const jwt = require('jsonwebtoken');
const PUBLIC_READS = /^\/(health|home|categories|banners|settings(\/social-media)?|announcements\/active)\/?$/;
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200,
  skip: (req) => {
    if (req.method !== 'GET') return false;
    if (PUBLIC_READS.test(req.path)) return true;                       // includes the keep-alive ping
    return req.path === '/products' && !req.query.search;               // category/product lists (cached server-side)
  },
  keyGenerator: (req) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      try { return 'user:' + jwt.verify(header.slice(7), process.env.JWT_SECRET).id; }
      catch (e) { /* invalid token → fall back to the IP address below, so fake tokens can't dodge the limit */ }
    }
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// Wrong passwords are what brute-force attacks produce, so only failed attempts are counted: a shop full of
// customers behind one shared IP can all log in, while someone guessing passwords is stopped after 20 tries.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please wait a few minutes and try again.' }
});
// Creating accounts is limited by how many are created from one address.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many accounts were created from this connection. Please try again later.' }
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/google', loginLimiter);
app.use('/api/auth/register', registerLimiter);

// ── Body parsing ─────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Static file serving (Disabled - Images now hosted on ImgBB) ─────────
// app.use('/uploads', express.static(UPLOAD_ROOT));

// ── Cache invalidation ───────────────────────────────
// Public reads (home, products, categories, banners, settings) are cached in
// memory for a few seconds. Any successful write — an admin edit, a new order,
// a cancellation that returns stock — clears the cache so changes show at once.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.on('finish', () => { if (res.statusCode < 400) cache.clear(); });
  }
  next();
});

// ── Health check ─────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Fast Global Eagle API is running.' });
});

// ── API routes ───────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/wishlist', wishlistRoutes);

// ── 404 + error handling (must be last) ─────────────
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`\n🚀 Fast Global Eagle API running on http://localhost:${PORT}`);
  await testConnection();
  await ensureSchema(); // additive, idempotent — see config/schema.js
  await ensureRedesignSchema(); // subcategories, wishlist, order history, banners
});