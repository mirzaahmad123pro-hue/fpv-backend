const db = require('../config/database');
const fs = require('fs');
const axios = require('axios');

async function getTableColumns() {
  try {
    const [cols] = await db.query('SHOW COLUMNS FROM products');
    return cols.map(c => c.Field);
  } catch (error) {
    return [];
  }
}

// ImgBB Upload with Detailed Logging
async function uploadToImgBB(fileInput) {
  try {
    const apiKey = process.env.IMGBB_API_KEY || '82458d27aadfb56a92f2228e1d4e8b29';
    let base64Data = '';

    if (!fileInput) return null;

    if (typeof fileInput === 'object') {
      if (fileInput.buffer) {
        base64Data = fileInput.buffer.toString('base64');
      } else if (fileInput.path && fs.existsSync(fileInput.path)) {
        base64Data = fs.readFileSync(fileInput.path, { encoding: 'base64' });
        try { fs.unlinkSync(fileInput.path); } catch (e) {}
      }
    } else if (typeof fileInput === 'string') {
      let str = fileInput.trim();
      if (str.startsWith('data:image')) {
        base64Data = str.split(',')[1];
      } else if (fs.existsSync(str)) {
        base64Data = fs.readFileSync(str, { encoding: 'base64' });
      } else {
        base64Data = str;
      }
    }

    if (!base64Data) {
      console.log('⚠️ No valid base64 image data found to upload.');
      return null;
    }

    const params = new URLSearchParams();
    params.append('image', base64Data);

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    });

    if (response.data && response.data.data && response.data.data.url) {
      console.log('✅ ImgBB Direct URL Created:', response.data.data.url);
      return response.data.data.url;
    }
  } catch (error) {
    console.error('❌ ImgBB Upload Failed:', error.response ? error.response.data : error.message);
  }
  return null;
}

// Resolve Image Payload
async function resolveImageUrl(req) {
  console.log('--- UPLOAD DEBUG ---');
  console.log('req.file:', req.file ? req.file.originalname : 'none');
  console.log('req.files:', req.files ? Object.keys(req.files) : 'none');
  console.log('req.body keys:', Object.keys(req.body || {}));

  const body = req.body || {};

  // 1. Files
  let fileToUpload = req.file;
  if (!fileToUpload && req.files) {
    if (Array.isArray(req.files) && req.files.length > 0) fileToUpload = req.files[0];
    else if (typeof req.files === 'object') {
      const firstKey = Object.keys(req.files)[0];
      if (firstKey && req.files[firstKey].length > 0) fileToUpload = req.files[firstKey][0];
    }
  }

  if (fileToUpload) {
    console.log('Uploading file object to ImgBB...');
    const uploadedUrl = await uploadToImgBB(fileToUpload);
    if (uploadedUrl) return uploadedUrl;
  }

  // 2. Body Candidate
  let candidate = body.image_base64 || body.image_url || body.image || body.thumbnail || null;
  if (!candidate && body.images) {
    if (Array.isArray(body.images)) candidate = body.images[0];
    else if (typeof body.images === 'string') {
      try {
        const parsed = JSON.parse(body.images);
        candidate = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (e) {
        candidate = body.images;
      }
    }
  }

  if (candidate && typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) && !trimmed.includes('localhost') && !trimmed.includes('/uploads/')) {
      console.log('Using direct HTTP URL:', trimmed);
      return trimmed;
    }
    console.log('Uploading body string/base64 to ImgBB...');
    const uploadedUrl = await uploadToImgBB(trimmed);
    if (uploadedUrl) return uploadedUrl;
  }

  return null;
}

function formatProductImage(product) {
  if (!product) return product;

  let img = product.image_url || product.image || product.thumbnail || null;
  if (!img && product.images) {
    if (Array.isArray(product.images)) img = product.images[0];
    else if (typeof product.images === 'string') {
      try {
        const parsed = JSON.parse(product.images);
        img = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (e) { img = product.images; }
    }
  }

  const defaultPlaceholder = 'https://placehold.co/300x300/1e293b/e2e8f0?text=No+Image';
  let finalImage = defaultPlaceholder;

  if (img && typeof img === 'string' && img.trim() !== '') {
    const trimmed = img.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      finalImage = trimmed;
    }
  }

  return {
    ...product,
    image_url: finalImage,
    image: finalImage,
    thumbnail: finalImage,
    images: [finalImage]
  };
}

