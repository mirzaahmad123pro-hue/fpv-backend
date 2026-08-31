const axios = require('axios');

// Small shared helper functions used across controllers.

// Turns "Men's Running Shoes" into "mens-running-shoes"
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Generates a unique-looking order number like: FPV-2026-8H3K2Q
function generateOrderNumber() {
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FPV-${year}-${random}`;
}

// Formats a number as Pakistani Rupees text, e.g. 2999 -> "Rs. 2,999"
function formatPKR(amount) {
  const num = Number(amount) || 0;
  return 'Rs. ' + num.toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

// ImgBB API Upload Function
async function uploadToImgBB(base64Data) {
  try {
    if (!base64Data) return null;

    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const apiKey = process.env.IMGBB_API_KEY || '0257924d31bc4310078776acd495e8db';
    
    const formData = new URLSearchParams();
    formData.append('image', cleanBase64);

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, formData);

    if (response.data && response.data.data) {
      return response.data.data.url || response.data.data.display_url;
    }
    return null;
  } catch (error) {
    console.error('ImgBB Upload Error:', error.response?.data || error.message);
    return null;
  }
}

module.exports = { slugify, generateOrderNumber, formatPKR, uploadToImgBB };
