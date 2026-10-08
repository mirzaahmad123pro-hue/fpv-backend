const multer = require('multer');

function fileFilter(req, file, cb) {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
}

// Supabase ke liye memory storage (file.buffer provide karta hai)
const storage = multer.memoryStorage();
const maxSizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 10;

const uploader = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: maxSizeMb * 1024 * 1024 }
});

module.exports = {
  uploadProductImages: uploader,
  uploadCategoryImage: uploader,
  uploadReceipt: uploader
};
