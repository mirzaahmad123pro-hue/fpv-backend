const express = require('express');
const router = express.Router();
const { register, login, logout, getMe, changePassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');

// Public routes
router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);

// Protected routes
router.get('/me', authenticate, getMe);
router.put('/password', authenticate, changePassword);

module.exports = router;
