const express = require('express');
const router = express.Router();
const { uploadProductImages } = require('../middleware/uploadMiddleware');
const {
  getProducts,
  getProductById,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct
} = require('../controllers/productController');

// Public routes
router.get('/', getProducts);
router.get('/slug/:slug', getProductBySlug);
router.get('/:id', getProductById);

// Admin routes (.any() use karne se field name mismatch ka masla khatam ho jata hai)
router.post('/', uploadProductImages.any(), createProduct);
router.put('/:id', uploadProductImages.any(), updateProduct);
router.delete('/:id', deleteProduct);

module.exports = router;
