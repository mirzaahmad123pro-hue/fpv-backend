// End-to-end API tests for the Fast Global Eagle backend.
//
//   FGE_ALLOW_TEST_DATA=1 npm test
//
// What it does: starts the real server on a random port against the database in
// your .env, starts a tiny stand-in for ImgBB (so image uploads can be tested
// without an internet account), then exercises the storefront and admin APIs.
//
// SAFETY: it creates clearly-labelled test records ("ZZTEST ..." / zztest-*@example.test)
// and removes them again at the end. Because it writes to the database, it refuses to
// run unless you set FGE_ALLOW_TEST_DATA=1 — point it at a test/staging database, not
// at your live store.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (process.env.FGE_ALLOW_TEST_DATA !== '1') {
  console.error('\nRefusing to run: these tests create (and then delete) test records in the database.');
  console.error('Use a test database and run:  FGE_ALLOW_TEST_DATA=1 npm test\n');
  process.exit(1);
}

const RUN = Date.now().toString(36);
const T = (s) => `ZZTEST ${s} ${RUN}`;
const EMAIL = (s) => `zztest-${s}-${RUN}@example.test`;
const PASSWORD = 'TestPass#2026';
const ADMIN_EMAIL = `zztest-admin-${RUN}@example.test`;
const ADMIN_PASSWORD = 'AdminPass#2026';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let fakeImgbb, serverProc, BASE, pool;
const created = { emails: [] };
let adminToken, aliceToken, bobToken;
const ids = {};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  let body;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(BASE + url, { method, headers, body });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { status: res.status, body: data, headers: res.headers };
}

function productForm(fields, withImage, fileField = 'images') {
  const f = new FormData();
  Object.entries(fields).forEach(([k, v]) => f.append(k, typeof v === 'string' ? v : JSON.stringify(v)));
  if (withImage) f.append(fileField, new Blob([PNG], { type: 'image/png' }), 'test.png');
  return f;
}

