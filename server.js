// ================================================================
// BACKEND — Centro de pedidos "Comanda"
// ----------------------------------------------------------------
// Guarda los pedidos y el catálogo en Supabase (Postgres) y los
// expone por una API REST. El panel de control los consulta cada
// pocos segundos (polling) para enterarse de pedidos nuevos.
//
// POR QUÉ SUPABASE Y NO ARCHIVOS JSON EN DISCO:
// Este backend corre en un plan gratuito de Render, que tiene el
// filesystem efímero: cualquier archivo que el server escriba en
// disco (como antes orders.json / products.json) se BORRA cada vez
// que el servicio se reinicia — y eso pasa solo, cada vez que Render
// "duerme" el servicio por inactividad y luego lo despierta. Guardar
// los datos en Supabase en vez de en disco evita ese problema: los
// datos viven en la base, no en el contenedor.
//
// MULTI-TENANCY: este backend puede atender a varios comercios a la
// vez. Cada request tiene que identificar la tienda con el header
// "X-Store-Key" (ver stores.json y la función requireStore más abajo).
// Sin esa clave, ningún endpoint de /api/orders ni /api/products
// responde. Cada fila queda etiquetada con su "store" (columna
// "store"), y todas las lecturas/escrituras se filtran por esa
// columna, así los datos de una tienda nunca se mezclan ni son
// visibles desde otra.
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
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const STORES_FILE = path.join(__dirname, 'stores.json');

// ----------------------------------------------------------------
// CORS: en producción, reemplazá el '*' por el/los dominios reales
// de tus tiendas (ej: "https://mi-comercio.com") para que solo esas
// páginas puedan mandar pedidos a este backend.
// ----------------------------------------------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '5mb' })); // límite más alto: los productos pueden traer fotos en base64