const getProducts = async (req, res) => {
  try {
    const existingCols = await getTableColumns();
    let query = 'SELECT * FROM products';
    if (existingCols.includes('id')) query += ' ORDER BY id DESC';

    const [products] = await db.query(query);
    const formattedProducts = products.map(formatProductImage);

    res.json({
      success: true,
      products: formattedProducts,
      data: formattedProducts,
      pagination: { total: formattedProducts.length, page: 1, limit: 100, totalPages: 1 }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getProductById = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: formatProductImage(rows[0]), data: formatProductImage(rows[0]) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

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

const createProduct = async (req, res) => {
  try {
    const body = req.body || {};
    const imageUrl = await resolveImageUrl(req);

    const productName = body.name || body.title || 'Untitled Product';
    const computedSlug = body.slug || String(productName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

    const candidateData = {
      name: productName,
      title: productName,
      slug: computedSlug,
      short_description: body.short_description || body.description || '',
      full_description: body.full_description || body.description || '',
      description: body.description || body.short_description || '',
      regular_price: body.regular_price ? parseFloat(body.regular_price) : parseFloat(body.price || 0),
      sale_price: body.sale_price ? parseFloat(body.sale_price) : null,
      price: parseFloat(body.regular_price || body.price || 0),
      stock_quantity: parseInt(body.stock_quantity !== undefined ? body.stock_quantity : (body.stock || 0), 10),
      stock: parseInt(body.stock_quantity !== undefined ? body.stock_quantity : (body.stock || 0), 10),
      category_id: body.category_id ? parseInt(body.category_id, 10) : 1,
      sku: body.sku || null,
      brand: body.brand || null,
      target_gender: body.target_gender || null,
      status: body.status || 'active',
      is_featured: (body.is_featured === 'true' || body.is_featured === true || body.is_featured === 1) ? 1 : 0,
      is_new_arrival: (body.is_new_arrival === 'true' || body.is_new_arrival === true || body.is_new_arrival === 1) ? 1 : 0,
      image_url: imageUrl,
      image: imageUrl,
      images: JSON.stringify(imageUrl ? [imageUrl] : [])
    };

    const existingCols = await getTableColumns();
    const insertKeys = [];
    const insertValues = [];

    for (const col of existingCols) {
      if (col === 'id' || col === 'created_at' || col === 'updated_at') continue;
      if (candidateData[col] !== undefined) {
        insertKeys.push(col);
        insertValues.push(candidateData[col]);
      }
    }

    const placeholders = insertKeys.map(() => '?').join(', ');
    const [result] = await db.query(
      `INSERT INTO products (${insertKeys.join(', ')}) VALUES (${placeholders})`,
      insertValues
    );

    res.status(201).json({ success: true, id: result.insertId, message: 'Product created successfully', image_url: imageUrl });
  } catch (error) {
    console.error('Create Product Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const productId = req.params.id;
    const body = req.body || {};
    const imageUrl = await resolveImageUrl(req);

    const productName = body.name || body.title;
    const computedSlug = productName ? String(productName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') : null;

    const candidateData = {};
    if (productName) { candidateData.name = productName; candidateData.title = productName; if (computedSlug) candidateData.slug = computedSlug; }
    if (body.short_description || body.description) { candidateData.short_description = body.short_description || body.description; candidateData.description = body.short_description || body.description; }
    if (body.full_description || body.description) { candidateData.full_description = body.full_description || body.description; }
    if (body.regular_price || body.price) { const p = parseFloat(body.regular_price || body.price); candidateData.regular_price = p; candidateData.price = p; }
    if (body.sale_price !== undefined && body.sale_price !== '') { candidateData.sale_price = body.sale_price ? parseFloat(body.sale_price) : null; }
    if (body.stock_quantity !== undefined || body.stock !== undefined) { const s = parseInt(body.stock_quantity !== undefined ? body.stock_quantity : body.stock, 10); candidateData.stock_quantity = s; candidateData.stock = s; }
    if (body.category_id) candidateData.category_id = parseInt(body.category_id, 10);
    if (body.sku) candidateData.sku = body.sku;
    if (body.brand) candidateData.brand = body.brand;
    if (body.target_gender) candidateData.target_gender = body.target_gender;
    if (body.status) candidateData.status = body.status;

    if (imageUrl) {
      candidateData.image_url = imageUrl;
      candidateData.image = imageUrl;
      candidateData.images = JSON.stringify([imageUrl]);
    }

    const existingCols = await getTableColumns();
    const updateSets = [];
    const updateValues = [];

    for (const col of existingCols) {
      if (col === 'id' || col === 'created_at' || col === 'updated_at') continue;
      if (candidateData[col] !== undefined) {
        updateSets.push(`${col} = ?`);
        updateValues.push(candidateData[col]);
      }
    }

    if (updateSets.length > 0) {
      updateValues.push(productId);
      await db.query(`UPDATE products SET ${updateSets.join(', ')} WHERE id = ?`, updateValues);
    }

    res.json({ success: true, message: 'Product updated successfully', image_url: imageUrl });
  } catch (error) {
    console.error('Update Product Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getProducts, getProductById, getProductBySlug, createProduct, updateProduct, deleteProduct };
