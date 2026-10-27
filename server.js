// ================================================================
// BACKEND — "Comanda" (pedidos + catálogo) con Supabase
// ----------------------------------------------------------------
// DOS NIVELES DE ACCESO (por tienda, ver stores.json):
//
//  1) CLAVE PÚBLICA (header X-Store-Key) — va dentro de index.html.
//     Solo permite:
//       GET  /api/products   leer el catálogo
//       GET  /api/settings   leer nombre, WhatsApp y alias (solo esos)
//       POST /api/orders     crear un pedido. El servidor ignora los
//                            precios que mande el navegador y usa los
//                            de la base de datos.
//
//  2) ADMIN (X-Store-Key + "Authorization: Bearer <token>") — el token
//     se obtiene con POST /api/admin/login {password}. La contraseña
//     nunca está en ningún HTML ni en el repo (solo su hash en
//     stores.json). Todo lo demás exige este token:
//       GET/PATCH/DELETE /api/orders..., POST /api/orders/demo|clear,
//       POST/PATCH/DELETE /api/products..., POST /api/products/seed,
//       POST /api/products/:id/image, PATCH /api/settings
//
// Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ALLOWED_ORIGIN (dominios de la tienda y del admin, separados por
// coma), SESSION_SECRET (opcional pero recomendada).
// ================================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1); // Render va detrás de un proxy: así req.ip es la IP real
const PORT = process.env.PORT || 3000;
const STORES_FILE = path.join(__dirname, 'stores.json');

// ---------------- CORS ----------------
// ALLOWED_ORIGIN="https://tienda.com,https://admin.tienda.com"
const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
if (allowed.includes('*')) {
  console.warn('ATENCIÓN: ALLOWED_ORIGIN no está configurado, el CORS queda abierto (*). Poné los dominios reales en Render.');
}
app.use(cors({
  origin: allowed.includes('*') ? '*' : (origin, cb) => cb(null, !origin || allowed.includes(origin)),
}));
app.use(express.json({ limit: '5mb' }));

// ---------------- Supabase ----------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ATENCIÓN: faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY.');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRODUCT_IMAGES_BUCKET = 'product-images';
(async function ensureBucket() {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) return console.error('No se pudieron listar los buckets:', error);
    if ((buckets || []).some(b => b.name === PRODUCT_IMAGES_BUCKET)) return;
    const { error: e2 } = await supabase.storage.createBucket(PRODUCT_IMAGES_BUCKET, { public: true });
    if (e2) console.error('No se pudo crear el bucket product-images (crealo a mano, público):', e2);
  } catch (e) { console.error('Error con el bucket de imágenes:', e); }
})();

// ---------------- Tiendas y claves ----------------
// stores.json: { "<storeId>": { "publicKey": "...", "adminPasswordHash": "scrypt$salt$hash" } }
function loadStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, 'utf8')); }
  catch (e) { console.error('Error leyendo stores.json:', e.message); return {}; }
}
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return safeEqual(test, hash);
}

// Identifica la tienda por la clave pública.
function requireStore(req, res, next) {
  const key = req.header('X-Store-Key');
  if (!key) return res.status(401).json({ error: 'Falta el header X-Store-Key.' });
  const stores = loadStores();
  const storeId = Object.keys(stores).find(id => stores[id].publicKey && safeEqual(stores[id].publicKey, key));
  if (!storeId) return res.status(401).json({ error: 'Clave de tienda inválida.' });
  req.storeId = storeId;
  req.storeCfg = stores[storeId];
  next();
}

