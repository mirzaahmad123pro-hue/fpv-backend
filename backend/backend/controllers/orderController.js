const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { generateOrderNumber } = require('../utils/helpers');
const { getOrCreateCartId } = require('./cartController');
const { uploadToImgBB } = require('../utils/imgbbHelper');
const { detectImageType } = require('../utils/imageValidation');
const { flags } = require('../config/schema');

// Writes one row of the order-tracking timeline. Best effort on purpose: if the
// history table is unavailable the order itself must still go through.
async function recordStatus(conn, orderId, status, note) {
  if (!flags.statusHistory) return;
  try {
    await conn.query('INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)', [orderId, status, note || null]);
  } catch (e) {
    console.error('order_status_history insert failed:', e.message);
  }
}

// Item lines + a thumbnail and the chosen size/colour, for the orders pages.
const ITEM_SELECT = `
  SELECT oi.id, oi.order_id, oi.product_id, oi.variant_id, oi.product_name, oi.sku, oi.quantity, oi.unit_price, oi.subtotal,
         p.slug AS product_slug,
         v.size AS variant_size, v.color AS variant_color,
         COALESCE(
           (SELECT vi.image_path FROM product_images vi WHERE vi.id = v.image_id),
           (SELECT pi.image_path FROM product_images pi WHERE pi.product_id = oi.product_id ORDER BY pi.sort_order ASC, pi.id ASC LIMIT 1)
         ) AS thumbnail
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN product_variants v ON v.id = oi.variant_id`;

const VALID_PAYMENT_METHODS = ['cod', 'jazzcash', 'easypaisa', 'bank_transfer'];
const CANCELLABLE_ORDER_STATUSES = ['pending'];