async function register(label) {
  const email = EMAIL(label);
  created.emails.push(email);
  const r = await api('POST', '/api/auth/register', { json: { first_name: 'Test', last_name: label, email, password: PASSWORD, phone: '03001234567' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}

async function placeOrder(token, itemIds) {
  const f = new FormData();
  f.append('payment_method', 'cod');
  f.append('shipping_address', JSON.stringify({ full_name: 'Test Buyer', phone: '03001234567', address_line: '1 Test Street', city: 'Faisalabad', province: 'Punjab', postal_code: '38000' }));
  if (itemIds) f.append('item_ids', JSON.stringify(itemIds));
  return api('POST', '/api/orders', { token, form: f });
}

before(async () => {
  // Stand-in for ImgBB: returns a fake URL for any upload.
  fakeImgbb = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { url: `http://127.0.0.1/fake-image-${Math.random().toString(36).slice(2, 8)}.png` } }));
    });
  });
  const imgPort = await listen(fakeImgbb);

  const port = 20000 + Math.floor(Math.random() * 20000);
  BASE = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    CLIENT_ORIGIN: 'http://localhost:8080',
    IMGBB_API_KEY: 'test-key',
    IMGBB_UPLOAD_URL: `http://127.0.0.1:${imgPort}/upload`,
    INITIAL_ADMIN_EMAIL: ADMIN_EMAIL,
    INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD
  };
  created.emails.push(ADMIN_EMAIL);

  const mk = spawnSync(process.execPath, ['utils/createAdmin.js'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(mk.status, 0, 'createAdmin failed: ' + mk.stdout + mk.stderr);

  serverProc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serverProc.stdout.on('data', d => { log += d; });
  serverProc.stderr.on('data', d => { log += d; });

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
    if (i === 59) throw new Error('server did not start:\n' + log);
  }
  // wait for the schema upgrade to finish
  for (let i = 0; i < 60 && !/schema: up to date[\s\S]*schema: up to date|schema: up to date/.test(log); i++) await new Promise(r => setTimeout(r, 250));
  await new Promise(r => setTimeout(r, 1500));

  ({ pool } = require('../config/database'));

  const login = await api('POST', '/api/auth/login', { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  adminToken = login.body.token;
  aliceToken = await register('alice');
  bobToken = await register('bob');
});

after(async () => {
  try {
    if (pool) {
      const [users] = await pool.query('SELECT id FROM users WHERE email LIKE ?', [`zztest-%-${RUN}@example.test`]);
      const uids = users.map(u => u.id);
      if (uids.length) {
        await pool.query('DELETE FROM orders WHERE user_id IN (?)', [uids]);
        await pool.query('DELETE FROM users WHERE id IN (?)', [uids]);
      }
      await pool.query('DELETE FROM products WHERE name LIKE ?', [`ZZTEST %${RUN}`]);
      await pool.query('DELETE FROM categories WHERE parent_id IS NOT NULL AND name LIKE ?', [`ZZTEST %${RUN}`]);
      await pool.query('DELETE FROM categories WHERE name LIKE ?', [`ZZTEST %${RUN}`]);
      await pool.query('DELETE FROM banners WHERE title LIKE ?', [`ZZTEST %${RUN}`]);
      await pool.end();
    }
  } catch (e) { console.error('cleanup problem:', e.message); }
  if (serverProc) serverProc.kill();
  if (fakeImgbb) fakeImgbb.close();
});

// ───────────────────────── public endpoints ─────────────────────────

test('health check, home payload shape and caching headers', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  const home = await api('GET', '/api/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.success, true);
  for (const k of ['settings', 'categories', 'banners', 'sections']) assert.ok(k in home.body, `home.${k} missing`);
  for (const k of ['flash_sale', 'featured', 'new_arrivals', 'just_for_you']) assert.ok(k in home.body.sections, `sections.${k} missing`);
  assert.match(home.headers.get('cache-control') || '', /max-age/);
  assert.ok('flash_sale_ends_at' in home.body.settings && 'flash_sale_title' in home.body.settings);
});

test('search suggestions need 2+ characters and never error on odd input', async () => {
  const short = await api('GET', '/api/products/suggest?q=a');
  assert.equal(short.status, 200);
  assert.deepEqual(short.body.products, []);
  const odd = await api('GET', '/api/products/suggest?q=' + encodeURIComponent("100%_'\";--"));
  assert.equal(odd.status, 200);
});

test('profile: a customer can update name and phone (was a demo stub), bad input is refused', async () => {
  const bad = await api('PUT', '/api/auth/profile', { token: aliceToken, json: { first_name: '', last_name: 'X' } });
  assert.equal(bad.status, 400);
  const badPhone = await api('PUT', '/api/auth/profile', { token: aliceToken, json: { first_name: 'Alice', last_name: 'Tester', phone: '<script>' } });
  assert.equal(badPhone.status, 400);
  const ok = await api('PUT', '/api/auth/profile', { token: aliceToken, json: { first_name: 'Alicia', last_name: 'Tester', phone: '0300 1234567' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.first_name, 'Alicia');
  const me = await api('GET', '/api/auth/me', { token: aliceToken });
  assert.equal(me.body.user.phone, '0300 1234567');
  assert.equal(me.body.user.email, EMAIL('alice'), 'the e-mail address must not change');
  const guest = await api('PUT', '/api/auth/profile', { json: { first_name: 'A', last_name: 'B' } });
  assert.equal(guest.status, 401);
});

// ───────────────────────── categories (subcategories) ─────────────────────────

test('admin creates a parent category and a subcategory; invalid parents are refused', async () => {
  const parent = await api('POST', '/api/categories', { token: adminToken, form: productForm({ name: T('Parent'), status: 'active' }) });
  assert.equal(parent.status, 201, JSON.stringify(parent.body));
  ids.parent = parent.body.categoryId;

  const child = await api('POST', '/api/categories', { token: adminToken, form: productForm({ name: T('Child'), parent_id: String(ids.parent) }) });
  assert.equal(child.status, 201, JSON.stringify(child.body));
  ids.child = child.body.categoryId;

  const grandchild = await api('POST', '/api/categories', { token: adminToken, form: productForm({ name: T('Grandchild'), parent_id: String(ids.child) }) });
  assert.equal(grandchild.status, 400, 'a third level must be refused');

  const selfParent = await api('PUT', `/api/categories/${ids.parent}`, { token: adminToken, form: productForm({ parent_id: String(ids.parent) }) });
  assert.equal(selfParent.status, 400, 'a category cannot be its own parent');

  const parentUnderChild = await api('PUT', `/api/categories/${ids.parent}`, { token: adminToken, form: productForm({ parent_id: String(ids.child) }) });
  assert.equal(parentUnderChild.status, 400, 'a category with children cannot become a child');

  const list = await api('GET', '/api/categories');
  const c = list.body.categories.find(x => x.id === ids.child);
  assert.equal(c.parent_id, ids.parent);
  assert.equal(typeof c.product_count, 'number');

  const del = await api('DELETE', `/api/categories/${ids.parent}`, { token: adminToken });
  assert.equal(del.status, 409, 'a parent with subcategories cannot be deleted');
});

test('customers cannot use admin endpoints; guests get 401', async () => {
  const asCustomer = await api('POST', '/api/categories', { token: aliceToken, form: productForm({ name: T('Nope') }) });
  assert.equal(asCustomer.status, 403);
  const asGuest = await api('GET', '/api/admin/banners');
  assert.equal(asGuest.status, 401);
  const wl = await api('GET', '/api/wishlist');
  assert.equal(wl.status, 401);
});

// ───────────────────────── products ─────────────────────────

test('price validation: a sale price must be lower than the regular price', async () => {
  const bad = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('BadPrice'), regular_price: '1000', sale_price: '1500', stock_quantity: '5' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Sale price/);
  const zero = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('ZeroPrice'), regular_price: '0' }) });
  assert.equal(zero.status, 400);
});

