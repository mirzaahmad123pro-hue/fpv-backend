const db = require('../config/database');
const { uploadToImgBB } = require('../utils/helpers');

// Helper to dynamically inspect database columns
async function getTableColumns() {
  try {
    const [cols] = await db.query('SHOW COLUMNS FROM products');
    return cols.map(c => c.Field);
  } catch (error) {
    return [];
  }
}

// Helper to map image fields so frontend always finds a valid image URL
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
    let query = 'SELECT * FROM products';
    const cols = await getTableColumns();
    if (cols.includes('created_at')) {
      query += ' ORDER BY created_at DESC';
    } else if (cols.includes('id')) {
      query += ' ORDER BY id DESC';
    }

    const [products] = await db.query(query);
    const formattedProducts = products.map(formatProductImage);
    const totalItems = formattedProducts.length;
    
    res.json({
      success: true,
      products: formattedProducts,
      data: formattedProducts,
      pagination: {
        total: totalItems,
        totalItems: totalItems,
        page: 1,
        limit: totalItems || 10,
        totalPages: 1
      },
      totalPages: 1,
      total: totalItems
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get single product by ID
const getProductById = async (req, res) => {
  try {
    const productId = req.params.id;
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [productId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const formatted = formatProductImage(rows[0]);
    res.json({ success: true, product: formatted, data: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get single product by Slug
const getProductBySlug = async (req, res) => {
  try {
    const param = req.params.slug;
    const [rows] = await db.query('SELECT * FROM products WHERE slug = ? OR id = ?', [param, param]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const formatted = formatProductImage(rows[0]);
    res.json({ success: true, product: formatted, data: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create product
const createProduct = async (req, res) => {
  try {
    const body = req.body || {};
    let imageUrl = body.image_url || body.image || null;
    let imagesList = [];

    // 1. Check for Multer file uploads (req.files)
    if (req.files && req.files.length > 0) {
      imagesList = req.files.map(file => `/uploads/products/${file.filename}`);
      imageUrl = imagesList[0];
    }

    // 2. Fallback to base64 upload if provided
    if (!imageUrl && body.image_base64) {
      try {
        const uploaded = await uploadToImgBB(body.image_base64);
        if (uploaded) {
          imageUrl = uploaded;
          imagesList.push(uploaded);
        }
      } catch (imgErr) {
        console.error('Image upload failed:', imgErr);
      }
    }

    if (imageUrl && imagesList.length === 0) {
      imagesList.push(imageUrl);
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
      regular_price: parseFloat(body.regular_price || body.price || 0),
      price: parseFloat(body.price || body.regular_price || 0),
      sale_price: body.sale_price ? parseFloat(body.sale_price) : null,
      stock_quantity: parseInt(body.stock_quantity !== undefined ? body.stock_quantity : (body.stock || 0), 10),
      stock: parseInt(body.stock !== undefined ? body.stock : (body.stock_quantity || 0), 10),
      category_id: body.category_id ? parseInt(body.category_id, 10) : 1,
      sku: body.sku || null,
      brand: body.brand || null,
      target_gender: body.target_gender || null,
      status: body.status || 'active',
      is_featured: (body.is_featured === 'true' || body.is_featured === true || body.is_featured === '1' || body.is_featured === 1) ? 1 : 0,
      is_new_arrival: (body.is_new_arrival === 'true' || body.is_new_arrival === true || body.is_new_arrival === '1' || body.is_new_arrival === 1) ? 1 : 0,
      image_url: imageUrl,
      image: imageUrl,
      images: JSON.stringify(imagesList)
    };

    const existingCols = await getTableColumns();
    const insertKeys = [];
    const insertValues = [];

    if (existingCols.length > 0) {
      for (const col of existingCols) {
        if (col === 'id' || col === 'created_at' || col === 'updated_at') continue;
        if (candidateData[col] !== undefined) {
          insertKeys.push(col);
          insertValues.push(candidateData[col]);
        }
      }
    } else {
      insertKeys.push('name', 'slug', 'regular_price', 'stock_quantity');
      insertValues.push(productName, computedSlug, candidateData.regular_price, candidateData.stock_quantity);
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
    let imagesList = [];

    if (req.files && req.files.length > 0) {
      imagesList = req.files.map(file => `/uploads/products/${file.filename}`);
      imageUrl = imagesList[0];
    }

    if (!imageUrl && body.image_base64) {
      try {
        const uploaded = await uploadToImgBB(body.image_base64);
        if (uploaded) {
          imageUrl = uploaded;
          imagesList.push(uploaded);
        }
      } catch (imgErr) {
        console.error('Image upload failed:', imgErr);
      }
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
      regular_price: parseFloat(body.regular_price || body.price || 0),
      price: parseFloat(body.price || body.regular_price || 0),
      sale_price: body.sale_price ? parseFloat(body.sale_price) : null,
      stock_quantity: parseInt(body.stock_quantity !== undefined ? body.stock_quantity : (body.stock || 0), 10),
      stock: parseInt(body.stock !== undefined ? body.stock : (body.stock_quantity || 0), 10),
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
      candidateData.images = JSON.stringify(imagesList.length > 0 ? imagesList : [imageUrl]);
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
