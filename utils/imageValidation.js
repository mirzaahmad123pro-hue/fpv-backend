// utils/imageValidation.js
//
// Multer's fileFilter only sees the mimetype the *client claims*. Anyone can
// upload "malware.exe" and label it image/png. This checks the file's actual
// leading bytes ("magic numbers") so only genuine JPEG / PNG / WEBP data is
// ever accepted, no matter what the filename or Content-Type says.

function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'image/png';
  // WEBP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Returns null when every file is a real image, otherwise a user-facing message.
function firstInvalidImageMessage(files) {
  for (const f of files || []) {
    if (!detectImageType(f.buffer)) {
      return `"${f.originalname || 'file'}" is not a valid JPG, PNG or WEBP image.`;
    }
  }
  return null;
}

module.exports = { detectImageType, firstInvalidImageMessage };
