const db = require('../config/database');
const uploadToImgBB = require('../utils/imgbbHelper');

// Get all products
exports.getProducts = async (req, res) => {
  try {
    const [products] = await db.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get single product by slug
exports.getProductBySlug = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE slug = ?', [req.params.slug]);
    if (rows.length === 0) return res.status(404).json({ message: 'Product not found' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create product
exports.createProduct = async (req, res) => {
  try {
    const { name, slug, description, price, stock, category_id, image_base64 } = req.body;
    let image_url = null;

    if (image_base64) {
      image_url = await uploadToImgBB(image_base64);
    }

    const [result] = await db.query(
      'INSERT INTO products (name, slug, description, price, stock, category_id, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, slug, description, price, stock, category_id, image_url]
    );

    res.status(201).json({ id: result.insertId, message: 'Product created successfully', image_url });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update product
exports.updateProduct = async (req, res) => {
  try {
    const { name, slug, description, price, stock, category_id, image_base64 } = req.body;
    const productId = req.params.id;

    let query = 'UPDATE products SET name=?, slug=?, description=?, price=?, stock=?, category_id=?';
    let queryParams = [name, slug, description, price, stock, category_id];

    if (image_base64) {
      const image_url = await uploadToImgBB(image_base64);
      query += ', image_url=?';
      queryParams.push(image_url);
    }

    query += ' WHERE id=?';
    queryParams.push(productId);

    await db.query(query, queryParams);
    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete product
exports.deleteProduct = async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
