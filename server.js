// ================================================================
// BACKEND — Centro de pedidos "Comanda"
// ----------------------------------------------------------------
// Guarda los pedidos en un archivo JSON en disco (orders.json) y los
// expone por una API REST. El panel de control los consulta cada
// pocos segundos (polling) para enterarse de pedidos nuevos.
//
// MULTI-TENANCY: este backend puede atender a varios comercios a la
// vez. Cada request tiene que identificar la tienda con el header
// "X-Store-Key" (ver stores.json y la función requireStore más abajo).
// Sin esa clave, ningún endpoint de /api/orders responde. Cada pedido
// queda etiquetado con su "store", y todas las lecturas/escrituras se
// filtran por ese campo, así los datos de una tienda nunca se mezclan
// ni son visibles desde otra.
//
// Endpoints (todos requieren header X-Store-Key salvo /api/health):
//   GET    /api/orders            -> lista los pedidos de ESA tienda
//   POST   /api/orders            -> crea un pedido nuevo (lo usa la tienda)
//   PATCH  /api/orders/:id        -> actualiza status / tags / agrega nota
//   DELETE /api/orders/:id        -> borra un pedido puntual
//   DELETE /api/orders/demo       -> borra los pedidos de la demo de ESA tienda
//   POST   /api/orders/clear      -> vacía pedidos por estado, de ESA tienda
//
//   GET    /api/products          -> lista el catálogo de ESA tienda
//   POST   /api/products/seed     -> carga el catálogo inicial (solo si la
//                                     tienda todavía no tiene productos
//                                     guardados; no duplica si se llama de nuevo)
//   POST   /api/products          -> crea un producto nuevo
//   PATCH  /api/products/:id      -> edita cualquier campo del producto
//                                     (precio, oferta, agotado, foto, etc.)
//   DELETE /api/products/:id      -> borra un producto puntual
//
//   GET    /api/health            -> chequeo simple de que el server vive
// ================================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'orders.json');
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const STORES_FILE = path.join(__dirname, 'stores.json');

// ----------------------------------------------------------------
// CORS: en producción, reemplazá el '*' por el/los dominios reales
// de tus tiendas (ej: "https://mi-comercio.com") para que solo esas
// páginas puedan mandar pedidos a este backend.
// ----------------------------------------------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// ----------------------------------------------------------------
// MULTI-TENANCY
// ----------------------------------------------------------------
// Este mismo backend puede atender a varios comercios distintos.
// Para que los pedidos de uno NUNCA se mezclen ni se puedan ver
// desde otro, cada tienda tiene una "clave" secreta (storeKey) que
// el catálogo y el panel mandan en cada request via el header
// "X-Store-Key". Esa clave se mapea a un "storeId" interno, y TODOS
// los datos se guardan/filtran usando ese storeId.
//
// Las claves y sus IDs viven en stores.json (ver ese archivo). Para
// dar de alta un comercio nuevo, agregá una entrada ahí — no hace
// falta tocar este archivo ni la base de pedidos.
//
// Formato de stores.json:
// { "<storeKey>": "<storeId>", "<storeKey>": "<storeId>", ... }
// ----------------------------------------------------------------
function loadStores() {
  if (!fs.existsSync(STORES_FILE)) {
    console.error(
      'ATENCIÓN: no existe stores.json. Ningún request va a poder ' +
      'identificarse y todos los endpoints van a devolver 401. ' +
      'Creá stores.json con al menos una tienda (ver stores.example.json).'
    );
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
  } catch (e) {
    console.error('Error leyendo stores.json:', e);
    return {};
  }
}

// Middleware: identifica qué tienda está haciendo el request a partir
// del header "X-Store-Key" y lo guarda en req.storeId. Si la clave no
// viene o no es válida, corta acá con 401 (así una tienda nunca puede
// listar, editar ni borrar pedidos de otra, ni siquiera adivinando IDs).
function requireStore(req, res, next) {
  const storeKey = req.header('X-Store-Key');
  if (!storeKey) {
    return res.status(401).json({ error: 'Falta el header X-Store-Key.' });
  }
  const stores = loadStores();
  const storeId = stores[storeKey];
  if (!storeId) {
    return res.status(401).json({ error: 'Clave de tienda inválida.' });
  }
  req.storeId = storeId;
  next();
}

// Todos los endpoints de /api/orders* y /api/products* requieren
// identificar la tienda.
app.use('/api/orders', requireStore);
app.use('/api/products', requireStore);

