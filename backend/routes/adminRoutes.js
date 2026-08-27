const express = require('express');
const router = express.Router();
const {
  getDashboard, getAllOrders, updateOrderStatus,
  getCustomers, getCustomerDetail, updateCustomerStatus,
  getPayments, updatePayment,
  getSettings, updateSettings
} = require('../controllers/adminController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');

router.use(authenticate, requireAdmin); // every /api/admin/* route requires an admin

router.get('/dashboard', getDashboard);

router.get('/orders', getAllOrders);
router.put('/orders/:id/status', updateOrderStatus);

router.get('/customers', getCustomers);
router.get('/customers/:id', getCustomerDetail);
router.put('/customers/:id/status', updateCustomerStatus);

router.get('/payments', getPayments);
router.put('/payments/:id', updatePayment);

router.get('/settings', getSettings);
router.put('/settings', updateSettings);

module.exports = router;
