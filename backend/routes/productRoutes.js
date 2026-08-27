const express = require('express');
const router = express.Router();
const {
  getProducts, getProductBySlug, getProductById,
  createProduct, updateProduct, deleteProduct, deleteProductImage
} = require('../controllers/productController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const { uploadProductImages } = require('../middleware/uploadMiddleware');

router.get('/', getProducts);
router.get('/id/:id', authenticate, requireAdmin, getProductById);
router.get('/:slug', getProductBySlug);
router.post('/', authenticate, requireAdmin, uploadProductImages.array('images', 8), createProduct);
router.put('/:id', authenticate, requireAdmin, uploadProductImages.array('images', 8), updateProduct);
router.delete('/:id', authenticate, requireAdmin, deleteProduct);
router.delete('/images/:imageId', authenticate, requireAdmin, deleteProductImage);

module.exports = router;
