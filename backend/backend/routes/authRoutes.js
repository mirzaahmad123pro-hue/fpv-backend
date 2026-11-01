const express = require('express');
const router = express.Router();
const { register, login, logout, getMe, updateProfile, changePassword, googleLogin, getGoogleConfig } = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.get('/google-config', getGoogleConfig);
router.post('/logout', logout);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, updateProfile);
router.put('/password', authenticate, changePassword);

module.exports = router;