test('products with image upload, variants and sale price are created; listing filters work', async () => {
  const a = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('Alpha Watch'), brand: 'ZZBrandA', regular_price: '2000', sale_price: '1500', stock_quantity: '10', featured: '1', new_arrival: '1' }, true) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  ids.alpha = a.body.productId;

  const b = await api('POST', '/api/products', { token: adminToken, form: productForm({
    category_id: String(ids.child), name: T('Beta Shirt'), brand: 'ZZBrandB', regular_price: '800', stock_quantity: '3',
    variants: [{ size: 'M', color: 'Blue', price_adjustment: 100, stock_quantity: 2 }, { size: 'L', color: 'Blue', price_adjustment: 0, stock_quantity: 1 }]
  }) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  ids.beta = b.body.productId;

  const c = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('Gamma Out'), regular_price: '300', stock_quantity: '0' }) });
  assert.equal(c.status, 201);
  ids.gamma = c.body.productId;

  // cache invalidation: a brand-new product shows up immediately, not after the 30s TTL
  const home = await api('GET', '/api/home');
  assert.ok(home.body.sections.just_for_you.products.some(p => p.id === ids.alpha), 'new product missing from /api/home right after creation');

  // category filter on the PARENT includes the child's products
  const byParent = await api('GET', `/api/products?category=${ids.parentSlug || (await slugOf(ids.parent))}&limit=50`);
  assert.ok(byParent.body.products.some(p => p.id === ids.alpha), 'parent category must include subcategory products');

  const sale = await api('GET', '/api/products?on_sale=1&limit=50');
  assert.ok(sale.body.products.some(p => p.id === ids.alpha) && !sale.body.products.some(p => p.id === ids.beta));

  const stock = await api('GET', '/api/products?in_stock=1&limit=100');
  assert.ok(!stock.body.products.some(p => p.id === ids.gamma), 'out-of-stock product must be hidden by in_stock=1');

  const range = await api('GET', `/api/products?category=${await slugOf(ids.child)}&min_price=1000&max_price=1600&limit=50`);
  assert.deepEqual(range.body.products.map(p => p.id), [ids.alpha], 'price range uses the sale price when there is one');

  const brand = await api('GET', `/api/products?brand=ZZBrandB&limit=50`);
  assert.deepEqual(brand.body.products.map(p => p.id), [ids.beta]);

  const asc = await api('GET', `/api/products?category=${await slugOf(ids.child)}&sort=price_asc&limit=50`);
  const prices = asc.body.products.map(p => Number(p.sale_price || p.regular_price));
  assert.deepEqual(prices, [...prices].sort((x, y) => x - y));

  const facets = await api('GET', `/api/products?category=${await slugOf(ids.child)}&facets=1&limit=1`);
  assert.ok(facets.body.facets.brands.some(x => x.name === 'ZZBrandA'));
  assert.equal(facets.body.facets.price_min, 300);
  assert.equal(facets.body.facets.price_max, 1500);

  const sug = await api('GET', '/api/products/suggest?q=' + encodeURIComponent('Alpha Watch'));
  assert.ok(sug.body.products.some(p => p.id === ids.alpha), 'suggestions should find the product by name');

  const detail = await api('GET', `/api/products/${await slugOfProduct(ids.alpha)}`);
  assert.equal(detail.body.product.images.length, 1, 'uploaded image should be stored');
});

