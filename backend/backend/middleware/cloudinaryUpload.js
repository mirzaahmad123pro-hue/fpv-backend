// Multer + Cloudinary helper for uploads that must survive redeploys:
// PRODUCT IMAGES and the HOMEPAGE HERO BANNER.
//
// Category images / payment receipts are untouched and keep using the
// original local-disk uploader in uploadMiddleware.js — this file only
// covers the two upload flows the task asked for.
//
// How it works: multer.memoryStorage() keeps the uploaded file's bytes
// in memory (req.file.buffer / req.files[].buffer) instead of writing
// to disk. uploadBufferToCloudinary() then streams those bytes straight
// to Cloudinary, which returns a permanent https:// URL. That URL is
// what gets saved to the database — never a local file path.

const multer = require('multer');
const cloudinary = require('../config/cloudinary');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and WEBP image files are allowed.'));
  }
}

function makeMemoryUploader() {
  const sizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 5;
  return multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: sizeMb * 1024 * 1024 }
  });
}

// Uploads one in-memory file buffer to Cloudinary and resolves with the
// Cloudinary result object (result.secure_url is the permanent URL).
function uploadBufferToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

module.exports = {
  uploadProductImagesMemory: makeMemoryUploader(),
  uploadHeroBannerMemory: makeMemoryUploader(),
  uploadBufferToCloudinary
};
