const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

async function uploadToImgBB(file) {
  if (!file) return null;

  // Agar IMGBB_API_KEY set nahi hai, toh local path return kar dein taake app crash na ho
  if (!process.env.IMGBB_API_KEY) {
    return file.path || file.secure_url || file.url || `/uploads/${file.filename || 'default.png'}`;
  }

  try {
    const form = new FormData();
    if (file.buffer) {
      form.append('image', file.buffer.toString('base64'));
    } else if (file.path) {
      form.append('image', fs.createReadStream(file.path));
    } else {
      return null;
    }

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, form, {
      headers: { ...form.getHeaders() }
    });

    return response.data.data.url;
  } catch (error) {
    console.error('ImgBB upload error:', error.message);
    // Fallback taake image upload fail hone par bhi process na rukay
    return file.path || file.secure_url || file.url || null;
  }
}

// Dono tareeqon se export kar rahe hain taake koi bhi function name miss na ho
module.exports = uploadToImgBB;
module.exports.uploadToImgBB = uploadToImgBB;
module.exports.uploadImageToImgBB = uploadToImgBB;
