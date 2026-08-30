const db = require('../config/database');

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
    const { 
      name, title, slug, short_description, full_description, description, 
      regular_price, price, sale_price, stock_quantity, stock, 
      category_id 
    } = req.body;

    const productName = name || title || 'product';
    const finalShortDesc = short_description || description || '';
    const finalFullDesc = full_description || description || '';
    const finalRegPrice = regular_price || price || 0;
    const finalSalePrice = sale_price || null;
    const finalStock = stock_quantity !== undefined ? stock_quantity : (stock || 0);
    const finalSlug = slug || String(productName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

    const [result] = await db.query(
      `INSERT INTO products 
        (name, slug, short_description, full_description, regular_price, sale_price, stock_quantity, category_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productName, finalSlug, finalShortDesc, finalFullDesc, finalRegPrice, finalSalePrice, finalStock, category_id || null]
    );

    res.status(201).json({ id: result.insertId, message: 'Product created successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update product
exports.updateProduct = async (req, res) => {
  try {
    const { 
      name, title, slug, short_description, full_description, description, 
      regular_price, price, sale_price, stock_quantity, stock, 
      category_id 
    } = req.body;
    const productId = req.params.id;

    const productName = name || title || 'product';
    const finalShortDesc = short_description || description || '';
    const finalFullDesc = full_description || description || '';
    const finalRegPrice = regular_price || price || 0;
    const finalSalePrice = sale_price || null;
    const finalStock = stock_quantity !== undefined ? stock_quantity : (stock || 0);
    const finalSlug = slug || String(productName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

    const query = `UPDATE products SET 
      name=?, slug=?, short_description=?, full_description=?, 
      regular_price=?, sale_price=?, stock_quantity=?, category_id=? WHERE id=?`;
    const queryParams = [productName, finalSlug, finalShortDesc, finalFullDesc, finalRegPrice, finalSalePrice, finalStock, category_id || null, productId];

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
