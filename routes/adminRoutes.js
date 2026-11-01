const express = require('express');
const router = express.Router();
const {
  getDashboard, getAllOrders, updateOrderStatus,
  getCustomers, getCustomerDetail, updateCustomerStatus,
  getPayments, updatePayment,
  getSettings, updateSettings, uploadHeroBanner
} = require('../controllers/adminController');
const {
  sendToAllCustomers, sendToOneCustomer, getSentMessages,
  getAdminAnnouncement, saveAnnouncement, removeAnnouncement
} = require('../controllers/messagingController');
const {
  getAdminUnreadCount, getAdminTickets, getAdminTicket, adminReply
} = require('../controllers/supportController');
const {
  getAllSocialAccounts, createSocialAccount, reorderSocialAccounts, updateSocialAccount, deleteSocialAccount
} = require('../controllers/socialMediaController');
const {
  getAllBanners, createBanner, updateBanner, deleteBanner
} = require('../controllers/bannerController');
const { uploadCategoryImage: uploadBannerImage } = require('../middleware/uploadMiddleware');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const { uploadHeroBannerMemory: uploadHeroBannerMiddleware } = require('../middleware/cloudinaryUpload');

router.use(authenticate, requireAdmin); // every /api/admin/* route requires an admin

router.get('/dashboard', getDashboard);

router.get('/orders', getAllOrders);
router.put('/orders/:id/status', updateOrderStatus);

router.get('/customers', getCustomers);
router.get('/customers/:id', getCustomerDetail);
router.put('/customers/:id/status', updateCustomerStatus);

router.get('/payments', getPayments);
router.put('/payments/:id', updatePayment);

router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.post('/settings/hero-banner', uploadHeroBannerMiddleware.single('image'), uploadHeroBanner);

// ── Messaging: message all / one customer, website-wide announcement ──
router.get('/messages', getSentMessages);
router.post('/messages/broadcast', sendToAllCustomers);
router.post('/messages/direct', sendToOneCustomer);
router.get('/announcement', getAdminAnnouncement);
router.put('/announcement', saveAnnouncement);
router.delete('/announcement', removeAnnouncement);

// ── Help / support inbox ──
router.get('/support/unread-count', getAdminUnreadCount);
router.get('/support', getAdminTickets);
router.get('/support/:id', getAdminTicket);
router.post('/support/:id/reply', adminReply);

// ── Social media accounts (Settings → Social Media Accounts / footer "Follow Us") ──
// /reorder must be registered before /:id so "reorder" isn't read as an id.
router.get('/social-media', getAllSocialAccounts);
router.post('/social-media', createSocialAccount);
router.put('/social-media/reorder', reorderSocialAccounts);
router.put('/social-media/:id', updateSocialAccount);
router.delete('/social-media/:id', deleteSocialAccount);

// ── Promotional banners (homepage carousel) ──
router.get('/banners', getAllBanners);
router.post('/banners', uploadBannerImage.single('image'), createBanner);
router.put('/banners/:id', uploadBannerImage.single('image'), updateBanner);
router.delete('/banners/:id', deleteBanner);

module.exports = router;