// POST /api/orders
// Sent as multipart/form-data so a payment receipt screenshot can be
// attached for non-COD methods (field name: "receipt").
// Fields: shipping_address (JSON string: {full_name, phone, address_line,
//         city, province, postal_code}), payment_method: 'cod'|'jazzcash'|
//         'easypaisa'|'bank_transfer', notes, transaction_id?, receipt? (file)
const createOrder = asyncHandler(async (req, res) => {
  const { payment_method, notes, transaction_id } = req.body;

  // Optional — set by the "Buy Now" flow (product.html) so only that one
  // cart line is ordered, leaving the rest of the customer's cart intact.
  // Sent as a JSON string because this endpoint is multipart/form-data
  // (for the receipt upload). When absent, every item in the cart is
  // ordered — the original, unchanged behavior for the normal Cart →
  // Checkout flow.
  let itemIds = null;
  if (req.body.item_ids !== undefined) {
    try {
      const parsed = typeof req.body.item_ids === 'string' ? JSON.parse(req.body.item_ids) : req.body.item_ids;
      if (Array.isArray(parsed) && parsed.length > 0) {
        itemIds = parsed.map(Number).filter(Number.isInteger);
      }
    } catch (e) {
      // Malformed item_ids falls back to "checkout the whole cart" rather
      // than failing the order outright.
    }
  }

  // shipping_address arrives as a JSON string in multipart form-data
  // (form-data can't carry nested objects), but we also accept it as an
  // already-parsed object in case a JSON request body is used instead —
  // this keeps the endpoint backward compatible either way.
  let shipping_address = req.body.shipping_address;
  if (typeof shipping_address === 'string') {
    try {
      shipping_address = JSON.parse(shipping_address);
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid shipping address data.' });
    }
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
  const itemFilterSql = itemIds ? ' AND ci.id IN (?)' : '';
  const itemFilterParams = itemIds ? [itemIds] : [];
  const [items] = await pool.query(
    `SELECT ci.id, ci.quantity, ci.variant_id, p.id AS product_id, p.name, p.sku,
            p.regular_price, p.sale_price, p.stock_quantity,
            v.price_adjustment, v.stock_quantity AS variant_stock
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     WHERE ci.cart_id = ?${itemFilterSql}`,
    [cartId, ...itemFilterParams]
  );

  if (items.length === 0) {
    return res.status(400).json({
      success: false,
      message: itemIds ? 'That item is no longer in your cart — it may have already been ordered or removed.' : 'Your cart is empty.'
    });
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

  // COD stays 'pending' (fulfillment-based — nothing to verify up front).
  // JazzCash/Easypaisa/Bank Transfer go to 'pending_verification' instead
  // of ever silently auto-completing — an admin must check the uploaded
  // receipt and mark it Paid/Rejected before the order is treated as paid.
  const paymentStatus = isManualVerificationMethod ? 'pending_verification' : 'pending';

  let receiptPath = null;
  if (req.file) {
    if (!detectImageType(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'That receipt file is not a valid JPG, PNG, or WEBP image.' });
    }
    try {
      receiptPath = await uploadToImgBB(req.file.buffer);
    } catch (uploadErr) {
      return res.status(502).json({ success: false, message: `Uploading payment receipt to ImgBB failed: ${uploadErr.message}` });
    }
  }

  const isDeadlock = (e) => e && (e.errno === 1213 || e.code === 'ER_LOCK_DEADLOCK' || e.errno === 1205 || e.code === 'ER_LOCK_WAIT_TIMEOUT');
  for (let attempt = 1; ; attempt++) {
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

        // Decrease stock. The "AND stock_quantity >= ?" guard makes this safe when
        // two customers buy the last unit at the same moment: only one update can
        // succeed, the other is refused instead of driving stock below zero.
        const [stockResult] = item.variant_id
          ? await connection.query('UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?', [item.quantity, item.variant_id, item.quantity])
          : await connection.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?', [item.quantity, item.product_id, item.quantity]);
        if (stockResult.affectedRows === 0) {
          const soldOut = new Error(`"${item.product_name}" just sold out or no longer has enough stock. Please update your cart and try again.`);
          soldOut.statusCode = 409;
          throw soldOut;
        }
      }

      await recordStatus(connection, orderId, 'pending', 'Order placed');

      await connection.query(
        `INSERT INTO payments (order_id, payment_method, transaction_id, receipt_path, amount, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, payment_method, transaction_id || null, receiptPath, totalAmount, paymentStatus]
      );

      // Buy Now (itemIds set) only clears the specific line(s) just ordered,
      // so the rest of the customer's cart is left exactly as it was. The
      // normal Cart → Checkout flow (itemIds null) still clears everything.
      if (itemIds) {
        await connection.query('DELETE FROM cart_items WHERE cart_id = ? AND id IN (?)', [cartId, itemIds]);
      } else {
        await connection.query('DELETE FROM cart_items WHERE cart_id = ?', [cartId]);
      }

      await connection.commit();

      res.status(201).json({
        success: true,
        message: 'Order placed successfully.',
        order: { id: orderId, order_number: orderNumber, total_amount: totalAmount, payment_status: paymentStatus }
      });
      return;
    } catch (err) {
      await connection.rollback();
      // Two customers ordering the same last items at the same instant can make the database
      // abort one transaction as a "deadlock". That is normal and safe to repeat: the repeat
      // finds the stock gone and answers with the friendly "just sold out" message instead of an error.
      if (isDeadlock(err) && attempt < 4) {
        await new Promise(r => setTimeout(r, 30 + Math.random() * 120 * attempt));
        continue;
      }
      throw err;
    } finally {
      connection.release();
    }
  }
});

// GET /api/orders/my-orders
const getMyOrders = asyncHandler(async (req, res) => {
  const [orders] = await pool.query(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id]
  );

  // Attach the item lines (name, quantity, thumbnail, size/colour) so the
  // orders page can show what was bought without one request per order.
  if (orders.length > 0) {
    const [items] = await pool.query(`${ITEM_SELECT} WHERE oi.order_id IN (?) ORDER BY oi.id ASC`, [orders.map(o => o.id)]);
    const byOrder = new Map();
    items.forEach(it => {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    });
    orders.forEach(o => { o.items = byOrder.get(o.id) || []; });
  }
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, orders });
});

// GET /api/orders/:id
const getOrderById = asyncHandler(async (req, res) => {
  // The :id may be the numeric id (admin/older links) or the order number shown to
  // customers (e.g. the order-success page only knows the number).
  const key = String(req.params.id);
  const [orders] = /^\d+$/.test(key)
    ? await pool.query('SELECT * FROM orders WHERE id = ?', [key])
    : await pool.query('SELECT * FROM orders WHERE order_number = ?', [key]);
  if (orders.length === 0) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }
  const order = orders[0];

  const isOwner = order.user_id === req.user.id;
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ success: false, message: 'You do not have access to this order.' });
  }

  const [items] = await pool.query(`${ITEM_SELECT} WHERE oi.order_id = ? ORDER BY oi.id ASC`, [order.id]);
  const [payment] = await pool.query('SELECT * FROM payments WHERE order_id = ?', [order.id]);

  // Real timestamps for the tracking timeline (empty for orders placed before
  // the history table existed — the storefront falls back to created_at).
  let history = [];
  if (flags.statusHistory) {
    const [h] = await pool.query(
      'SELECT status, note, created_at FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC, id ASC',
      [order.id]
    );
    history = h;
  }

  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, order: { ...order, items, payment: payment[0] || null, history } });
});

// PUT /api/orders/:id/cancel  (customer) — body: { reason }
// Only allowed while the order is still 'pending'. Restores stock for
// every line item and records the reason the customer gave.
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

    // Lock the order row and re-check its status inside the transaction, so two
    // simultaneous cancel clicks can never both pass the check and restore the
    // stock twice.
    const [[locked]] = await connection.query('SELECT status FROM orders WHERE id = ? FOR UPDATE', [order.id]);
    if (!locked || !CANCELLABLE_ORDER_STATUSES.includes(locked.status)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This order can no longer be cancelled.' });
    }

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
    await recordStatus(connection, order.id, 'cancelled', 'Cancelled by customer');

    await connection.commit();
    res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

module.exports = { createOrder, getMyOrders, getOrderById, cancelOrder, recordStatus };
