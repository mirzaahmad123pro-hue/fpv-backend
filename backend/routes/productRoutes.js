const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');

router.route('/')
  .get(productController.getProducts)
  .post(authenticate, requireAdmin, productController.createProduct);

router.route('/:slug')
  .get(productController.getProductBySlug);

router.route('/:id')
  .put(authenticate, requireAdmin, productController.updateProduct)
  .delete(authenticate, requireAdmin, productController.deleteProduct);

module.exports = router;
