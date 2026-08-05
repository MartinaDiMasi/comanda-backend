// ================================================================
// BACKEND — Centro de pedidos "Comanda"
// ----------------------------------------------------------------
// Guarda los pedidos en un archivo JSON en disco (orders.json) y los
// expone por una API REST. El panel de control los consulta cada
// pocos segundos (polling) para enterarse de pedidos nuevos.
//
// Endpoints:
//   GET    /api/orders            -> lista todos los pedidos
//   POST   /api/orders            -> crea un pedido nuevo (lo usa la tienda)
//   PATCH  /api/orders/:id        -> actualiza status / tags / agrega nota
//   GET    /api/health            -> chequeo simple de que el server vive
// ================================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'orders.json');

// ----------------------------------------------------------------
// CORS: en producción, reemplazá el '*' por el dominio real de tu
// tienda (ej: "https://mi-comercio.com") para que solo tu propia
// página pueda mandar pedidos a este backend.
// ----------------------------------------------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

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
  res.json(db.orders);
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
      time: nowHHMM(),
      createdAt: new Date().toISOString(),
      notes: body.note ? [{ text: String(body.note), time: nowHHMM() }] : [],
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
    const order = db.orders.find(o => o.id === id);
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
// DELETE /api/orders/:id
// Elimina un pedido puntual (lo usa el botón "Eliminar" del panel).
// ----------------------------------------------------------------
app.delete('/api/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const existed = await withDB((db) => {
    const before = db.orders.length;
    db.orders = db.orders.filter(o => o.id !== id);
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
    db.orders = db.orders.filter(o => !statuses.includes(o.status));
    return before - db.orders.length;
  });

  res.json({ ok: true, deleted });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend de pedidos corriendo en el puerto ${PORT}`);
});