// ---------------- Sesión de admin (token firmado, 12 hs) ----------------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256')
  .update('comanda-session|' + (process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev')).digest('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sign = (payload) => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

function issueToken(storeId) {
  const payload = Buffer.from(JSON.stringify({ s: storeId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function requireAdmin(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.header('Authorization') || '');
  if (m) {
    const [payload, sig] = m[1].split('.');
    if (payload && sig && safeEqual(sig, sign(payload))) {
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (data.s === req.storeId && data.exp > Date.now()) return next();
      } catch (e) { /* cae al 401 */ }
    }
  }
  res.status(401).json({ error: 'Sesión de administrador inválida o vencida.' });
}

// ---------------- Límites simples por IP (en memoria) ----------------
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(k) {
      const now = Date.now();
      const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
      hits.set(k, arr);
      return arr.length >= max;
    },
    hit(k) { const a = hits.get(k) || []; a.push(Date.now()); hits.set(k, a); },
    clear(k) { hits.delete(k); },
  };
}
const loginLimiter = makeLimiter(8, 15 * 60 * 1000);  // 8 intentos fallidos cada 15 min
const orderLimiter = makeLimiter(15, 10 * 60 * 1000); // 15 pedidos cada 10 min por IP

// ---------------- Helpers ----------------
const row2obj = (row) => ({ id: row.id, store: row.store, ...row.data });
const nowHHMM = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) + 'hs';
const randomCode = () => crypto.randomBytes(6).toString('hex').slice(0, 8).toUpperCase();
// Texto de usuario: sin caracteres de control ni de marcado HTML, con largo máximo.
const clean = (v, max) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '”').replace(/`/g, '´')
  .trim().slice(0, max);
const dbError = (res, msg, err) => { console.error(msg, err); return res.status(500).json({ error: msg }); };

// ================================================================
// RUTAS PÚBLICAS (clave pública)
// ================================================================
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', requireStore);

// Supabase corta cada consulta en 1000 filas. Para no perder productos
// (los últimos cargados quedaban afuera), se leen por páginas hasta
// traerlos todos.
async function fetchAllRows(table, storeId, ascending) {
  const PAGE = 1000;
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('id, store, data')
      .eq('store', storeId).order('id', { ascending })
      .range(from, from + PAGE - 1);
    if (error) return { error };
    all = all.concat(data);
    if (data.length < PAGE) break;
  }
  return { data: all };
}

app.get('/api/products', async (req, res) => {
  const { data, error } = await fetchAllRows('products', req.storeId, true);
  if (error) return dbError(res, 'No se pudieron leer los productos.', error);
  res.json(data.map(row2obj));
});

const PUBLIC_SETTINGS = ['storeName', 'whatsapp', 'alias', 'categories'];
app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('data').eq('store', req.storeId).maybeSingle();
  if (error) return dbError(res, 'No se pudieron leer los datos del negocio.', error);
  const all = (data && data.data) || {};
  const out = {};
  PUBLIC_SETTINGS.forEach(k => { if (all[k] !== undefined) out[k] = all[k]; });
  res.json(out);
});

// Crear pedido (lo usa la tienda). Body: { client, phone, delivery, payment,
// address?, note?, items: [{ id, qty }] }. Nombre y precio salen de la base.
app.post('/api/orders', async (req, res) => {
  if (orderLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Demasiados pedidos seguidos. Probá en unos minutos.' });
  const body = req.body || {};

  const wanted = new Map(); // id -> qty
  (Array.isArray(body.items) ? body.items : []).slice(0, 100).forEach(i => {
    const id = parseInt(i && i.id, 10);
    const qty = Math.min(999, Math.max(1, parseInt(i && i.qty, 10) || 0));
    if (Number.isInteger(id) && qty > 0) wanted.set(id, (wanted.get(id) || 0) + qty);
  });
  if (wanted.size === 0) return res.status(400).json({ error: 'El pedido no tiene productos.' });

  const client = clean(body.client, 80);
  const phone = clean(body.phone, 30);
  if (!client || !phone) return res.status(400).json({ error: 'Faltan el nombre o el teléfono.' });
  const delivery = body.delivery === 'delivery' ? 'delivery' : 'retira';
  const payment = ['efectivo', 'transferencia'].includes(body.payment) ? body.payment : '';
  const address = delivery === 'delivery' ? clean(body.address, 160) : '';
  if (delivery === 'delivery' && !address) return res.status(400).json({ error: 'Falta la dirección de entrega.' });

  const { data: prods, error: pErr } = await supabase.from('products').select('id, data')
    .eq('store', req.storeId).in('id', [...wanted.keys()]);
  if (pErr) return dbError(res, 'No se pudo validar el pedido.', pErr);

  const byId = new Map(prods.map(p => [p.id, p.data || {}]));
  const items = [];
  for (const [id, qty] of wanted) {
    const p = byId.get(id);
    if (!p) return res.status(400).json({ error: 'Un producto del pedido ya no existe. Actualizá la página.' });
    if (p.outOfStock) return res.status(400).json({ error: `"${p.name}" está agotado.` });
    const price = Number(p.offerPrice) || Number(p.price) || 0;
    items.push({ name: String(p.name), qty, price });
  }

  const orderData = {
    code: randomCode(),
    client, phone,
    status: 'nuevo',
    tags: [delivery === 'delivery' ? 'Envío' : 'Retira'],
    items,
    shipping: 0,
    payment, address,
    time: nowHHMM(),
    createdAt: new Date().toISOString(),
    notes: body.note ? [{ text: clean(body.note, 400), time: nowHHMM(), origin: 'client' }] : [],
    demo: false,
  };

  const { data, error } = await supabase.from('orders').insert({ store: req.storeId, data: orderData })
    .select('id, store, data').single();
  if (error) return dbError(res, 'No se pudo guardar el pedido.', error);
  orderLimiter.hit(req.ip);
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  res.status(201).json({ id: data.id, code: orderData.code, total });
});

// ================================================================
// ADMIN
// ================================================================
// El hash vigente es el que el dueño guardó al cambiar su contraseña (tabla settings);
// si nunca la cambió, vale el de stores.json (la contraseña temporal).
async function getAdminHash(storeId, cfg) {
  try {
    const { data } = await supabase.from('settings').select('data').eq('store', storeId).maybeSingle();
    if (data && data.data && data.data.adminPasswordHash) return data.data.adminPasswordHash;
  } catch (e) { console.error('No se pudo leer el hash de la base, se usa stores.json:', e.message); }
  return cfg.adminPasswordHash;
}
const hashPassword = (pwd) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pwd), salt, 64).toString('hex')}`;
};

