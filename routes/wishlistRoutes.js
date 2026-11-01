const express = require('express');
const router = express.Router();
const { getWishlist, getWishlistIds, addToWishlist, removeFromWishlist } = require('../controllers/wishlistController');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate); // every wishlist route requires login

router.get('/', getWishlist);
router.get('/ids', getWishlistIds);
router.post('/', addToWishlist);
router.delete('/:productId', removeFromWishlist);

module.exports = router;
