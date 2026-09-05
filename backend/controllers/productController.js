const db = require('../config/database');
const axios = require('axios');

async function getTableColumns() {
  try {
    const [cols] = await db.query('SHOW COLUMNS FROM products');
    return cols.map(c => c.Field);
  } catch (error) {
    return [];
  }
}

// ImgBB Upload with URLSearchParams and explicit Headers
async function uploadToImgBB(fileObj) {
  try {
    const apiKey = process.env.IMGBB_API_KEY || 'a4176249482cdaf9904922b86caaa5c3';
    let base64String = '';

    if (fileObj && fileObj.buffer) {
      base64String = fileObj.buffer.toString('base64');
    } else if (typeof fileObj === 'string') {
      base64String = fileObj.includes('base64,') ? fileObj.split('base64,')[1] : fileObj;
    }

    if (!base64String) {
      console.log('⚠️ [ImgBB] No valid Base64 image found');
      return null;
    }

    const params = new URLSearchParams();
    params.append('image', base64String);

    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${apiKey}`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 25000
      }
    );

    if (response.data && response.data.data && response.data.data.url) {
      console.log('✅ [ImgBB Success] Image URL:', response.data.data.url);
      return response.data.data.url;
    }
  } catch (error) {
    console.error('❌ [ImgBB API Error]:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
  return null;
}

async function resolveImageUrl(req) {
  let fileToUpload = null;

  if (req.files && Array.isArray(req.files) && req.files.length > 0) {
    fileToUpload = req.files[0];
    console.log('📦 [File Received]:', fileToUpload.originalname, 'Size:', fileToUpload.size);
  } else if (req.file) {
    fileToUpload = req.file;
    console.log('📦 [File Received Single]:', fileToUpload.originalname);
  }

  if (fileToUpload) {
    const uploadedUrl = await uploadToImgBB(fileToUpload);
    if (uploadedUrl) return uploadedUrl;
  }

  const body = req.body || {};
  let candidate = body.image_url || body.image || body.images || null;
  if (Array.isArray(candidate)) candidate = candidate[0];

  if (candidate && typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) && !trimmed.includes('localhost') && !trimmed.includes('blob:')) {
      return trimmed;
    }
    return await uploadToImgBB(trimmed);
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
      target_gender: body.gender_or_target || body.target_gender || null,
      status: body.status || 'active',
      is_featured: (body.featured == 1 || body.is_featured == 1) ? 1 : 0,
      is_new_arrival: (body.new_arrival == 1 || body.is_new_arrival == 1) ? 1 : 0,
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
    if (body.gender_or_target || body.target_gender) candidateData.target_gender = body.gender_or_target || body.target_gender;
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
