const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { uploadProductImages } = require('../middleware/uploadMiddleware');

router.get('/', productController.getProducts);
router.get('/id/:id', productController.getProductById);
router.get('/slug/:slug', productController.getProductBySlug);
router.get('/:id', productController.getProductById);

// uploadProductImages.array('images', 8) lganay se FormData ke text fields aur images parse hon gi
router.post('/', uploadProductImages.array('images', 8), productController.createProduct);
router.put('/:id', uploadProductImages.array('images', 8), productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

module.exports = router;
