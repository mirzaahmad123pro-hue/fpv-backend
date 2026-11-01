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

// ── Cross-Domain CORS Fix (Allow Any Domain / Netlify / Vercel) ──
app.use(cors({
  origin: true,
  credentials: true
}));

// ── Security middleware ─────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── Response compression ────────────────────────────
app.use(compression());

// Basic rate limiting to slow down brute-force / abuse.
const jwt = require('jsonwebtoken');
const PUBLIC_READS = /^\/(health|home|categories|banners|settings(\/social-media)?|announcements\/active)\/?$/;
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200,
  skip: (req) => {
    if (req.method !== 'GET') return false;
    if (PUBLIC_READS.test(req.path)) return true;
    return req.path === '/products' && !req.query.search;
  },
  keyGenerator: (req) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      try { return 'user:' + jwt.verify(header.slice(7), process.env.JWT_SECRET).id; }
      catch (e) { }
    }
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please wait a few minutes and try again.' }
});

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

// ── Cache invalidation ───────────────────────────────
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
  await ensureSchema();
  await ensureRedesignSchema();
});
