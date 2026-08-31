// Get all products
exports.getProducts = async (req, res) => {
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
