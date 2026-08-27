// Secure image upload handling with Multer.
// - Only allows image mime types (jpg, png, webp)
// - Limits file size (default 5MB, configurable via .env)
// - Generates a random, collision-safe filename (never trusts the
//   original filename from the client)

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function makeStorage(subfolder) {
  const uploadRoot = path.join(__dirname, '..', process.env.UPLOAD_PATH || 'uploads', subfolder);
  if (!fs.existsSync(uploadRoot)) {
    fs.mkdirSync(uploadRoot, { recursive: true });
  }

  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const randomName = crypto.randomBytes(16).toString('hex');
      cb(null, `${randomName}${ext}`);
    }
  });
}

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and WEBP image files are allowed.'));
  }
}

function makeUploader(subfolder) {
  const maxSizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 5;
  return multer({
    storage: makeStorage(subfolder),
    fileFilter,
    limits: { fileSize: maxSizeMb * 1024 * 1024 }
  });
}

module.exports = {
  uploadProductImages: makeUploader('products'),
  uploadCategoryImage: makeUploader('categories')
};
