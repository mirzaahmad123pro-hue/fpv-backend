const express = require('express');
const router = express.Router();
const { getPublicBanners } = require('../controllers/bannerController');

// Public — the homepage carousel.
router.get('/', getPublicBanners);

module.exports = router;