// ----------------------------------------------------------------
// Persistencia muy simple en un archivo JSON.
// Alcanza de sobra para un solo comercio con un panel. Si en el
// futuro necesitás más volumen o varias sucursales, esto se puede
// migrar a una base de datos real (Postgres, SQLite, etc.) sin
// tocar los endpoints de arriba.
// ----------------------------------------------------------------
function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { nextId: 1025, orders: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('Error leyendo orders.json, arranco desde cero:', e);
    return { nextId: 1025, orders: [] };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Evita escrituras simultáneas pisándose entre sí (por si llegan dos
// pedidos casi al mismo tiempo).
let writeQueue = Promise.resolve();
function withDB(mutatorFn) {
  writeQueue = writeQueue.then(() => {
    const db = readDB();
    const result = mutatorFn(db);
    writeDB(db);
    return result;
  });
  return writeQueue;
}

// ----------------------------------------------------------------
// Persistencia de PRODUCTOS (catálogo), en un archivo aparte
// (products.json) pero con la misma lógica que orders.json: cada
// producto queda etiquetado con "store" y todo se filtra por ahí.
// ----------------------------------------------------------------
function readProductsDB() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    return { nextId: 1, products: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  } catch (e) {
    console.error('Error leyendo products.json, arranco desde cero:', e);
    return { nextId: 1, products: [] };
  }
}

function writeProductsDB(db) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(db, null, 2));
}

let productsWriteQueue = Promise.resolve();
function withProductsDB(mutatorFn) {
  productsWriteQueue = productsWriteQueue.then(() => {
    const db = readProductsDB();
    const result = mutatorFn(db);
    writeProductsDB(db);
    return result;
  });
  return productsWriteQueue;
}

function nowHHMM() {
  return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) + 'hs';
}

function randomCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// ----------------------------------------------------------------
// GET /api/orders
// El panel llama esto cada pocos segundos para refrescarse.
// ----------------------------------------------------------------
app.get('/api/orders', (req, res) => {
  const db = readDB();
  res.json(db.orders.filter(o => o.store === req.storeId));
});

// ----------------------------------------------------------------
// POST /api/orders
// La tienda (catálogo) llama esto cuando el cliente aprieta
// "Enviar pedido".
// Body esperado:
// {
//   client: string,
//   phone: string,
//   tags: string[],
//   items: [{name, qty, price}],
//   shipping: number,
//   note: string (opcional)
// }
// ----------------------------------------------------------------
app.post('/api/orders', async (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'El pedido no tiene productos.' });
  }

  const order = await withDB((db) => {
    const newOrder = {
      id: db.nextId,
      store: req.storeId,
      code: randomCode(),
      client: (body.client && String(body.client).trim()) || 'Sin nombre',
      phone: body.phone ? String(body.phone) : '',
      status: 'nuevo',
      tags: Array.isArray(body.tags) ? body.tags : [],
      items: body.items.map(i => ({
        name: String(i.name),
        qty: Number(i.qty) || 1,
        price: Number(i.price) || 0,
      })),
      shipping: Number(body.shipping) || 0,
      payment: body.payment ? String(body.payment) : '',
      address: body.address ? String(body.address) : '',
      time: nowHHMM(),
      createdAt: new Date().toISOString(),
      // "origin: 'client'" identifica la nota que dejó el cliente al hacer
      // el pedido (se usa para el comprobante en PDF). Los comentarios que
      // el panel agrega después via PATCH no llevan este campo, para no
      // mezclarse con anotaciones internas del equipo.
      notes: body.note ? [{ text: String(body.note), time: nowHHMM(), origin: 'client' }] : [],
      // "demo: true" marca los pedidos generados por el Modo Demo del
      // panel (ver comanda-con-panel.html). Viajan por el mismo POST que
      // un pedido real para no duplicar lógica; este flag solo sirve para
      // poder identificarlos y borrarlos en bloque después (ver
      // DELETE /api/orders/demo más abajo). Nunca se muestra al cliente.
      demo: body.demo === true,
    };
    db.orders.unshift(newOrder);
    db.nextId += 1;
    return newOrder;
  });

  res.status(201).json(order);
});

// ----------------------------------------------------------------
// PATCH /api/orders/:id
// El panel llama esto para: cambiar el estado, tocar las etiquetas
// o agregar un comentario interno.
// Body esperado (todos los campos son opcionales, mandá solo el que
// quieras actualizar):
// { status?: string, tags?: string[], note?: string }
// ----------------------------------------------------------------
app.patch('/api/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};

  const updated = await withDB((db) => {
    const order = db.orders.find(o => o.id === id && o.store === req.storeId);
    if (!order) return null;

    if (typeof body.status === 'string') {
      order.status = body.status;
    }
    if (Array.isArray(body.tags)) {
      order.tags = body.tags;
    }
    if (typeof body.note === 'string' && body.note.trim()) {
      order.notes.push({ text: body.note.trim(), time: nowHHMM() });
    }
    return order;
  });

  if (!updated) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json(updated);
});

// ----------------------------------------------------------------
// DELETE /api/orders/demo
// Borra únicamente los pedidos generados por el Modo Demo del panel
// (los que tienen demo:true), sin tocar los pedidos reales. Lo usa el
// botón "Reiniciar datos de la demo".
// IMPORTANTE: esta ruta tiene que estar declarada ANTES que
// DELETE /api/orders/:id, si no Express interpretaría "demo" como un
// :id y nunca llegaría acá.
// ----------------------------------------------------------------
app.delete('/api/orders/demo', async (req, res) => {
  const deleted = await withDB((db) => {
    const before = db.orders.length;
    db.orders = db.orders.filter(o => !(o.demo && o.store === req.storeId));
    return before - db.orders.length;
  });

  res.json({ ok: true, deleted });
});