// ----------------------------------------------------------------
// CONEXIÓN A SUPABASE
// ----------------------------------------------------------------
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY salen del panel de tu
// proyecto en Supabase (Project Settings -> API) y se configuran
// como variables de entorno en Render (nunca hardcodeadas acá).
// Usamos la "service role key" (no la "anon key") porque este
// backend es el único que habla con la base, y él mismo ya se ocupa
// de separar los datos por tienda con requireStore/X-Store-Key.
// ----------------------------------------------------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'ATENCIÓN: faltan las variables de entorno SUPABASE_URL y/o ' +
    'SUPABASE_SERVICE_ROLE_KEY. El backend no va a poder leer ni ' +
    'guardar pedidos ni productos. Configuralas en Render (Environment).'
  );
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ----------------------------------------------------------------
// MULTI-TENANCY
// ----------------------------------------------------------------
// stores.json sigue viviendo como archivo (no en Supabase): es un
// archivo chico que se sube junto con el código (parte del repo), no
// algo que el server escriba en tiempo de ejecución, así que el
// filesystem efímero de Render no lo afecta. Para dar de alta un
// comercio nuevo, agregá una entrada ahí y volvé a desplegar.
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
// Persistencia en Supabase.
// ----------------------------------------------------------------
// Tanto "orders" como "products" viven en Supabase con la misma
// forma de tabla: una columna "id" (autonumérica, la genera Postgres
// solo), una columna "store" (a qué tienda pertenece la fila) y una
// columna "data" (jsonb) con TODO el resto de la información del
// pedido/producto (client, items, tags, notes, cat, price, img...).
//
// Guardar el resto de los campos como jsonb (en vez de una columna
// por campo) es justamente lo que nos permite no tener que rediseñar
// una tabla cada vez que se agrega un campo nuevo al pedido o al
// producto — es el mismo comportamiento flexible que tenían los
// objetos sueltos en orders.json / products.json, pero ahora
// persistido en una base de verdad.
//
// row2obj junta "id" + "store" + lo de adentro de "data" en un solo
// objeto plano, que es la forma en la que el panel y el catálogo ya
// esperan recibir los pedidos/productos (igual que antes).
// ----------------------------------------------------------------
function row2obj(row) {
  return { id: row.id, store: row.store, ...row.data };
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
app.get('/api/orders', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, store, data')
    .eq('store', req.storeId)
    .order('id', { ascending: false }); // más nuevo primero, igual que antes (unshift)

  if (error) {
    console.error('Error leyendo pedidos de Supabase:', error);
    return res.status(500).json({ error: 'No se pudieron leer los pedidos.' });
  }
  res.json(data.map(row2obj));
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

  const orderData = {
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

  const { data, error } = await supabase
    .from('orders')
    .insert({ store: req.storeId, data: orderData })
    .select('id, store, data')
    .single();

  if (error) {
    console.error('Error creando pedido en Supabase:', error);
    return res.status(500).json({ error: 'No se pudo guardar el pedido.' });
  }
  res.status(201).json(row2obj(data));
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

  const { data: existing, error: fetchError } = await supabase
    .from('orders')
    .select('id, store, data')
    .eq('id', id)
    .eq('store', req.storeId)
    .maybeSingle();

  if (fetchError) {
    console.error('Error buscando pedido en Supabase:', fetchError);
    return res.status(500).json({ error: 'No se pudo buscar el pedido.' });
  }
  if (!existing) return res.status(404).json({ error: 'Pedido no encontrado.' });

  const orderData = { ...existing.data };
  if (typeof body.status === 'string') {
    orderData.status = body.status;
  }
  if (Array.isArray(body.tags)) {
    orderData.tags = body.tags;
  }
  if (typeof body.note === 'string' && body.note.trim()) {
    orderData.notes = [...(orderData.notes || []), { text: body.note.trim(), time: nowHHMM() }];
  }

  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update({ data: orderData })
    .eq('id', id)
    .eq('store', req.storeId)
    .select('id, store, data')
    .single();

  if (updateError) {
    console.error('Error actualizando pedido en Supabase:', updateError);
    return res.status(500).json({ error: 'No se pudo actualizar el pedido.' });
  }
  res.json(row2obj(updated));
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
  const { data: rows, error: fetchError } = await supabase
    .from('orders')
    .select('id, data')
    .eq('store', req.storeId);

  if (fetchError) {
    console.error('Error buscando pedidos demo en Supabase:', fetchError);
    return res.status(500).json({ error: 'No se pudieron buscar los pedidos demo.' });
  }

  const idsToDelete = rows.filter(r => r.data && r.data.demo).map(r => r.id);
  if (idsToDelete.length === 0) return res.json({ ok: true, deleted: 0 });

  const { error: deleteError } = await supabase
    .from('orders')
    .delete()
    .in('id', idsToDelete)
    .eq('store', req.storeId);

  if (deleteError) {
    console.error('Error borrando pedidos demo en Supabase:', deleteError);
    return res.status(500).json({ error: 'No se pudieron borrar los pedidos demo.' });
  }
  res.json({ ok: true, deleted: idsToDelete.length });
});

// ----------------------------------------------------------------
// DELETE /api/orders/:id
// Elimina un pedido puntual (lo usa el botón "Eliminar" del panel).
// ----------------------------------------------------------------
app.delete('/api/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const { data: deleted, error } = await supabase
    .from('orders')
    .delete()
    .eq('id', id)
    .eq('store', req.storeId)
    .select('id');

  if (error) {
    console.error('Error borrando pedido en Supabase:', error);
    return res.status(500).json({ error: 'No se pudo borrar el pedido.' });
  }
  if (!deleted || deleted.length === 0) return res.status(404).json({ error: 'Pedido no encontrado.' });
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

  const { data: rows, error: fetchError } = await supabase
    .from('orders')
    .select('id, data')
    .eq('store', req.storeId);

  if (fetchError) {
    console.error('Error buscando pedidos a vaciar en Supabase:', fetchError);
    return res.status(500).json({ error: 'No se pudieron buscar los pedidos.' });
  }

  const idsToDelete = rows.filter(r => statuses.includes(r.data && r.data.status)).map(r => r.id);
  if (idsToDelete.length === 0) return res.json({ ok: true, deleted: 0 });

  const { error: deleteError } = await supabase
    .from('orders')
    .delete()
    .in('id', idsToDelete)
    .eq('store', req.storeId);

  if (deleteError) {
    console.error('Error vaciando pedidos en Supabase:', deleteError);
    return res.status(500).json({ error: 'No se pudieron vaciar los pedidos.' });
  }
  res.json({ ok: true, deleted: idsToDelete.length });
});

