const express = require('express');
const router = express.Router();
const { getPublicSettings } = require('../controllers/settingsController');
const { getActiveSocialAccounts } = require('../controllers/socialMediaController');

// Public — no auth. Only whitelisted, non-sensitive keys are returned
// (see PUBLIC_SETTING_KEYS in settingsController.js).
router.get('/', getPublicSettings);

// Public — active social media accounts for the storefront footer.
router.get('/social-media', getActiveSocialAccounts);

module.exports = router;
