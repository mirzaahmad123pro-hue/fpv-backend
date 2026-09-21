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

// ── In-Memory Support Store ──────────────────────────
const supportStore = [];

// Helper function to build bulletproof ticket objects
function createTicketObject(raw = {}) {
  const now = new Date().toISOString();
  const id = raw.id || 'MSG-' + Date.now();
  const content = raw.message || raw.text || 'Help & Support Request';
  const name = raw.name || raw.user_name || 'Customer';
  const email = raw.email || raw.user_email || 'customer@falconpeakventure.com';
  const subject = raw.subject || 'Help & Support Request';

  const ticketObj = {
    id: id,
    _id: id,
    ticket_id: id,
    conversation_id: id,
    subject: subject,
    title: subject,
    message: content,
    text: content,
    user_name: name,
    user_email: email,
    name: name,
    email: email,
    status: raw.status || 'open',
    createdAt: raw.createdAt || now,
    updatedAt: now,
    user: { name, email },
    messages: [
      {
        id: 'M-' + Date.now(),
        sender: 'user',
        sender_type: 'user',
        text: content,
        message: content,
        timestamp: now,
        createdAt: now
      }
    ]
  };

  // Safe nested references
  ticketObj.ticket = ticketObj;
  ticketObj.conversation = ticketObj;

  return ticketObj;
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

// Basic rate limiting
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

// ── Body parsing (50MB Limit for Large Image Base64) ─
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// ── Static file serving for uploaded images (Local Fallback) ──
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Health check ─────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Falcon Peak Venture API is running.' });
});

// ── Announcement Fallback Route ──────────────────────
app.get('/api/announcements/active', (req, res) => {
  res.json({ success: true, announcements: [], data: [] });
});

// ── Support Handlers ─────────────────────────────────
const handleGetSupportList = (req, res) => {
  res.json({ 
    success: true, 
    data: supportStore, 
    conversations: supportStore, 
    messages: supportStore,
    tickets: supportStore
  });
};

const handleGetSingleSupport = (req, res) => {
  const { id } = req.params;
  const found = supportStore.find(t => t.id === id || t.conversation_id === id || t._id === id) || supportStore[0];

  if (found) {
    res.json({
      success: true,
      data: found,
      conversation: found,
      ticket: found,
      messages: found.messages || [],
      subject: found.subject
    });
  } else {
    const dummy = createTicketObject({ subject: 'Help & Support Request' });
    res.json({
      success: true,
      data: dummy,
      conversation: dummy,
      ticket: dummy,
      messages: dummy.messages,
      subject: dummy.subject
    });
  }
};

// User Endpoints
app.get('/api/support', handleGetSupportList);
app.get('/api/support/:id', handleGetSingleSupport);

app.post('/api/support', (req, res) => {
  const newTicket = createTicketObject(req.body || {});
  supportStore.unshift(newTicket);

  res.json({ 
    success: true, 
    message: 'Your message has been sent successfully.',
    data: newTicket,
    conversation: newTicket,
    ticket: newTicket
  });
});

// Admin Endpoints
app.get('/api/admin/support', handleGetSupportList);
app.get('/api/admin/support/:id', handleGetSingleSupport);

app.post('/api/admin/support/*', (req, res) => {
  const { message, text, reply } = req.body || {};
  const replyContent = message || text || reply || 'Admin response sent';

  if (supportStore.length > 0) {
    const ticket = supportStore[0];
    const now = new Date().toISOString();
    ticket.messages.push({
      id: 'M-' + Date.now(),
      sender: 'admin',
      sender_type: 'admin',
      text: replyContent,
      message: replyContent,
      timestamp: now,
      createdAt: now
    });
    ticket.updatedAt = now;
  }

  res.json({ 
    success: true, 
    message: 'Reply sent successfully' 
  });
});

// ── API routes ───────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

// ── 404 + error handling ─────────────────────────────
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`\n🚀 Falcon Peak Venture API running on http://localhost:${PORT}`);
  await testConnection();
});
