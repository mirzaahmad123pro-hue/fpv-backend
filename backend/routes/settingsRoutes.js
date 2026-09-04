const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

// GET /api/settings
router.get('/', settingsController.getSettings);

module.exports = router;
