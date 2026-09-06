const multer = require('multer');

function fileFilter(req, file, cb) {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'));
  }
}

function makeUploader() {
  const maxSizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 10;
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
