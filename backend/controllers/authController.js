const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');

const SALT_ROUNDS = 12;

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, first_name: user.first_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

// POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { first_name, last_name, email, password, phone } = req.body;

  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ success: false, message: 'First name, last name, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
  }

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const [result] = await pool.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, phone, role)
     VALUES (?, ?, ?, ?, ?, 'customer')`,
    [first_name, last_name, email, passwordHash, phone || null]
  );

  const user = { id: result.insertId, email, role: 'customer', first_name };
  const token = signToken(user);
  setAuthCookie(res, token);

  res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    user: { id: user.id, first_name, last_name, email, role: 'customer' },
    token
  });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  if (rows.length === 0) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  const user = rows[0];

  if (user.status === 'disabled') {
    return res.status(403).json({ success: false, message: 'This account has been disabled. Contact support.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  const token = signToken(user);
  setAuthCookie(res, token);

  res.json({
    success: true,
    message: 'Logged in successfully.',
    user: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      role: user.role
    },
    token
  });
});

// POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, first_name, last_name, email, phone, role, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }
  res.json({ success: true, user: rows[0] });
});

module.exports = { register, login, logout, getMe };
