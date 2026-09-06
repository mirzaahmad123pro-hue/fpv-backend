const multer = require('multer');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and WEBP image files are allowed.'));
  }
}

function makeUploader() {
  const maxSizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 5;
  return multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: maxSizeMb * 1024 * 1024 }
  });
}

module.exports = {
  uploadProductImages: makeUploader(),
  uploadCategoryImage: makeUploader(),
  uploadReceipt: makeUploader()
};