app.post('/api/admin/login', async (req, res) => {
  const k = `${req.ip}|${req.storeId}`;
  if (loginLimiter.blocked(k)) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  const hash = await getAdminHash(req.storeId, req.storeCfg);
  if (!verifyPassword((req.body || {}).password || '', hash)) { loginLimiter.hit(k); return res.status(401).json({ error: 'Contraseña incorrecta.' }); }
  loginLimiter.clear(k);
  res.json({ token: issueToken(req.storeId), expiresInMs: SESSION_TTL_MS });
});

// Cambiar la contraseña (la elige el dueño; nadie más la ve).
app.post('/api/admin/password', requireAdmin, async (req, res) => {
  const k = `pwd|${req.ip}|${req.storeId}`;
  if (loginLimiter.blocked(k)) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  const { current, next } = req.body || {};
  if (typeof next !== 'string' || next.length < 10 || next.length > 200) {
    return res.status(400).json({ error: 'La contraseña nueva tiene que tener al menos 10 caracteres.' });
  }
  const hash = await getAdminHash(req.storeId, req.storeCfg);
  if (!verifyPassword(current || '', hash)) { loginLimiter.hit(k); return res.status(401).json({ error: 'La contraseña actual no es correcta.' }); }
  const { data: existing, error: fErr } = await supabase.from('settings').select('data').eq('store', req.storeId).maybeSingle();
  if (fErr) return dbError(res, 'No se pudo cambiar la contraseña.', fErr);
  const merged = { ...((existing && existing.data) || {}), adminPasswordHash: hashPassword(next) };
  const { error: uErr } = await supabase.from('settings')
    .upsert({ store: req.storeId, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'store' });
  if (uErr) return dbError(res, 'No se pudo cambiar la contraseña.', uErr);
  loginLimiter.clear(k);
  res.json({ ok: true });
});

// Todo lo que sigue exige sesión de admin (middleware requireAdmin).

// ---- Pedidos ----
app.get('/api/orders', requireAdmin, async (req, res) => {
  const { data, error } = await fetchAllRows('orders', req.storeId, false);
  if (error) return dbError(res, 'No se pudieron leer los pedidos.', error);
  res.json(data.map(row2obj));
});

