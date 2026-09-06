const db = require('../config/database');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Auto-add missing image columns to MySQL Table automatically
async function autoFixDatabaseColumns() {
  try {
    const [cols] = await db.query('SHOW COLUMNS FROM products');
    const colNames = cols.map(c => String(c.Field || c.field || Object.values(c)[0]).toLowerCase());

    if (!colNames.includes('image_url')) {
      await db.query('ALTER TABLE products ADD COLUMN image_url TEXT NULL');
      console.log('✅ Auto-created image_url column in MySQL');
    }
    if (!colNames.includes('images')) {
      await db.query('ALTER TABLE products ADD COLUMN images JSON NULL');
      console.log('✅ Auto-created images column in MySQL');
    }
  } catch (err) {
    console.error('⚠️ Auto-fix column check error:', err.message);
  }
}

async function getTableColumns() {
  try {
    const [cols] = await db.query('SHOW COLUMNS FROM products');
    return cols.map(c => c.Field || c.field || Object.values(c)[0]);
  } catch (error) {
    return [];
  }
}

async function uploadToCloudinary(fileObj) {
  return new Promise((resolve) => {
    if (!fileObj || !fileObj.buffer) return resolve(null);

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'falcon_peak_products' },
      (error, result) => {
        if (error) {
          console.error('❌ [Cloudinary Error]:', error.message || error);
          return resolve(null);
        }
        return resolve(result.secure_url);
      }
    );

    uploadStream.end(fileObj.buffer);
  });
}

async function resolveImageUrl(req) {
  let fileToUpload = null;

  if (req.files && Array.isArray(req.files) && req.files.length > 0) {
    fileToUpload = req.files[0];
  } else if (req.file) {
    fileToUpload = req.file;
  }

  if (fileToUpload) {
    const uploadedUrl = await uploadToCloudinary(fileToUpload);
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
  }

  return null;
}

function formatProductImage(product) {
  if (!product) return product;

  let finalImage = null;

  for (const [key, val] of Object.entries(product)) {
    if (typeof val === 'string' && val.trim() !== '') {
      const trimmed = val.trim();
      if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) && !trimmed.includes('placehold.co')) {
        finalImage = trimmed;
        break;
      }
    }
  }

  if (!finalImage && product.images) {
    let imgs = product.images;
    if (typeof imgs === 'string') {
      try { imgs = JSON.parse(imgs); } catch (e) { imgs = [imgs]; }
    }
    if (Array.isArray(imgs) && imgs.length > 0 && typeof imgs[0] === 'string') {
      if (imgs[0].startsWith('http://') || imgs[0].startsWith('https://')) {
        finalImage = imgs[0];
      }
    }
  }

  if (!finalImage) {
    finalImage = 'https://placehold.co/300x300/1e293b/e2e8f0?text=No+Image';
  }

  return {
    ...product,
    image_url: finalImage,
    image: finalImage,
    thumbnail: finalImage,
    img: finalImage,
    images: [finalImage]
  };
}

const getProducts = async (req, res) => {
  try {
    await autoFixDatabaseColumns();
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
    await autoFixDatabaseColumns();
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
    await autoFixDatabaseColumns();
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
