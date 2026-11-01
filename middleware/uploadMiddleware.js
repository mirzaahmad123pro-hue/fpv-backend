// middleware/uploadMiddleware.js
//
// Image upload handling with Multer — memory storage only.
//
// Uploaded files are no longer written to local disk. Multer instead keeps
// each file's bytes in memory as a Buffer (req.file.buffer for .single(),
// req.files[].buffer for .array()). Controllers pass that buffer to
// utils/imgbbHelper.js, which uploads it to ImgBB and returns a permanent
// CDN URL. That URL — never a local file path — is what gets saved to the
// database, so uploads survive restarts/redeploys on hosts with an
// ephemeral filesystem (Render, etc.) with no persistent disk required.
//
// NOTE: switching to memory storage means req.file.filename / req.file.path
// no longer exist. Any controller that builds an image path from those
// (e.g. `/uploads/categories/${req.file.filename}`) must be updated to call
// uploadToImgBB(req.file.buffer) and store the returned URL instead — see
// controllers/productController.js for the pattern, and the accompanying
// notes for categoryController.js / orderController.js.

const multer = require('multer');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 5;

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    // statusCode 400 so a rejected file type is reported as a client error,
    // not a 500 "server error" (errorMiddleware honours err.statusCode).
    const err = new Error('Only JPG, PNG, and WEBP image files are allowed.');
    err.statusCode = 400;
    cb(err);
  }
}

function makeUploader() {
  return multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 } // 5MB by default
  });
}

// There is nothing subfolder-specific left to configure now that nothing
// touches disk, so a single memory uploader is reused everywhere. Kept as
// separate named exports so existing route imports (uploadProductImages,
// uploadCategoryImage, uploadReceiptImage, uploadHeroBanner) don't need to
// change at the import site.
const uploader = makeUploader();

// Review photos get a tighter cap than product images (a customer snapshot
// never needs more than a couple of MB) and are limited to ONE file.
const reviewPhotoUploader = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024, files: 1 }
});

module.exports = {
  uploadProductImages: uploader,
  uploadCategoryImage: uploader,
  uploadReceiptImage: uploader,
  uploadHeroBanner: uploader,
  uploadReviewPhoto: reviewPhotoUploader
};