test('featured / new-arrival checkboxes: "0" means off (bug fix — it used to turn both ON)', async () => {
  const off = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('Flags Off'), regular_price: '100', stock_quantity: '1', featured: '0', new_arrival: '0' }) });
  assert.equal(off.status, 201);
  const [[a]] = await pool.query('SELECT featured, new_arrival FROM products WHERE id = ?', [off.body.productId]);
  assert.deepEqual([a.featured, a.new_arrival], [0, 0]);
  const on = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('Flags On'), regular_price: '100', stock_quantity: '1', featured: '1', new_arrival: '1' }) });
  const [[b]] = await pool.query('SELECT featured, new_arrival FROM products WHERE id = ?', [on.body.productId]);
  assert.deepEqual([b.featured, b.new_arrival], [1, 1]);
  const upd = await api('PUT', `/api/products/${off.body.productId}`, { token: adminToken, form: productForm({ featured: '0', new_arrival: '1' }) });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const [[c]] = await pool.query('SELECT featured, new_arrival FROM products WHERE id = ?', [off.body.productId]);
  assert.deepEqual([c.featured, c.new_arrival], [0, 1]);
});

async function slugOf(categoryId) {
  const r = await api('GET', '/api/categories');
  return r.body.categories.find(c => c.id === categoryId).slug;
}
async function slugOfProduct(productId) {
  const [[row]] = await pool.query('SELECT slug FROM products WHERE id = ?', [productId]);
  return row.slug;
}

// ───────────────────────── banners ─────────────────────────

test('banners: validation, creation with image upload, public listing, deletion', async () => {
  const noImage = await api('POST', '/api/admin/banners', { token: adminToken, form: productForm({ title: T('NoImage') }) });
  assert.equal(noImage.status, 400);

  const badLink = await api('POST', '/api/admin/banners', { token: adminToken, form: productForm({ title: T('BadLink'), link_url: 'javascript:alert(1)' }, true, 'image') });
  assert.equal(badLink.status, 400, 'script links must be refused');

  const ok = await api('POST', '/api/admin/banners', { token: adminToken, form: productForm({ title: T('Promo'), subtitle: 'Up to 50% off', link_url: 'shop.html?on_sale=1', sort_order: '1' }, true, 'image') });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  ids.banner = ok.body.bannerId;

  const pub = await api('GET', '/api/banners');
  const found = pub.body.banners.find(b => b.id === ids.banner);
  assert.ok(found && found.link_url === 'shop.html?on_sale=1' && /^http/.test(found.image));

  const hide = await api('PUT', `/api/admin/banners/${ids.banner}`, { token: adminToken, form: productForm({ status: 'inactive' }) });
  assert.equal(hide.status, 200);
  const pub2 = await api('GET', '/api/banners');
  assert.ok(!pub2.body.banners.some(b => b.id === ids.banner), 'inactive banner must not be public');

  const del = await api('DELETE', `/api/admin/banners/${ids.banner}`, { token: adminToken });
  assert.equal(del.status, 200);
});

// ───────────────────────── wishlist ─────────────────────────

