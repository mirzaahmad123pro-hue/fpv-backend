const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { generateOrderNumber } = require('../utils/helpers');
const { getOrCreateCartId } = require('./cartController');

const VALID_PAYMENT_METHODS = ['cod', 'jazzcash', 'easypaisa', 'bank_transfer'];
const CANCELLABLE_ORDER_STATUSES = ['pending'];

// POST /api/orders
const createOrder = asyncHandler(async (req, res) => {
  const { payment_method, notes, transaction_id } = req.body;

  let shipping_address = req.body.shipping_address;

  // JSON string parse karein ya fallback object banayein
  if (typeof shipping_address === 'string') {
    try {
      shipping_address = JSON.parse(shipping_address);
    } catch (e) {
      // Agar JSON string parsing fail ho jaye toh string ko address line treat karein
      shipping_address = {
        address_line: req.body.shipping_address
      };
    }
  }

  // Address keys normalization (frontend ke kisi bhi format ko standard shape mein convert karein)
  if (shipping_address && typeof shipping_address === 'object') {
    shipping_address.full_name = 
      shipping_address.full_name || 
      `${shipping_address.first_name || req.body.first_name || ''} ${shipping_address.last_name || req.body.last_name || ''}`.trim() || 
      req.body.full_name || 
      req.user?.name || 
      'Customer';

    shipping_address.phone = shipping_address.phone || req.body.phone || req.body.phone_number;
    shipping_address.address_line = shipping_address.address_line || shipping_address.street_address || shipping_address.address || req.body.street_address || req.body.address;
    shipping_address.city = shipping_address.city || req.body.city;
    shipping_address.province = shipping_address.province || req.body.province || '';
    shipping_address.postal_code = shipping_address.postal_code || req.body.postal_code || '';
  }

  if (!shipping_address || !shipping_address.full_name || !shipping_address.phone || !shipping_address.address_line || !shipping_address.city) {
    return res.status(400).json({ success: false, message: 'Complete shipping address is required.' });
  }

  if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ success: false, message: 'Invalid payment method.' });
  }

  // Non-COD methods require proof of payment.
  const isManualVerificationMethod = payment_method !== 'cod';
  if (isManualVerificationMethod && !req.file) {
    return res.status(400).json({ success: false, message: 'Please upload a screenshot/receipt of your payment.' });
  }

  const cartId = await getOrCreateCartId(req.user.id);
  const [items] = await pool.query(
    `SELECT ci.id, ci.quantity, ci.variant_id, p.id AS product_id, p.name, p.sku,
            p.regular_price, p.sale_price, p.stock_quantity,
            v.price_adjustment, v.stock_quantity AS variant_stock
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     WHERE ci.cart_id = ?`,
    [cartId]
  );

  if (items.length === 0) {
    return res.status(400).json({ success: false, message: 'Your cart is empty.' });
  }

  // Validate stock before committing
  for (const item of items) {
    const availableStock = item.variant_id ? item.variant_stock : item.stock_quantity;
    if (item.quantity > availableStock) {
      return res.status(400).json({ success: false, message: `"${item.name}" only has ${availableStock} left in stock.` });
    }
  }

  const [settingsRows] = await pool.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('shipping_fee','free_shipping_threshold')"
  );
  const settings = Object.fromEntries(settingsRows.map(s => [s.setting_key, s.setting_value]));
  const shippingFeeDefault = Number(settings.shipping_fee || 250);
  const freeShippingThreshold = Number(settings.free_shipping_threshold || 5000);

  let subtotal = 0;
  const orderItemsData = items.map(item => {
    const basePrice = item.sale_price ? Number(item.sale_price) : Number(item.regular_price);
    const unitPrice = basePrice + Number(item.price_adjustment || 0);
    const lineSubtotal = unitPrice * item.quantity;
    subtotal += lineSubtotal;
    return {
      product_id: item.product_id,
      variant_id: item.variant_id,
      product_name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      unit_price: unitPrice,
      subtotal: lineSubtotal
    };
  });

  const shippingFee = subtotal >= freeShippingThreshold ? 0 : shippingFeeDefault;
  const totalAmount = subtotal + shippingFee;
  const orderNumber = generateOrderNumber();

  const addressText = `${shipping_address.full_name}, ${shipping_address.phone}\n${shipping_address.address_line}, ${shipping_address.city}${shipping_address.province ? ', ' + shipping_address.province : ''}${shipping_address.postal_code ? ' ' + shipping_address.postal_code : ''}`;

  const paymentStatus = isManualVerificationMethod ? 'pending_verification' : 'pending';
  const receiptPath = req.file ? `/uploads/receipts/${req.file.filename}` : null;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orderResult] = await connection.query(
      `INSERT INTO orders (user_id, order_number, subtotal, shipping_fee, discount, total_amount, status, payment_status, payment_method, shipping_address, notes)
       VALUES (?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?, ?)`,
      [req.user.id, orderNumber, subtotal, shippingFee, totalAmount, paymentStatus, payment_method, addressText, notes || null]
    );
    const orderId = orderResult.insertId;

    for (const item of orderItemsData) {
      await connection.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, product_name, sku, quantity, unit_price, subtotal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.variant_id, item.product_name, item.sku, item.quantity, item.unit_price, item.subtotal]
      );

      // Decrease stock
      if (item.variant_id) {
        await connection.query('UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, item.variant_id]);
      } else {
        await connection.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, item.product_id]);
      }
    }

    await connection.query(
      `INSERT INTO payments (order_id, payment_method, transaction_id, receipt_path, amount, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, payment_method, transaction_id || null, receiptPath, totalAmount, paymentStatus]
    );

    await connection.query('DELETE FROM cart_items WHERE cart_id = ?', [cartId]);

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Order placed successfully.',
      order: { id: orderId, order_number: orderNumber, total_amount: totalAmount, payment_status: paymentStatus }
    });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// GET /api/orders/my-orders
const getMyOrders = asyncHandler(async (req, res) => {
  const [orders] = await pool.query(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ success: true, orders });
});

// GET /api/orders/:id
const getOrderById = asyncHandler(async (req, res) => {
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (orders.length === 0) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }
  const order = orders[0];

  const isOwner = order.user_id === req.user.id;
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ success: false, message: 'You do not have access to this order.' });
  }

  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  const [payment] = await pool.query('SELECT * FROM payments WHERE order_id = ?', [order.id]);

  res.json({ success: true, order: { ...order, items, payment: payment[0] || null } });
});

// PUT /api/orders/:id/cancel
const cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'Please select a cancellation reason.' });
  }

  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (orders.length === 0) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }
  const order = orders[0];

  if (order.user_id !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You do not have access to this order.' });
  }
  if (!CANCELLABLE_ORDER_STATUSES.includes(order.status)) {
    return res.status(400).json({ success: false, message: `This order can no longer be cancelled (current status: ${order.status}).` });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [items] = await connection.query('SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
    for (const item of items) {
      if (item.variant_id) {
        await connection.query('UPDATE product_variants SET stock_quantity = stock_quantity + ? WHERE id = ?', [item.quantity, item.variant_id]);
      } else if (item.product_id) {
        await connection.query('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?', [item.quantity, item.product_id]);
      }
    }

    await connection.query(
      `UPDATE orders SET status = 'cancelled', cancellation_reason = ?, cancelled_at = NOW() WHERE id = ?`,
      [reason.trim(), order.id]
    );

    await connection.commit();
    res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

module.exports = { createOrder, getMyOrders, getOrderById, cancelOrder };
