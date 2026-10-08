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

// Smart Handler: Agar parameter number hai toh ID se, warna slug se dhoonde
const getProductByIdOrSlug = (req, res, next) => {
  const param = req.params.identifier;
  if (/^\d+$/.test(param)) {
    req.params.id = param;
    return getProductById(req, res, next);
  }
  req.params.slug = param;
  return getProductBySlug(req, res, next);
};

// Public routes
router.get('/', getProducts);
router.get('/id/:id', getProductById);
router.get('/slug/:slug', getProductBySlug);
router.get('/:identifier', getProductByIdOrSlug);

// Admin routes
router.post('/', uploadProductImages.any(), createProduct);
router.put('/:id', uploadProductImages.any(), updateProduct);
router.delete('/:id', deleteProduct);

module.exports = router;