// Pedido simulado del Modo Demo (el único caso en que el nombre/precio vienen del panel).
app.post('/api/orders/demo', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: 'El pedido no tiene productos.' });
  const orderData = {
    code: randomCode(),
    client: clean(b.client, 80) || 'Sin nombre',
    phone: clean(b.phone, 30),
    status: 'nuevo',
    tags: Array.isArray(b.tags) ? b.tags.filter(t => ['Envío', 'Retira', 'Urgente'].includes(t)) : [],
    items: b.items.slice(0, 100).map(i => ({ name: clean(i.name, 120), qty: Number(i.qty) || 1, price: Number(i.price) || 0 })),
    shipping: Number(b.shipping) || 0,
    payment: clean(b.payment, 20),
    address: clean(b.address, 160),
    time: nowHHMM(),
    createdAt: new Date().toISOString(),
    notes: b.note ? [{ text: clean(b.note, 400), time: nowHHMM(), origin: 'client' }] : [],
    demo: true,
  };
  const { data, error } = await supabase.from('orders').insert({ store: req.storeId, data: orderData })
    .select('id, store, data').single();
  if (error) return dbError(res, 'No se pudo guardar el pedido demo.', error);
  res.status(201).json(row2obj(data));
});

app.patch('/api/orders/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const { data: existing, error: fErr } = await supabase.from('orders').select('id, store, data')
    .eq('id', id).eq('store', req.storeId).maybeSingle();
  if (fErr) return dbError(res, 'No se pudo buscar el pedido.', fErr);
  if (!existing) return res.status(404).json({ error: 'Pedido no encontrado.' });

  const d = { ...existing.data };
  if (typeof body.status === 'string' && ['nuevo', 'progreso', 'completado', 'cancelado'].includes(body.status)) d.status = body.status;
  if (Array.isArray(body.tags)) d.tags = body.tags.map(t => clean(t, 30)).filter(Boolean).slice(0, 10);
  if (typeof body.note === 'string' && body.note.trim()) d.notes = [...(d.notes || []), { text: clean(body.note, 400), time: nowHHMM() }];

  const { data: updated, error: uErr } = await supabase.from('orders').update({ data: d })
    .eq('id', id).eq('store', req.storeId).select('id, store, data').single();
  if (uErr) return dbError(res, 'No se pudo actualizar el pedido.', uErr);
  res.json(row2obj(updated));
});

// IMPORTANTE: /demo va antes que /:id
app.delete('/api/orders/demo', requireAdmin, async (req, res) => {
  const { data: rows, error } = await supabase.from('orders').select('id, data').eq('store', req.storeId);
  if (error) return dbError(res, 'No se pudieron buscar los pedidos demo.', error);
  const ids = rows.filter(r => r.data && r.data.demo).map(r => r.id);
  if (!ids.length) return res.json({ ok: true, deleted: 0 });
  const { error: dErr } = await supabase.from('orders').delete().in('id', ids).eq('store', req.storeId);
  if (dErr) return dbError(res, 'No se pudieron borrar los pedidos demo.', dErr);
  res.json({ ok: true, deleted: ids.length });
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: deleted, error } = await supabase.from('orders').delete()
    .eq('id', id).eq('store', req.storeId).select('id');
  if (error) return dbError(res, 'No se pudo borrar el pedido.', error);
  if (!deleted || !deleted.length) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ ok: true });
});

app.post('/api/orders/clear', requireAdmin, async (req, res) => {
  const statuses = Array.isArray(req.body && req.body.statuses) ? req.body.statuses : [];
  if (!statuses.length) return res.status(400).json({ error: 'Falta indicar qué estados vaciar.' });
  const { data: rows, error } = await supabase.from('orders').select('id, data').eq('store', req.storeId);
  if (error) return dbError(res, 'No se pudieron buscar los pedidos.', error);
  const ids = rows.filter(r => statuses.includes(r.data && r.data.status)).map(r => r.id);
  if (!ids.length) return res.json({ ok: true, deleted: 0 });
  const { error: dErr } = await supabase.from('orders').delete().in('id', ids).eq('store', req.storeId);
  if (dErr) return dbError(res, 'No se pudieron vaciar los pedidos.', dErr);
  res.json({ ok: true, deleted: ids.length });
});

