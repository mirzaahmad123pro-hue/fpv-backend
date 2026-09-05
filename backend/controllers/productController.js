const db = require('../config/database');
const { uploadToImgBB } = require('../utils/helpers');

// Helper to map image fields so frontend gets a complete URL
function formatProductImage(product, req) {
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
  let finalImage = (img && typeof img === 'string' && img.trim() !== '') ? img.trim() : defaultPlaceholder;

  // Agar relative path (/uploads/...) hai toh backend domain attach karein
  if (finalImage.startsWith('/uploads')) {
    const host = req ? `${req.protocol}://${req.get('host')}` : '';
    finalImage = `${host}${finalImage}`;
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
    const [products] = await db.query('SELECT * FROM products ORDER BY id DESC');
    const formattedProducts = products.map(p => formatProductImage(p, req));
    
    res.json({
      success: true,
      products: formattedProducts,
      data: formattedProducts
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
    const formatted = formatProductImage(rows[0], req);
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
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    const formatted = formatProductImage(rows[0], req);
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

    if (req.files && req.files.length > 0) {
      imageUrl = `/uploads/products/${req.files[0].filename}`;
    }

    const productName = body.name || body.title || 'Untitled Product';
    const computedSlug = body.slug || String(productName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

    const regularPrice = parseFloat(body.regular_price || body.price || 0);
    const stockQuantity = parseInt(body.stock_quantity !== undefined ? body.stock_quantity : (body.stock || 0), 10);

    const [result] = await db.query(
      `INSERT INTO products (name, slug, regular_price, price, stock_quantity, stock, image_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productName, computedSlug, regularPrice, regularPrice, stockQuantity, stockQuantity, imageUrl, body.status || 'active']
    );

    res.status(201).json({ success: true, id: result.insertId, message: 'Product created successfully' });
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
      imageUrl = `/uploads/products/${req.files[0].filename}`;
    }

    const updateFields = [];
    const updateValues = [];

    if (body.name) { updateFields.push('name = ?'); updateValues.push(body.name); }
    if (body.regular_price) { updateFields.push('regular_price = ?', 'price = ?'); updateValues.push(parseFloat(body.regular_price), parseFloat(body.regular_price)); }
    if (body.stock_quantity !== undefined) { updateFields.push('stock_quantity = ?', 'stock = ?'); updateValues.push(parseInt(body.stock_quantity, 10), parseInt(body.stock_quantity, 10)); }
    if (imageUrl) { updateFields.push('image_url = ?'); updateValues.push(imageUrl); }

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

module.exports = { getProducts, getProductById, getProductBySlug, createProduct, updateProduct, deleteProduct };
