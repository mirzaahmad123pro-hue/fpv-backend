const express = require('express');
const router = express.Router();
const { createOrder, getMyOrders, getOrderById, cancelOrder } = require('../controllers/orderController');
const { authenticate } = require('../middleware/authMiddleware');
const { uploadReceiptImage } = require('../middleware/uploadMiddleware');

router.use(authenticate);

// multipart/form-data — "receipt" is an optional single file (required by
// the controller for non-COD payment methods).
router.post('/', uploadReceiptImage.single('receipt'), createOrder);
router.get('/my-orders', getMyOrders);
router.get('/:id', getOrderById);
router.put('/:id/cancel', cancelOrder);

module.exports = router;
