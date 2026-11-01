const express = require('express');
const router = express.Router();
const { getActiveAnnouncement } = require('../controllers/messagingController');

// Public — the storefront shows the current announcement to every visitor.
router.get('/active', getActiveAnnouncement);

module.exports = router;
