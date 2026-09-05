const express = require('express');
const router = express.Router();
const { createOrder, getMyOrders, getOrderById, cancelOrder } = require('../controllers/orderController');
const { authenticate } = require('../middleware/authMiddleware');
const { uploadReceipt } = require('../middleware/uploadMiddleware');

router.use(authenticate);

router.post('/', uploadReceipt.single('receipt'), createOrder);
router.get('/my-orders', getMyOrders);
router.get('/:id', getOrderById);

// Cancel Order Route
router.put('/:id/cancel', cancelOrder);

module.exports = router;