test('wishlist: add (idempotent), list, ids, remove', async () => {
  const add = await api('POST', '/api/wishlist', { token: aliceToken, json: { product_id: ids.alpha } });
  assert.equal(add.status, 201);
  const again = await api('POST', '/api/wishlist', { token: aliceToken, json: { product_id: ids.alpha } });
  assert.equal(again.status, 201);

  const list = await api('GET', '/api/wishlist', { token: aliceToken });
  assert.equal(list.body.products.length, 1);
  assert.equal(list.body.products[0].id, ids.alpha);

  const idsRes = await api('GET', '/api/wishlist/ids', { token: aliceToken });
  assert.deepEqual(idsRes.body.ids, [ids.alpha]);

  const bobList = await api('GET', '/api/wishlist', { token: bobToken });
  assert.equal(bobList.body.products.length, 0, 'wishlists are private per customer');

  const missing = await api('POST', '/api/wishlist', { token: aliceToken, json: { product_id: 99999999 } });
  assert.equal(missing.status, 404);

  const rm = await api('DELETE', `/api/wishlist/${ids.alpha}`, { token: aliceToken });
  assert.equal(rm.status, 200);
  const after = await api('GET', '/api/wishlist/ids', { token: aliceToken });
  assert.deepEqual(after.body.ids, []);
});

// ───────────────────────── cart + orders ─────────────────────────

