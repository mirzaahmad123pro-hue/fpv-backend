const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticate } = require('../middleware/authMiddleware');
const admin = require('../middleware/adminMiddleware');
router.route('/')
  .get(productController.getProducts)
.post(authenticate, admin, productController.createProduct);

router.route('/:slug')
  .get(productController.getProductBySlug);

router.route('/:id')
.put(authenticate, admin, productController.updateProduct)
.delete(authenticate, admin, productController.deleteProduct);

module.exports = router;
