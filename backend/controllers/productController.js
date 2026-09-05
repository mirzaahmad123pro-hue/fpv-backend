const db = require('../config/database');
const fs = require('fs');
const axios = require('axios');

// Dynamically check existing database columns
async function getTableColumns() {
  try {
    const [cols] = await db.query('SHOW COLUMNS FROM products');
    return cols.map(c => c.Field);
  } catch (error) {
    return [];
  }
}

// Reliable ImgBB Upload Helper using User's ImgBB API Key
async function uploadToImgBB(fileInput) {
  try {
    const apiKey = process.env.IMGBB_API_KEY || '82458d27aadfb56a92f2228e1d4e8b29';
    let base64Data = '';

    if (!fileInput) return null;

    // 1. Multer Memory or Disk File Object
    if (typeof fileInput === 'object') {
      if (fileInput.buffer) {
        base64Data = fileInput.buffer.toString('base64');
      } else if (fileInput.path && fs.existsSync(fileInput.path)) {
        base64Data = fs.readFileSync(fileInput.path, { encoding: 'base64' });
        try { fs.unlinkSync(fileInput.path); } catch (e) {}
      }
    } 
    // 2. Base64 String or File Path
    else if (typeof fileInput === 'string') {
      if (fileInput.startsWith('data:image')) {
        base64Data = fileInput.split(',')[1];
      } else if (fs.existsSync(fileInput)) {
        base64Data = fs.readFileSync(fileInput, { encoding: 'base64' });
      } else {
        base64Data = fileInput;
      }
    }

    if (!base64Data) return null;

    // Direct Base64 URL Encoding (No form-data header/stream issues)
    const params = new URLSearchParams();
    params.append('image', base64Data);

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    if (response.data && response.data.data && response.data.data.url) {
      console.log('✅ ImgBB Upload Success:', response.data.data.url);
      return response.data.data.url;
    }
  } catch (error) {
    console.error('❌ ImgBB Upload Error:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
  return null;
}

// Format product image URL so missing links fallback to a neutral placeholder
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

  // Neutral Placeholder Image
  const defaultPlaceholder = 'https://placehold.co/300x300/1e293b/e2e8f0?text=No+Image';
  let finalImage = defaultPlaceholder;

  if (img && typeof img === 'string' && img.trim() !== '') {
    const trimmed = img.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:image/')) {
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

// Get all products
const getProducts = async (req, res) => {
  try {
    const existingCols = await getTableColumns();
    let query = 'SELECT * FROM products';
    if (existingCols.includes('id')) {
      query += ' ORDER BY id DESC';
    }

    const [products] = await db.query(query);
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

    // Detect file from any Multer format
    let fileToUpload = null;
    if (req.file) {
      fileToUpload = req.file;
    } else if (req.files) {
      if (Array.isArray(req.files) && req.files.length > 0) {
        fileToUpload = req.files[0];
      } else if (typeof req.files === 'object') {
        const keys = Object.keys(req.files);
        if (keys.length > 0 && req.files[keys[0]].length > 0) {
          fileToUpload = req.files[keys[0]][0];
        }
      }
    }

    if (fileToUpload) {
      const uploadedUrl = await uploadToImgBB(fileToUpload);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    if (!imageUrl && body.image_base64) {
      const uploadedUrl = await uploadToImgBB(body.image_base64);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

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
      is_featured: (body.is_featured === 'true' || body.is_featured === true || body.is_featured === '1' || body.is_featured === 1) ? 1 : 0,
      is_new_arrival: (body.is_new_arrival === 'true' || body.is_new_arrival === true || body.is_new_arrival === '1' || body.is_new_arrival === 1) ? 1 : 0,
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

    let fileToUpload = null;
    if (req.file) {
      fileToUpload = req.file;
    } else if (req.files) {
      if (Array.isArray(req.files) && req.files.length > 0) {
        fileToUpload = req.files[0];
      } else if (typeof req.files === 'object') {
        const keys = Object.keys(req.files);
        if (keys.length > 0 && req.files[keys[0]].length > 0) {
          fileToUpload = req.files[keys[0]][0];
        }
      }
    }

    if (fileToUpload) {
      const uploadedUrl = await uploadToImgBB(fileToUpload);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    if (!imageUrl && body.image_base64) {
      const uploadedUrl = await uploadToImgBB(body.image_base64);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    const productName = body.name || body.title || 'Product';
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
      is_featured: (body.is_featured === 'true' || body.is_featured === true || body.is_featured === '1' || body.is_featured === 1) ? 1 : 0,
      is_new_arrival: (body.is_new_arrival === 'true' || body.is_new_arrival === true || body.is_new_arrival === '1' || body.is_new_arrival === 1) ? 1 : 0
    };

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