test('cart: variant stock is enforced when changing quantity (bug fix)', async () => {
  const [variants] = await pool.query('SELECT id, size, stock_quantity FROM product_variants WHERE product_id = ? ORDER BY id', [ids.beta]);
  ids.variantM = variants.find(v => v.size === 'M').id;
  ids.variantL = variants.find(v => v.size === 'L').id;

  const add = await api('POST', '/api/cart', { token: aliceToken, json: { product_id: ids.beta, variant_id: ids.variantM, quantity: 1 } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  ids.cartItem = add.body.cart_item_id;

  // product-level stock is 3 but this variant only has 2 → 3 must be refused
  const tooMany = await api('PUT', `/api/cart/${ids.cartItem}`, { token: aliceToken, json: { quantity: 3 } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /Only 2 left/);
  const two = await api('PUT', `/api/cart/${ids.cartItem}`, { token: aliceToken, json: { quantity: 2 } });
  assert.equal(two.status, 200);

  const cart = await api('GET', '/api/cart', { token: aliceToken });
  const line = cart.body.items.find(i => i.id === ids.cartItem);
  assert.equal(Number(line.unit_price), 900, 'variant price adjustment is included');
  assert.equal(cart.body.subtotal, 1800);
});

test('order lifecycle: place → tracking history → my-orders items → cancel restores stock', async () => {
  const order = await placeOrder(aliceToken);
  assert.equal(order.status, 201, JSON.stringify(order.body));
  ids.order = order.body.order.id;
  assert.equal(order.body.order.total_amount, 2050, 'subtotal 1800 + shipping 250 (below the free-shipping threshold)');

  const [[v]] = await pool.query('SELECT stock_quantity FROM product_variants WHERE id = ?', [ids.variantM]);
  assert.equal(v.stock_quantity, 0, 'stock is deducted when the order is placed');

  const mine = await api('GET', '/api/orders/my-orders', { token: aliceToken });
  const mineOrder = mine.body.orders.find(o => o.id === ids.order);
  assert.equal(mineOrder.items.length, 1);
  assert.equal(mineOrder.items[0].variant_size, 'M');
  assert.equal(mineOrder.items[0].quantity, 2);

  const detail = await api('GET', `/api/orders/${ids.order}`, { token: aliceToken });
  assert.equal(detail.body.order.history[0].status, 'pending');

  const byNumber = await api('GET', `/api/orders/${encodeURIComponent(mineOrder.order_number)}`, { token: aliceToken });
  assert.equal(byNumber.status, 200, 'an order can be opened by its order number');
  assert.equal(byNumber.body.order.id, ids.order);

  const stranger = await api('GET', `/api/orders/${ids.order}`, { token: bobToken });
  assert.equal(stranger.status, 403, 'other customers cannot read the order');

  const adminMove = await api('PUT', `/api/admin/orders/${ids.order}/status`, { token: adminToken, json: { status: 'confirmed' } });
  assert.equal(adminMove.status, 200);
  const shipped = await api('PUT', `/api/admin/orders/${ids.order}/status`, { token: adminToken, json: { status: 'shipped' } });
  assert.equal(shipped.status, 200);
  const noCancel = await api('PUT', `/api/orders/${ids.order}/cancel`, { token: aliceToken, json: { reason: 'changed my mind' } });
  assert.equal(noCancel.status, 400, 'a shipped order cannot be cancelled by the customer');

  const detail2 = await api('GET', `/api/orders/${ids.order}`, { token: aliceToken });
  assert.deepEqual(detail2.body.order.history.map(h => h.status), ['pending', 'confirmed', 'shipped']);

  // admin cancels → stock returns; re-opening needs stock available again
  const cancel = await api('PUT', `/api/admin/orders/${ids.order}/status`, { token: adminToken, json: { status: 'cancelled' } });
  assert.equal(cancel.status, 200);
  const [[v2]] = await pool.query('SELECT stock_quantity FROM product_variants WHERE id = ?', [ids.variantM]);
  assert.equal(v2.stock_quantity, 2, 'admin cancellation returns the items to stock');
  const reopen = await api('PUT', `/api/admin/orders/${ids.order}/status`, { token: adminToken, json: { status: 'pending' } });
  assert.equal(reopen.status, 200);
  const [[v3]] = await pool.query('SELECT stock_quantity FROM product_variants WHERE id = ?', [ids.variantM]);
  assert.equal(v3.stock_quantity, 0, 're-opening takes the stock out again');

  const custCancel = await api('PUT', `/api/orders/${ids.order}/cancel`, { token: aliceToken, json: { reason: 'changed my mind' } });
  assert.equal(custCancel.status, 200);
  const [[v4]] = await pool.query('SELECT stock_quantity FROM product_variants WHERE id = ?', [ids.variantM]);
  assert.equal(v4.stock_quantity, 2);
  const twice = await api('PUT', `/api/orders/${ids.order}/cancel`, { token: aliceToken, json: { reason: 'again' } });
  assert.equal(twice.status, 400, 'cancelling twice must not restore stock twice');
  const [[v5]] = await pool.query('SELECT stock_quantity FROM product_variants WHERE id = ?', [ids.variantM]);
  assert.equal(v5.stock_quantity, 2);
});

test('two customers buying the last unit at once: exactly one succeeds, stock never goes negative', async () => {
  const last = await api('POST', '/api/products', { token: adminToken, form: productForm({ category_id: String(ids.child), name: T('Last One'), regular_price: '500', stock_quantity: '1' }) });
  assert.equal(last.status, 201);
  const pid = last.body.productId;
  const a = await api('POST', '/api/cart', { token: aliceToken, json: { product_id: pid, quantity: 1 } });
  const b = await api('POST', '/api/cart', { token: bobToken, json: { product_id: pid, quantity: 1 } });
  assert.equal(a.status, 201); assert.equal(b.status, 201);

  const [ra, rb] = await Promise.all([placeOrder(aliceToken, [a.body.cart_item_id]), placeOrder(bobToken, [b.body.cart_item_id])]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [201, 409], `got ${statuses} — ${JSON.stringify([ra.body, rb.body])}`);
  const [[row]] = await pool.query('SELECT stock_quantity FROM products WHERE id = ?', [pid]);
  assert.equal(row.stock_quantity, 0);
});

test('admin dashboard still works with the new tables in place', async () => {
  const d = await api('GET', '/api/admin/dashboard', { token: adminToken });
  assert.equal(d.status, 200);
  assert.ok('stats' in d.body);
});

// Keep this test LAST: it deliberately uses up the failed-login allowance of this test server.
test('rate limits: successful logins and cached public reads never count; repeated wrong passwords are stopped', async () => {
  for (let i = 0; i < 25; i++) {
    const ok = await api('POST', '/api/auth/login', { json: { email: EMAIL('alice'), password: PASSWORD } });
    assert.equal(ok.status, 200, `successful login #${i + 1} must not be throttled`);
  }
  for (let i = 0; i < 40; i++) {
    const r = await api('GET', '/api/home');
    assert.equal(r.status, 200, 'cached public reads are exempt from the limiter');
  }
  let blockedAt = 0;
  for (let i = 1; i <= 25; i++) {
    const bad = await api('POST', '/api/auth/login', { json: { email: EMAIL('alice'), password: 'definitely-wrong' } });
    if (bad.status === 429) { blockedAt = i; break; }
    assert.equal(bad.status, 401);
  }
  assert.equal(blockedAt, 21, `the 21st wrong password should be blocked (blocked at attempt ${blockedAt})`);
});
