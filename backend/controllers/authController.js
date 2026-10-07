const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { verifyGoogleIdToken, isConfigured: googleConfigured } = require('../utils/googleAuth');

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

// PUT /api/auth/password
const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ success: false, message: 'Current password and new password are required.' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
  }

  const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const match = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!match) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
  }

  const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

  res.json({ success: true, message: 'Password updated successfully.' });
});

// GET /api/auth/google-config
const getGoogleConfig = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    enabled: googleConfigured(),
    client_id: googleConfigured() ? process.env.GOOGLE_CLIENT_ID.trim() : null
  });
});

// POST /api/auth/google
const googleLogin = asyncHandler(async (req, res) => {
  const payload = await verifyGoogleIdToken(req.body && req.body.credential);
  const googleId = String(payload.sub);
  const email = String(payload.email).trim().toLowerCase();

  let [rows] = await pool.query('SELECT * FROM users WHERE google_id = ?', [googleId]);
  if (rows.length === 0) {
    [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  }

  let user;
  let isNew = false;

  if (rows.length > 0) {
    user = rows[0];

    if (user.status === 'disabled') {
      return res.status(403).json({ success: false, message: 'This account has been disabled. Contact support.' });
    }
    if (user.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Admin accounts must sign in from the admin login page.' });
    }
    if (user.google_id && user.google_id !== googleId) {
      return res.status(409).json({ success: false, message: 'This email is already linked to a different Google account.' });
    }
    if (!user.google_id) {
      await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
    }
  } else {
    const fullName = (payload.name || '').trim();
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    const firstName = (payload.given_name || nameParts[0] || email.split('@')[0]).slice(0, 80);
    const lastName = (payload.family_name || nameParts.slice(1).join(' ') || '').slice(0, 80);

    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);

    const [result] = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, google_id)
       VALUES (?, ?, ?, ?, 'customer', ?)`,
      [firstName, lastName, email, unusable, googleId]
    );
    user = { id: result.insertId, first_name: firstName, last_name: lastName, email, role: 'customer' };
    isNew = true;
  }

  const token = signToken(user);
  setAuthCookie(res, token);

  res.status(isNew ? 201 : 200).json({
    success: true,
    message: isNew ? 'Account created with Google.' : 'Logged in with Google.',
    isNew,
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

module.exports = { register, login, logout, getMe, changePassword, googleLogin, getGoogleConfig };
