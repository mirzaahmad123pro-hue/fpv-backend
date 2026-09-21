const express = require('express');
const router = express.Router();
const { register, login, googleLogin, logout, getMe, changePassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');

// Public routes
router.get('/google-config', (req, res) => {
    res.json({
        success: true,
        enabled: true,
        google_login_enabled: true,
        clientId: process.env.GOOGLE_CLIENT_ID
    });
});

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/logout', logout);

// Protected routes
router.get('/me', authenticate, getMe);
router.put('/password', authenticate, changePassword);

module.exports = router;