// ================================================================
// PRODUCTOS (catálogo)
// ================================================================

// ----------------------------------------------------------------
// GET /api/products
// El panel (y el catálogo) lo llama al cargar la página para traer
// el catálogo guardado de ESA tienda.
// ----------------------------------------------------------------
app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('id, store, data')
    .eq('store', req.storeId)
    .order('id', { ascending: true });

  if (error) {
    console.error('Error leyendo productos de Supabase:', error);
    return res.status(500).json({ error: 'No se pudieron leer los productos.' });
  }
  res.json(data.map(row2obj));
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

  const { data: existing, error: fetchError } = await supabase
    .from('products')
    .select('id, store, data')
    .eq('store', req.storeId);

  if (fetchError) {
    console.error('Error chequeando catálogo existente en Supabase:', fetchError);
    return res.status(500).json({ error: 'No se pudo chequear el catálogo.' });
  }

  if (existing.length > 0) {
    return res.json({ seeded: false, products: existing.map(row2obj) });
  }

  const rowsToInsert = incoming.map((p) => {
    const { id, store, ...rest } = p || {}; // ignoramos id/store que mande el cliente
    return { store: req.storeId, data: rest };
  });

  if (rowsToInsert.length === 0) {
    return res.json({ seeded: true, products: [] });
  }

  const { data: created, error: insertError } = await supabase
    .from('products')
    .insert(rowsToInsert)
    .select('id, store, data');

  if (insertError) {
    console.error('Error sembrando catálogo en Supabase:', insertError);
    return res.status(500).json({ error: 'No se pudo guardar el catálogo inicial.' });
  }
  res.json({ seeded: true, products: created.map(row2obj) });
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

  const { data: created, error } = await supabase
    .from('products')
    .insert({ store: req.storeId, data: rest })
    .select('id, store, data')
    .single();

  if (error) {
    console.error('Error creando producto en Supabase:', error);
    return res.status(500).json({ error: 'No se pudo guardar el producto.' });
  }
  res.status(201).json(row2obj(created));
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

  const { data: existing, error: fetchError } = await supabase
    .from('products')
    .select('id, store, data')
    .eq('id', id)
    .eq('store', req.storeId)
    .maybeSingle();

  if (fetchError) {
    console.error('Error buscando producto en Supabase:', fetchError);
    return res.status(500).json({ error: 'No se pudo buscar el producto.' });
  }
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado.' });

  const productData = { ...existing.data };
  Object.keys(body).forEach((key) => {
    if (key === 'id' || key === 'store') return; // no se pueden pisar
    if (body[key] === null) {
      delete productData[key];
    } else {
      productData[key] = body[key];
    }
  });

  const { data: updated, error: updateError } = await supabase
    .from('products')
    .update({ data: productData })
    .eq('id', id)
    .eq('store', req.storeId)
    .select('id, store, data')
    .single();

  if (updateError) {
    console.error('Error actualizando producto en Supabase:', updateError);
    return res.status(500).json({ error: 'No se pudo actualizar el producto.' });
  }
  res.json(row2obj(updated));
});

// ----------------------------------------------------------------
// DELETE /api/products/:id
// Elimina un producto puntual (lo usa el botón "Eliminar" del panel).
// ----------------------------------------------------------------
app.delete('/api/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const { data: deleted, error } = await supabase
    .from('products')
    .delete()
    .eq('id', id)
    .eq('store', req.storeId)
    .select('id');

  if (error) {
    console.error('Error borrando producto en Supabase:', error);
    return res.status(500).json({ error: 'No se pudo borrar el producto.' });
  }
  if (!deleted || deleted.length === 0) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend de pedidos corriendo en el puerto ${PORT}`);
});


