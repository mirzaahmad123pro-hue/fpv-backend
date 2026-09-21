require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const cloudinary = require('cloudinary').v2;

const { testConnection } = require('./config/database');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const cartRoutes = require('./routes/cartRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const app = express();

// ── In-Memory Support Store (No circular loops) ───────
const supportStore = [];

function createTicket(raw = {}) {
  const now = new Date().toISOString();
  const id = raw.id || 'MSG-' + Date.now();
  const content = raw.message || raw.text || 'Help Request';
  const name = raw.name || raw.user_name || 'Customer';
  const email = raw.email || raw.user_email || 'customer@falconpeakventure.com';
  const subject = raw.subject || 'Help & Support Request';

  return {
    id,
    _id: id,
    conversation_id: id,
    subject,
    title: subject,
    message: content,
    text: content,
    user_name: name,
    user_email: email,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: 'M-' + Date.now(),
        sender: 'user',
        text: content,
        message: content,
        timestamp: now
      }
    ]
  };
}

// ── Cloudinary Configuration ─────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── Render Proxy Fix ────────────────────────────────
app.set('trust proxy', 1);

// ── Security middleware ─────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── Cross-Domain CORS Fix ────────────────────────────
app.use(cors({
  origin: true,
  credentials: true
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login/register attempts. Please wait and try again.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ── Body parsing ────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Falcon Peak Venture API is running.' });
});

app.get('/api/announcements/active', (req, res) => {
  res.json({ success: true, announcements: [], data: [] });
});

// ── Support Routes Handlers ──────────────────────────
const listHandler = (req, res) => {
  res.json({
    success: true,
    data: supportStore,
    conversations: supportStore,
    messages: supportStore,
    tickets: supportStore
  });
};

const singleHandler = (req, res) => {
  const { id } = req.params;
  const ticket = supportStore.find(t => t.id === id || t._id === id) || supportStore[0];

  if (ticket) {
    res.json({
      success: true,
      data: ticket,
      conversation: ticket,
      subject: ticket.subject,
      messages: ticket.messages
    });
  } else {
    const dummy = createTicket();
    res.json({
      success: true,
      data: dummy,
      conversation: dummy,
      subject: dummy.subject,
      messages: dummy.messages
    });
  }
};

// Endpoints
app.get('/api/support', listHandler);
app.get('/api/support/:id', singleHandler);

app.post('/api/support', (req, res) => {
  const newTicket = createTicket(req.body || {});
  supportStore.unshift(newTicket);

  res.json({
    success: true,
    message: 'Your message has been sent successfully.',
    data: newTicket
  });
});

app.get('/api/admin/support', listHandler);
app.get('/api/admin/support/:id', singleHandler);

app.post('/api/admin/support/*', (req, res) => {
  const { message, text, reply } = req.body || {};
  const replyContent = message || text || reply || 'Admin response sent';

  if (supportStore.length > 0) {
    const ticket = supportStore[0];
    const now = new Date().toISOString();
    ticket.messages.push({
      id: 'M-' + Date.now(),
      sender: 'admin',
      text: replyContent,
      message: replyContent,
      timestamp: now
    });
    ticket.updatedAt = now;
  }

  res.json({
    success: true,
    message: 'Reply sent successfully'
  });
});

// ── Standard API Routes ──────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

// ── Error Handling ───────────────────────────────────
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`\n🚀 Falcon Peak Venture API running on http://localhost:${PORT}`);
  await testConnection();
});
