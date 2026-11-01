const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const {
  createTicket, getMyTickets, getMyTicket, customerFollowUp
} = require('../controllers/supportController');
const { authenticate } = require('../middleware/authMiddleware');

// Stops a single account from flooding the admin inbox.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'You have sent a lot of messages. Please wait a while before sending more.' }
});

router.use(authenticate);

router.get('/', getMyTickets);
router.post('/', sendLimiter, createTicket);
router.get('/:id', getMyTicket);
router.post('/:id/messages', sendLimiter, customerFollowUp);

module.exports = router;
