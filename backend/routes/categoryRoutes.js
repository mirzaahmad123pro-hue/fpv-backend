const express = require('express');
const router = express.Router();
const {
  getCategories, getCategoryBySlug, createCategory, updateCategory, deleteCategory
} = require('../controllers/categoryController');
const { authenticate, optionalAuthenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const { uploadCategoryImage } = require('../middleware/uploadMiddleware');

router.get('/', optionalAuthenticate, getCategories);
router.get('/:slug', getCategoryBySlug);
router.post('/', authenticate, requireAdmin, uploadCategoryImage.single('image'), createCategory);
router.put('/:id', authenticate, requireAdmin, uploadCategoryImage.single('image'), updateCategory);
router.delete('/:id', authenticate, requireAdmin, deleteCategory);

module.exports = router;