// ---- Productos ----
app.post('/api/products/seed', requireAdmin, async (req, res) => {
  const incoming = Array.isArray(req.body && req.body.products) ? req.body.products : [];
  const { data: existing, error } = await supabase.from('products').select('id, store, data').eq('store', req.storeId);
  if (error) return dbError(res, 'No se pudo chequear el catálogo.', error);
  if (existing.length > 0) return res.json({ seeded: false, products: existing.map(row2obj) });
  const rows = incoming.map(p => { const { id, store, ...rest } = p || {}; return { store: req.storeId, data: rest }; });
  if (!rows.length) return res.json({ seeded: true, products: [] });
  const { data: created, error: iErr } = await supabase.from('products').insert(rows).select('id, store, data');
  if (iErr) return dbError(res, 'No se pudo guardar el catálogo inicial.', iErr);
  res.json({ seeded: true, products: created.map(row2obj) });
});

app.post('/api/products', requireAdmin, async (req, res) => {
  const body = req.body || {};
  if (!body.name || typeof body.price === 'undefined') return res.status(400).json({ error: 'Falta nombre o precio del producto.' });
  const { id, store, ...rest } = body;
  const { data: created, error } = await supabase.from('products').insert({ store: req.storeId, data: rest })
    .select('id, store, data').single();
  if (error) return dbError(res, 'No se pudo guardar el producto.', error);
  res.status(201).json(row2obj(created));
});

// Mandar un campo en null lo elimina del producto.
app.patch('/api/products/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const { data: existing, error: fErr } = await supabase.from('products').select('id, store, data')
    .eq('id', id).eq('store', req.storeId).maybeSingle();
  if (fErr) return dbError(res, 'No se pudo buscar el producto.', fErr);
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado.' });
  const d = { ...existing.data };
  Object.keys(body).forEach(k => {
    if (k === 'id' || k === 'store') return;
    if (body[k] === null) delete d[k]; else d[k] = body[k];
  });
  const { data: updated, error: uErr } = await supabase.from('products').update({ data: d })
    .eq('id', id).eq('store', req.storeId).select('id, store, data').single();
  if (uErr) return dbError(res, 'No se pudo actualizar el producto.', uErr);
  res.json(row2obj(updated));
});

app.post('/api/products/:id/image', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { dataUrl } = req.body || {};
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Falta o es inválida la imagen (jpeg, png, webp o gif).' });
  const mime = m[1];
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'La imagen pesa más de 3 MB.' });

  const { data: existing, error: fErr } = await supabase.from('products').select('id, store, data')
    .eq('id', id).eq('store', req.storeId).maybeSingle();
  if (fErr) return dbError(res, 'No se pudo buscar el producto.', fErr);
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado.' });

  const filePath = `${req.storeId}/${id}-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from(PRODUCT_IMAGES_BUCKET)
    .upload(filePath, buffer, { contentType: mime, upsert: true });
  if (upErr) return dbError(res, 'No se pudo subir la imagen.', upErr);
  const { data: pub } = supabase.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(filePath);

  const { data: updated, error: uErr } = await supabase.from('products')
    .update({ data: { ...existing.data, img: pub.publicUrl } })
    .eq('id', id).eq('store', req.storeId).select('id, store, data').single();
  if (uErr) return dbError(res, 'No se pudo actualizar el producto con la nueva foto.', uErr);
  res.json(row2obj(updated));
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: deleted, error } = await supabase.from('products').delete()
    .eq('id', id).eq('store', req.storeId).select('id');
  if (error) return dbError(res, 'No se pudo borrar el producto.', error);
  if (!deleted || !deleted.length) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json({ ok: true });
});

// ---- Datos del negocio ----
app.patch('/api/settings', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const { data: existing, error: fErr } = await supabase.from('settings').select('data').eq('store', req.storeId).maybeSingle();
  if (fErr) return dbError(res, 'No se pudieron leer los datos del negocio.', fErr);
  const merged = { ...((existing && existing.data) || {}), ...body };
  delete merged.store;
  if (existing && existing.data && existing.data.adminPasswordHash) merged.adminPasswordHash = existing.data.adminPasswordHash;
  else delete merged.adminPasswordHash;
  const { data: up, error: uErr } = await supabase.from('settings')
    .upsert({ store: req.storeId, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'store' })
    .select('data').single();
  if (uErr) return dbError(res, 'No se pudieron guardar los datos del negocio.', uErr);
  const { adminPasswordHash, ...safe } = up.data;
  res.json(safe);
});

app.listen(PORT, () => console.log(`Backend de pedidos corriendo en el puerto ${PORT}`));

