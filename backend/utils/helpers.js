// Small shared helper functions used across controllers.

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateOrderNumber() {
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FPV-${year}-${random}`;
}

function formatPKR(amount) {
  const num = Number(amount) || 0;
  return 'Rs. ' + num.toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

// ImgBB Upload using Node native fetch (No extra packages needed)
async function uploadToImgBB(base64Data) {
  try {
    if (!base64Data) return null;

    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const apiKey = '0257924d31bc4310078776acd495e8db';
    
    const params = new URLSearchParams();
    params.append('image', cleanBase64);

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await response.json();
    if (data && data.success && data.data) {
      return data.data.url || data.data.display_url;
    }
    return null;
  } catch (error) {
    console.error('ImgBB Upload Error:', error.message || error);
    return null;
  }
}

module.exports = { slugify, generateOrderNumber, formatPKR, uploadToImgBB };
