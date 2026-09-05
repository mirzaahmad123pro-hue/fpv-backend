const db = require('../config/database');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// ImgBB Upload Helper Function
async function uploadToImgBB(fileInput) {
  try {
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      console.error('IMGBB_API_KEY is missing in environment variables');
      return null;
    }

    let base64Image = '';

    if (typeof fileInput === 'string') {
      if (fileInput.startsWith('data:image')) {
        base64Image = fileInput.split(',')[1];
      } else if (fs.existsSync(fileInput)) {
        base64Image = fs.readFileSync(fileInput, { encoding: 'base64' });
      } else {
        base64Image = fileInput;
      }
    } else if (fileInput && fileInput.buffer) {
      base64Image = fileInput.buffer.toString('base64');
    } else if (fileInput && fileInput.path && fs.existsSync(fileInput.path)) {
      base64Image = fs.readFileSync(fileInput.path, { encoding: 'base64' });
      // Upload ke baad local temp file delete kar dein
      try { fs.unlinkSync(fileInput.path); } catch (e) {}
    }

    if (!base64Image) return null;

    const formData = new FormData();
    formData.append('image', base64Image);

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, formData, {
      headers: formData.getHeaders()
    });

    if (response.data && response.data.data && response.data.data.url) {
      return response.data.data.url;
    }
  } catch (error) {
    console.error('ImgBB Upload Error:', error.response ? error.response.data : error.message);
  }
  return null;
}

// Format product image URL for response
function formatProductImage(product) {
  if (!product) return product;

  let img = product.image_url || product.image || product.thumbnail || null;

  if (!img && product.images) {
    if (Array.isArray(product.images)) {
      img = product.images[0];
    } else if (typeof product.images === 'string') {
      try {
        const parsed = JSON.parse(product.images);
        img = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (e) {
        img = product.images;
      }
    }
  }

  const defaultPlaceholder = 'https://via.placeholder.com/300x300.png?text=No+Image';
  const finalImage = (img && typeof img === 'string' && img.trim() !== '') ? img.trim() : defaultPlaceholder;

  return {
    ...product,
    image_url: finalImage,
    image: finalImage,
    thumbnail: finalImage,
    images: [finalImage]
  };
}

// Get all products
const getProducts = async (req, res) => {
  try {
    const [products] = await db.query('SELECT * FROM products ORDER BY id DESC');
    const formattedProducts = products.map(formatProductImage);

    res.json({
      success: true,
      products: formattedProducts,
      data: formattedProducts,
      pagination: {
        total: formattedProducts.length,
        totalItems: formattedProducts.length,
        page: 1,
        limit: formattedProducts.length || 10,
        totalPages: 1
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get single product by ID
const getProductById = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: formatProductImage(rows[0]), data: formatProductImage(rows[0]) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get single product by Slug
const getProductBySlug = async (req, res) => {
  try {
    const param = req.params.slug;
    const [rows] = await db.query('SELECT * FROM products WHERE slug = ? OR id = ?', [param, param]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: formatProductImage(rows[0]), data: formatProductImage(rows[0]) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create product
const createProduct = async (req, res) => {
  try {
    const body = req.body || {};
    let imageUrl = body.image_url || body.image || null;

    // 1. Check Multer uploaded file
    if (req.files && req.files.length > 0) {
      const uploadedUrl = await uploadToImgBB(req.files[0]);
      if (uploadedUrl) imageUrl = uploadedUrl;
    } else if (req.file) {
      const uploadedUrl = await uploadToImgBB(req.file);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    // 2. Check base64 input if file upload was not present
    if (!imageUrl && body.image_base64) {
      const uploadedUrl = await uploadToImgBB(body.image_base64);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    const productName = body.name || body.title || 'Untitled Product';
    const computedSlug = body.slug || String(productName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const regularPrice = parseFloat(body.regular_price || body.price || 0);
    const stockQuantity = parseInt(body.stock_quantity !== undefined ? body.stock_quantity : (body.stock || 0), 10);

    const [result] = await db.query(
      `INSERT INTO products (name, slug, regular_price, price, stock_quantity, stock, image_url, image, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productName, computedSlug, regularPrice, regularPrice, stockQuantity, stockQuantity, imageUrl, imageUrl, body.status || 'active']
    );

    res.status(201).json({
      success: true,
      id: result.insertId,
      message: 'Product created successfully',
      image_url: imageUrl
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update product
const updateProduct = async (req, res) => {
  try {
    const productId = req.params.id;
    const body = req.body || {};
    let imageUrl = body.image_url || body.image || null;

    if (req.files && req.files.length > 0) {
      const uploadedUrl = await uploadToImgBB(req.files[0]);
      if (uploadedUrl) imageUrl = uploadedUrl;
    } else if (req.file) {
      const uploadedUrl = await uploadToImgBB(req.file);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    if (!imageUrl && body.image_base64) {
      const uploadedUrl = await uploadToImgBB(body.image_base64);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    const updateFields = [];
    const updateValues = [];

    if (body.name) { updateFields.push('name = ?'); updateValues.push(body.name); }
    if (body.regular_price) { updateFields.push('regular_price = ?', 'price = ?'); updateValues.push(parseFloat(body.regular_price), parseFloat(body.regular_price)); }
    if (body.stock_quantity !== undefined) { updateFields.push('stock_quantity = ?', 'stock = ?'); updateValues.push(parseInt(body.stock_quantity, 10), parseInt(body.stock_quantity, 10)); }
    if (imageUrl) { updateFields.push('image_url = ?', 'image = ?'); updateValues.push(imageUrl, imageUrl); }

    if (updateFields.length > 0) {
      updateValues.push(productId);
      await db.query(`UPDATE products SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);
    }

    res.json({ success: true, message: 'Product updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete product
const deleteProduct = async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getProducts,
  getProductById,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct
};
