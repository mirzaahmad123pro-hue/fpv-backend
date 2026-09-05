const express = require('express');
const router = express.Router();
const multer = require('multer');

// Memory storage keeps file buffers in RAM (perfect for Render)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const {
  getProducts,
  getProductById,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct
} = require('../controllers/productController');

// Public Routes
router.get('/', getProducts);
router.get('/slug/:slug', getProductBySlug);
router.get('/:id', getProductById);

// Admin Routes with Multer File Parser
router.post('/', upload.any(), createProduct);
router.put('/:id', upload.any(), updateProduct);
router.delete('/:id', deleteProduct);

module.exports = router;
