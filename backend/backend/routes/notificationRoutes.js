const express = require('express');
const router = express.Router();
const {
  getMyNotifications, getUnreadCounts, markAllRead, markRead
} = require('../controllers/messagingController');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

router.get('/', getMyNotifications);
router.get('/unread-count', getUnreadCounts);
router.put('/read-all', markAllRead);
router.put('/:id/read', markRead);

module.exports = router;
