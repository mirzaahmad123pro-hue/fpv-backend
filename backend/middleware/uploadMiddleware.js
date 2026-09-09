const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;

function fileFilter(req, file, cb) {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'));
  }
}

function makeCloudinaryUploader(folderName) {
  const maxSizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 10;
  
  const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: `falcon_peak/${folderName}`,
      allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    },
  });

  return multer({
    storage: storage,
    fileFilter,
    limits: { fileSize: maxSizeMb * 1024 * 1024 }
  });
}

module.exports = {
  uploadProductImages: makeCloudinaryUploader('products'),
  uploadCategoryImage: makeCloudinaryUploader('categories'),
  uploadReceipt: makeCloudinaryUploader('receipts')
};
