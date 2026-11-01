const express = require('express');
const router = express.Router();
const { getProductReviews, saveReview, deleteMyReview } = require('../controllers/reviewController');
const { authenticate, optionalAuthenticate } = require('../middleware/authMiddleware');
const { uploadReviewPhoto } = require('../middleware/uploadMiddleware');

router.get('/product/:productId', optionalAuthenticate, getProductReviews);
// authenticate runs BEFORE the upload parser, so an anonymous request never
// gets to push a file into server memory — only logged-in customers can upload.
router.post('/', authenticate, uploadReviewPhoto.single('photo'), saveReview);
router.delete('/:id', authenticate, deleteMyReview);

module.exports = router;
