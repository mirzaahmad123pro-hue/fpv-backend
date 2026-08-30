const express = require('express');
const router = express.Router();
const { 
  getProducts, 
  getProductBySlug, 
  createProduct, 
  updateProduct, 
  deleteProduct 
} = require('../controllers/productController');
const { protect, admin } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

router.route('/')
  .get(getProducts)
  .post(protect, admin, upload.array('images', 5), createProduct);

router.route('/:slug')
  .get(getProductBySlug);

router.route('/:id')
  .put(protect, admin, upload.array('images', 5), updateProduct)
  .delete(protect, admin, deleteProduct);

module.exports = router;
