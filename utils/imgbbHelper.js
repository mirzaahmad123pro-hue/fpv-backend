const axios = require('axios');
const FormData = require('form-data');

async function uploadImageToImgBB(file) {
  if (!process.env.IMGBB_API_KEY) {
    return file.path || file.secure_url || file.url || `/uploads/products/${file.filename || 'default.png'}`;
  }
  try {
    const form = new FormData();
    form.append('image', file.buffer ? file.buffer.toString('base64') : require('fs').createReadStream(file.path));
    
    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, form, {
      headers: { ...form.getHeaders() }
    });
    return response.data.data.url;
  } catch (error) {
    console.error('ImgBB upload error:', error.message);
    return file.path || file.secure_url || file.url || `/uploads/products/${file.filename || 'default.png'}`;
  }
}

module.exports = { uploadImageToImgBB };
