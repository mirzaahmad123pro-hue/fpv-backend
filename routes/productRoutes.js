const express = require('express');
const router = express.Router();
const {
  getProducts, suggestProducts, getProductBySlug, getProductById,
  createProduct, updateProduct, deleteProduct, deleteProductImage,
  reorderProductImages
} = require('../controllers/productController');
const { authenticate, optionalAuthenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const { uploadProductImages } = require('../middleware/uploadMiddleware');

// MAX_PRODUCT_IMAGES (10) is enforced three times, deliberately:
//  1) here, via multer's array() count limit (hard stop at the network layer)
//  2) again in productController.js (counts existing + incoming, since on an
//     edit the 10-image cap applies to the *total*, not just this request)
//  3) client-side in the admin Products page, so the admin sees the error
//     before ever uploading anything
router.get('/', optionalAuthenticate, getProducts);
router.get('/suggest', suggestProducts); // search type-ahead — must stay above /:slug
router.get('/id/:id', authenticate, requireAdmin, getProductById);
router.get('/:slug', optionalAuthenticate, getProductBySlug);
router.post('/', authenticate, requireAdmin, uploadProductImages.array('images', 10), createProduct);
router.put('/:id', authenticate, requireAdmin, uploadProductImages.array('images', 10), updateProduct);
router.delete('/:id', authenticate, requireAdmin, deleteProduct);
router.delete('/images/:imageId', authenticate, requireAdmin, deleteProductImage);
router.put('/:id/images/reorder', authenticate, requireAdmin, reorderProductImages);

module.exports = router;
