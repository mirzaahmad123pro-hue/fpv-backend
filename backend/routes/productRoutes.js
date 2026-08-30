const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { protect, admin } = require('../middleware/authMiddleware');

router.route('/')
  .get(productController.getProducts)
  .post(protect, admin, productController.createProduct);

router.route('/:slug')
  .get(productController.getProductBySlug);

router.route('/:id')
  .put(protect, admin, productController.updateProduct)
  .delete(protect, admin, productController.deleteProduct);

module.exports = router;