// ----------------------------------------------------------------
// DELETE /api/orders/:id
// Elimina un pedido puntual (lo usa el botón "Eliminar" del panel).
// ----------------------------------------------------------------
app.delete('/api/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const existed = await withDB((db) => {
    const before = db.orders.length;
    db.orders = db.orders.filter(o => !(o.id === id && o.store === req.storeId));
    return db.orders.length !== before;
  });

  if (!existed) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ ok: true });
});

// ----------------------------------------------------------------
// POST /api/orders/clear
// Borra en lote todos los pedidos que estén en alguno de los
// estados indicados (pensado para "Vaciar completados y
// cancelados" y así no dejar que el panel se llene de pedidos
// viejos). Body esperado: { statuses: ["completado","cancelado"] }
// ----------------------------------------------------------------
app.post('/api/orders/clear', async (req, res) => {
  const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses : [];
  if (statuses.length === 0) {
    return res.status(400).json({ error: 'Falta indicar qué estados vaciar.' });
  }

  const deleted = await withDB((db) => {
    const before = db.orders.length;
    db.orders = db.orders.filter(o => !(o.store === req.storeId && statuses.includes(o.status)));
    return before - db.orders.length;
  });

  res.json({ ok: true, deleted });
});

// ================================================================
// PRODUCTOS (catálogo)
// ================================================================

// ----------------------------------------------------------------
// GET /api/products
// El panel (y el catálogo) lo llama al cargar la página para traer
// el catálogo guardado de ESA tienda.
// ----------------------------------------------------------------
app.get('/api/products', (req, res) => {
  const db = readProductsDB();
  res.json(db.products.filter(p => p.store === req.storeId));
});

// ----------------------------------------------------------------
// POST /api/products/seed
// Carga el catálogo inicial (el que viene escrito en el HTML) la
// PRIMERA vez que una tienda entra al panel. Si esa tienda ya tiene
// productos guardados, no hace nada y devuelve los que ya existen
// — así se puede llamar sin miedo cada vez que carga la página, sin
// riesgo de duplicar productos.
// Body esperado: { products: [ {cat, name, price, ...}, ... ] }
// ----------------------------------------------------------------
app.post('/api/products/seed', async (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.products) ? body.products : [];

  const result = await withProductsDB((db) => {
    const existing = db.products.filter(p => p.store === req.storeId);
    if (existing.length > 0) {
      return { seeded: false, products: existing };
    }
    const created = incoming.map((p) => {
      const { id, store, ...rest } = p || {}; // ignoramos id/store que mande el cliente
      const newP = { id: db.nextId, store: req.storeId, ...rest };
      db.nextId += 1;
      db.products.push(newP);
      return newP;
    });
    return { seeded: true, products: created };
  });

  res.json(result);
});

// ----------------------------------------------------------------
// POST /api/products
// Crea un producto nuevo (lo usa el botón "Agregar producto" del panel).
// Body esperado: { cat, name, price, offerPrice?, outOfStock?, img?, ... }
// ----------------------------------------------------------------
app.post('/api/products', async (req, res) => {
  const body = req.body || {};
  if (!body.name || typeof body.price === 'undefined') {
    return res.status(400).json({ error: 'Falta nombre o precio del producto.' });
  }

  const { id, store, ...rest } = body; // ignoramos id/store que mande el cliente

  const created = await withProductsDB((db) => {
    const newP = { id: db.nextId, store: req.storeId, ...rest };
    db.nextId += 1;
    db.products.push(newP);
    return newP;
  });

  res.status(201).json(created);
});

// ----------------------------------------------------------------
// PATCH /api/products/:id
// Edita cualquier campo del producto (precio, oferta, agotado, foto,
// nombre, categoría, etc.). Mandá solo los campos que querés cambiar.
// Para BORRAR un campo (ej: sacar la oferta o la foto), mandalo en
// null: { "offerPrice": null } elimina offerPrice del producto.
// ----------------------------------------------------------------
app.patch('/api/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};

  const updated = await withProductsDB((db) => {
    const p = db.products.find(x => x.id === id && x.store === req.storeId);
    if (!p) return null;
    Object.keys(body).forEach((key) => {
      if (key === 'id' || key === 'store') return; // no se pueden pisar
      if (body[key] === null) {
        delete p[key];
      } else {
        p[key] = body[key];
      }
    });
    return p;
  });

  if (!updated) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(updated);
});

// ----------------------------------------------------------------
// DELETE /api/products/:id
// Elimina un producto puntual (lo usa el botón "Eliminar" del panel).
// ----------------------------------------------------------------
app.delete('/api/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const existed = await withProductsDB((db) => {
    const before = db.products.length;
    db.products = db.products.filter(p => !(p.id === id && p.store === req.storeId));
    return db.products.length !== before;
  });

  if (!existed) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend de pedidos corriendo en el puerto ${PORT}`);
});

