require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const dbPath = path.resolve(__dirname, '../database/inventory.db');
const backupDir = path.resolve(__dirname, '../database/backups');
const uploadDir = path.resolve(__dirname, '../uploads/images');
const maxAutoBackups = Number(process.env.MAX_AUTO_BACKUPS || 14);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const partFields = [
  'name',
  'brand',
  'partNumber',
  'internalCode',
  'barcode',
  'categoryId',
  'locationId',
  'type',
  'condition',
  'quantity',
  'unit',
  'reorderThreshold',
  'reorderQty',
  'unitCost',
  'retailPrice',
  'supplier',
  'supplierSku',
  'fitment',
  'notes',
  'imageUrl'
];

function normalizePart(body) {
  return {
    name: String(body.name || '').trim(),
    brand: String(body.brand || '').trim(),
    partNumber: String(body.partNumber || '').trim(),
    internalCode: String(body.internalCode || '').trim(),
    barcode: String(body.barcode || '').trim(),
    categoryId: body.categoryId || body.categoryId === 0 ? Number(body.categoryId) : null,
    locationId: body.locationId || body.locationId === 0 ? Number(body.locationId) : null,
    type: String(body.type || 'used').trim(),
    condition: String(body.condition || 'untested').trim(),
    quantity: Number(body.quantity) || 0,
    unit: String(body.unit || 'each').trim(),
    reorderThreshold: Number(body.reorderThreshold) || 0,
    reorderQty: Number(body.reorderQty) || 0,
    unitCost: Number(body.unitCost) || 0,
    retailPrice: Number(body.retailPrice) || 0,
    supplier: String(body.supplier || '').trim(),
    supplierSku: String(body.supplierSku || '').trim(),
    fitment: String(body.fitment || '').trim(),
    notes: String(body.notes || '').trim(),
    imageUrl: String(body.imageUrl || '').trim()
  };
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin || '')).digest('hex');
}

function ensureColumn(table, columns, name, definition) {
  if (columns.includes(name)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, [], (alterErr) => {
    if (alterErr) console.error(`Failed to add ${table}.${name} column`, alterErr);
  });
}

function seedDefaultUsers() {
  db.get('SELECT COUNT(*) AS count FROM users', [], (err, row) => {
    if (err) {
      console.error('Failed to inspect users table', err);
      return;
    }

    if (row.count > 0) return;

    const stmt = db.prepare('INSERT INTO users (name, role, pinHash) VALUES (?, ?, ?)');
    stmt.run(['Owner', 'owner', hashPin('1234')]);
    stmt.run(['Tech', 'tech', hashPin('2468')]);
    stmt.run(['Viewer', 'viewer', hashPin('0000')]);
    stmt.finalize();
  });
}

function createSystemTables() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'tech',
      pinHash TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      userName TEXT,
      action TEXT NOT NULL,
      entityType TEXT,
      entityId INTEGER,
      details TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partId INTEGER,
      userId INTEGER,
      userName TEXT,
      movementType TEXT NOT NULL,
      qtyChange INTEGER NOT NULL,
      quantityAfter INTEGER NOT NULL,
      reason TEXT,
      workorderRef TEXT,
      customerRef TEXT,
      equipmentRef TEXT,
      unitCost REAL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, [], seedDefaultUsers);

    db.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customerId INTEGER,
      name TEXT NOT NULL,
      year TEXT,
      make TEXT,
      model TEXT,
      vin TEXT,
      serial TEXT,
      serialPhotoUrl TEXT,
      fleetPhotoUrl TEXT,
      unitNumber TEXT,
      mileage TEXT,
      hours TEXT,
      notes TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS workorders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      customerId INTEGER,
      equipmentId INTEGER,
      complaint TEXT,
      diagnosis TEXT,
      estimateNotes TEXT,
      approvalStatus TEXT DEFAULT 'pending',
      approvalMethod TEXT,
      approvalLimit REAL DEFAULT 0,
      approvedBy TEXT,
      approvedAt TEXT,
      laborNotes TEXT,
      laborHours REAL DEFAULT 0,
      laborRate REAL DEFAULT 0,
      laborStartedAt TEXT,
      laborAccumulatedMs INTEGER DEFAULT 0,
      customerSignatureDataUrl TEXT,
      customerSignatureName TEXT,
      customerSignedAt TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS workorder_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workorderId INTEGER NOT NULL,
      partId INTEGER NOT NULL,
      qtyReserved INTEGER DEFAULT 0,
      qtyUsed INTEGER DEFAULT 0,
      unitCost REAL DEFAULT 0,
      retailPrice REAL DEFAULT 0,
      note TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
}

function getActor(req) {
  return {
    id: req.user?.id || null,
    name: req.user?.name || 'System',
    role: req.user?.role || 'system'
  };
}

function writeAudit(req, action, entityType, entityId, details = {}) {
  const actor = getActor(req);
  db.run(
    'INSERT INTO audit_logs (userId, userName, action, entityType, entityId, details) VALUES (?, ?, ?, ?, ?, ?)',
    [actor.id, actor.name, action, entityType, entityId || null, JSON.stringify(details)]
  );
}

function writeStockMovement(req, partId, movementType, qtyChange, quantityAfter, meta = {}) {
  const actor = getActor(req);
  db.run(
    `INSERT INTO stock_movements (
      partId, userId, userName, movementType, qtyChange, quantityAfter,
      reason, workorderRef, customerRef, equipmentRef, unitCost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      partId,
      actor.id,
      actor.name,
      movementType,
      qtyChange,
      quantityAfter,
      meta.reason || '',
      meta.workorderRef || '',
      meta.customerRef || '',
      meta.equipmentRef || '',
      Number(meta.unitCost) || 0
    ]
  );
}

function resolveUser(req, res, next) {
  const userId = Number(req.get('x-user-id') || 0);
  if (!userId) return next();

  db.get('SELECT id, name, role, active FROM users WHERE id = ? AND active = 1', [userId], (err, user) => {
    if (err) return res.status(500).json({ error: 'Failed to load user' });
    req.user = user || null;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Permission denied for this role' });
    next();
  };
}

function ensureSchema() {
  createSystemTables();

  db.all('PRAGMA table_info(parts)', [], (err, columns) => {
    if (err) {
      console.error('Failed to inspect parts schema', err);
      return;
    }

    const names = columns.map((column) => column.name);
    ensureColumn('parts', names, 'imageUrl', 'TEXT');
    ensureColumn('parts', names, 'unitCost', 'REAL DEFAULT 0');
    ensureColumn('parts', names, 'retailPrice', 'REAL DEFAULT 0');
  });

  db.all('PRAGMA table_info(transactions)', [], (err, columns) => {
    if (err) {
      console.error('Failed to inspect transactions schema', err);
      return;
    }

    const names = columns.map((column) => column.name);
    ensureColumn('transactions', names, 'note', 'TEXT');
    ensureColumn('transactions', names, 'workorderRef', 'TEXT');
    ensureColumn('transactions', names, 'customerRef', 'TEXT');
    ensureColumn('transactions', names, 'equipmentRef', 'TEXT');
    ensureColumn('transactions', names, 'unitCost', 'REAL DEFAULT 0');
  });

  db.all('PRAGMA table_info(equipment)', [], (err, columns) => {
    if (err) {
      console.error('Failed to inspect equipment schema', err);
      return;
    }

    const names = columns.map((column) => column.name);
    ensureColumn('equipment', names, 'serialPhotoUrl', 'TEXT');
    ensureColumn('equipment', names, 'fleetPhotoUrl', 'TEXT');
  });

  db.all('PRAGMA table_info(workorders)', [], (err, columns) => {
    if (err) {
      console.error('Failed to inspect workorders schema', err);
      return;
    }

    const names = columns.map((column) => column.name);
    ensureColumn('workorders', names, 'estimateNotes', 'TEXT');
    ensureColumn('workorders', names, 'approvalStatus', "TEXT DEFAULT 'pending'");
    ensureColumn('workorders', names, 'approvalMethod', 'TEXT');
    ensureColumn('workorders', names, 'approvalLimit', 'REAL DEFAULT 0');
    ensureColumn('workorders', names, 'approvedBy', 'TEXT');
    ensureColumn('workorders', names, 'approvedAt', 'TEXT');
    ensureColumn('workorders', names, 'laborStartedAt', 'TEXT');
    ensureColumn('workorders', names, 'laborAccumulatedMs', 'INTEGER DEFAULT 0');
    ensureColumn('workorders', names, 'customerSignatureDataUrl', 'TEXT');
    ensureColumn('workorders', names, 'customerSignatureName', 'TEXT');
    ensureColumn('workorders', names, 'customerSignedAt', 'TEXT');
  });
}

ensureSchema();
app.use(resolveUser);

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function computeLaborMs(workorder) {
  const accumulated = Number(workorder?.laborAccumulatedMs || 0);
  if (!workorder?.laborStartedAt) return accumulated;
  const startedAt = new Date(workorder.laborStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return accumulated;
  return Math.max(0, accumulated + (Date.now() - startedAt));
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function timestampName(prefix, ext) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function createDatabaseBackup(prefix, callback) {
  const backupPath = path.join(backupDir, timestampName(prefix, 'db'));

  fs.copyFile(dbPath, backupPath, (err) => {
    if (err) {
      if (callback) callback(err);
      return;
    }

    if (callback) callback(null, backupPath);
  });
}

function pruneAutoBackups() {
  fs.readdir(backupDir, (err, files) => {
    if (err) {
      console.error('Failed to read backup directory', err);
      return;
    }

    const autoBackups = files
      .filter((file) => file.startsWith('auto-startup-') && file.endsWith('.db'))
      .map((file) => ({
        file,
        path: path.join(backupDir, file),
        created: fs.statSync(path.join(backupDir, file)).mtimeMs
      }))
      .sort((a, b) => b.created - a.created);

    for (const backup of autoBackups.slice(maxAutoBackups)) {
      fs.unlink(backup.path, (unlinkErr) => {
        if (unlinkErr) console.error('Failed to prune old backup', unlinkErr);
      });
    }
  });
}

function createStartupBackup() {
  if (!fs.existsSync(dbPath)) return;

  createDatabaseBackup('auto-startup', (err, backupPath) => {
    if (err) {
      console.error('Failed to create startup backup', err);
      return;
    }

    console.log(`Startup backup created: ${path.basename(backupPath)}`);
    pruneAutoBackups();
  });
}

createStartupBackup();

// HEALTH
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Inventory server is running',
    host: HOST,
    port: PORT,
    lanAddresses: getLanAddresses()
  });
});

// USERS / AUTH
app.get('/api/users', (req, res) => {
  db.all('SELECT id, name, role, active, createdAt FROM users ORDER BY name ASC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load users' });
    }
    res.json(rows);
  });
});

app.post('/api/auth/login', (req, res) => {
  const name = String(req.body.name || '').trim();
  const pinHash = hashPin(req.body.pin || '');

  db.get(
    'SELECT id, name, role, active FROM users WHERE lower(name) = lower(?) AND pinHash = ? AND active = 1',
    [name, pinHash],
    (err, user) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to sign in' });
      }

      if (!user) return res.status(401).json({ error: 'Name or PIN did not match' });
      writeAudit({ user }, 'login', 'user', user.id, { name: user.name });
      res.json({ user });
    }
  );
});

app.post('/api/users', requireRole('owner'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const role = ['owner', 'tech', 'viewer'].includes(req.body.role) ? req.body.role : 'tech';
  const pin = String(req.body.pin || '').trim();

  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });

  db.run(
    'INSERT INTO users (name, role, pinHash) VALUES (?, ?, ?)',
    [name, role, hashPin(pin)],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add user' });
      }
      writeAudit(req, 'create', 'user', this.lastID, { name, role });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/users/:id', requireRole('owner'), (req, res) => {
  const id = req.params.id;
  const name = String(req.body.name || '').trim();
  const role = ['owner', 'tech', 'viewer'].includes(req.body.role) ? req.body.role : 'tech';
  const active = req.body.active === false || req.body.active === 0 ? 0 : 1;
  const pin = String(req.body.pin || '').trim();

  if (!name) return res.status(400).json({ error: 'Name required' });

  const sql = pin
    ? 'UPDATE users SET name = ?, role = ?, active = ?, pinHash = ? WHERE id = ?'
    : 'UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?';
  const params = pin ? [name, role, active, hashPin(pin), id] : [name, role, active, id];

  db.run(sql, params, function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update user' });
    }
    writeAudit(req, 'update', 'user', id, { name, role, active });
    res.json({ success: true, updated: this.changes });
  });
});

app.get('/api/audit', (req, res) => {
  db.all('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 200', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load audit log' });
    }
    res.json(rows);
  });
});

app.get('/api/stock-movements', (req, res) => {
  db.all(
    `SELECT m.*, p.name AS partName
     FROM stock_movements m
     LEFT JOIN parts p ON p.id = m.partId
     ORDER BY m.timestamp DESC
     LIMIT 300`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load stock movements' });
      }
      res.json(rows);
    }
  );
});

// CUSTOMERS / EQUIPMENT / WORKORDERS
app.get('/api/customers', (req, res) => {
  db.all('SELECT * FROM customers ORDER BY name ASC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load customers' });
    }
    res.json(rows);
  });
});

app.get('/api/customers/:id/workorders', (req, res) => {
  db.all(
    `SELECT w.*, e.name AS equipmentName
     FROM workorders w
     LEFT JOIN equipment e ON e.id = w.equipmentId
     WHERE w.customerId = ?
     ORDER BY w.updatedAt DESC, w.id DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load customer workorders' });
      }
      res.json(rows);
    }
  );
});

app.post('/api/customers', requireRole('owner', 'tech'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const email = String(req.body.email || '').trim();
  const notes = String(req.body.notes || '').trim();

  if (!name) return res.status(400).json({ error: 'Customer name required' });

  db.run(
    'INSERT INTO customers (name, phone, email, notes) VALUES (?, ?, ?, ?)',
    [name, phone, email, notes],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add customer' });
      }
      writeAudit(req, 'create', 'customer', this.lastID, { name });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/customers/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const email = String(req.body.email || '').trim();
  const notes = String(req.body.notes || '').trim();

  if (!name) return res.status(400).json({ error: 'Customer name required' });

  db.run(
    'UPDATE customers SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?',
    [name, phone, email, notes, id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to update customer' });
      }
      writeAudit(req, 'update', 'customer', id, { name });
      res.json({ success: true, updated: this.changes });
    }
  );
});

app.get('/api/equipment', (req, res) => {
  db.all(
    `SELECT e.*, c.name AS customerName
     FROM equipment e
     LEFT JOIN customers c ON c.id = e.customerId
     ORDER BY e.name ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load equipment' });
      }
      res.json(rows);
    }
  );
});

app.get('/api/equipment/:id/workorders', (req, res) => {
  db.all(
    `SELECT w.*, c.name AS customerName
     FROM workorders w
     LEFT JOIN customers c ON c.id = w.customerId
     WHERE w.equipmentId = ?
     ORDER BY w.updatedAt DESC, w.id DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load equipment workorders' });
      }
      res.json(rows);
    }
  );
});

app.post('/api/equipment', requireRole('owner', 'tech'), (req, res) => {
  const fields = {
    customerId: req.body.customerId ? Number(req.body.customerId) : null,
    name: String(req.body.name || '').trim(),
    year: String(req.body.year || '').trim(),
    make: String(req.body.make || '').trim(),
    model: String(req.body.model || '').trim(),
    vin: String(req.body.vin || '').trim(),
    serial: String(req.body.serial || '').trim(),
    serialPhotoUrl: String(req.body.serialPhotoUrl || '').trim(),
    fleetPhotoUrl: String(req.body.fleetPhotoUrl || '').trim(),
    unitNumber: String(req.body.unitNumber || '').trim(),
    mileage: String(req.body.mileage || '').trim(),
    hours: String(req.body.hours || '').trim(),
    notes: String(req.body.notes || '').trim()
  };

  if (!fields.name) return res.status(400).json({ error: 'Equipment name required' });

  db.run(
    `INSERT INTO equipment (
      customerId, name, year, make, model, vin, serial, serialPhotoUrl, fleetPhotoUrl, unitNumber, mileage, hours, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Object.values(fields),
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add equipment' });
      }
      writeAudit(req, 'create', 'equipment', this.lastID, { name: fields.name });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.get('/api/workorders', (req, res) => {
  db.all(
    `SELECT w.*, c.name AS customerName, e.name AS equipmentName,
      COALESCE(parts.partsCost, 0) AS partsCost,
      COALESCE(parts.partsRetail, 0) AS partsRetail,
      COALESCE(parts.reservedCount, 0) AS reservedCount,
      COALESCE(parts.usedCount, 0) AS usedCount
     FROM workorders w
     LEFT JOIN customers c ON c.id = w.customerId
     LEFT JOIN equipment e ON e.id = w.equipmentId
     LEFT JOIN (
       SELECT workorderId,
        SUM(qtyUsed * unitCost) AS partsCost,
        SUM(qtyUsed * retailPrice) AS partsRetail,
        SUM(qtyReserved) AS reservedCount,
        SUM(qtyUsed) AS usedCount
       FROM workorder_parts
       GROUP BY workorderId
     ) parts ON parts.workorderId = w.id
     ORDER BY w.updatedAt DESC, w.id DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load workorders' });
      }
      res.json(rows);
    }
  );
});

app.get('/api/workorders/:id', (req, res) => {
  db.get(
    `SELECT w.*, c.name AS customerName, c.phone AS customerPhone, c.email AS customerEmail,
      e.name AS equipmentName, e.make AS equipmentMake, e.model AS equipmentModel,
      e.serial AS equipmentSerial, e.unitNumber AS equipmentUnitNumber
     FROM workorders w
     LEFT JOIN customers c ON c.id = w.customerId
     LEFT JOIN equipment e ON e.id = w.equipmentId
     WHERE w.id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load workorder' });
      }
      if (!row) return res.status(404).json({ error: 'Workorder not found' });
      res.json(row);
    }
  );
});

app.get('/api/workorders/:id/parts', (req, res) => {
  db.all(
    `SELECT wp.*, p.name AS partName, p.partNumber, p.quantity, p.unit
     FROM workorder_parts wp
     LEFT JOIN parts p ON p.id = wp.partId
     WHERE wp.workorderId = ?
     ORDER BY wp.updatedAt DESC, wp.id DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load workorder parts' });
      }
      res.json(rows);
    }
  );
});

app.get('/api/workorders/:id/export', async (req, res) => {
  try {
    const workorder = await dbGet(
      `SELECT w.*, c.name AS customerName, c.phone AS customerPhone, c.email AS customerEmail, c.notes AS customerNotes,
        e.name AS equipmentName, e.year, e.make, e.model, e.vin, e.serial, e.unitNumber,
        e.mileage, e.hours, e.serialPhotoUrl, e.fleetPhotoUrl, e.notes AS equipmentNotes
       FROM workorders w
       LEFT JOIN customers c ON c.id = w.customerId
       LEFT JOIN equipment e ON e.id = w.equipmentId
       WHERE w.id = ?`,
      [req.params.id]
    );

    if (!workorder) return res.status(404).send('Workorder not found');

    const parts = await dbAll(
      `SELECT wp.*, p.name AS partName, p.partNumber, p.internalCode, p.barcode, p.unit
       FROM workorder_parts wp
       LEFT JOIN parts p ON p.id = wp.partId
       WHERE wp.workorderId = ?
       ORDER BY wp.id ASC`,
      [req.params.id]
    );

    const partsRetail = parts.reduce((total, part) => total + Number(part.qtyUsed || 0) * Number(part.retailPrice || 0), 0);
    const partsCost = parts.reduce((total, part) => total + Number(part.qtyUsed || 0) * Number(part.unitCost || 0), 0);
    const trackedLaborHours = computeLaborMs(workorder) / 3600000;
    const billedLaborHours = Math.max(Number(workorder.laborHours || 0), trackedLaborHours);
    const laborTotal = billedLaborHours * Number(workorder.laborRate || 0);
    const grandTotal = partsRetail + laborTotal;
    const approvalRows = [
      ['Estimate Status', workorder.approvalStatus || 'pending'],
      ['Approved By', workorder.approvedBy || ''],
      ['Approval Method', workorder.approvalMethod || ''],
      ['Approved At', workorder.approvedAt || ''],
      ['Approval Limit', workorder.approvalLimit ? money(workorder.approvalLimit) : '']
    ].filter(([, value]) => value);
    const origin = `${req.protocol}://${req.get('host')}`;
    const imageUrl = (src) => {
      if (!src) return '';
      return String(src).startsWith('/uploads/') ? `${origin}${src}` : src;
    };
    const fileSafeNumber = String(workorder.number || `WO-${workorder.id}`).replace(/[^a-zA-Z0-9._-]/g, '-');

    const partsRows = parts.length
      ? parts.map((part) => `
          <tr>
            <td>${htmlEscape(part.qtyUsed || part.qtyReserved || 0)}</td>
            <td>${htmlEscape(part.partNumber || part.internalCode || part.barcode || '')}</td>
            <td>${htmlEscape(part.partName || 'Unknown part')}${part.note ? `<br><small>${htmlEscape(part.note)}</small>` : ''}</td>
            <td class="num">${money(part.retailPrice)}</td>
            <td class="num">${money(Number(part.qtyUsed || 0) * Number(part.retailPrice || 0))}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="5">No parts recorded.</td></tr>';

    const photos = [workorder.serialPhotoUrl, workorder.fleetPhotoUrl].filter(Boolean).map((src, index) => `
      <figure>
        <img src="${htmlEscape(imageUrl(src))}" alt="">
        <figcaption>${index === 0 ? 'Serial number photo' : 'Fleet/unit number photo'}</figcaption>
      </figure>
    `).join('');

    const signatureBlock = workorder.customerSignatureDataUrl
      ? `
        <div>
          <img src="${htmlEscape(workorder.customerSignatureDataUrl)}" alt="Customer signature">
          <div class="signature-meta">${htmlEscape(workorder.customerSignatureName || 'Customer')}</div>
          <div class="signature-meta">${htmlEscape(workorder.customerSignedAt || '')}</div>
        </div>
      `
      : '<div class="line">Customer Signature</div>';

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
    <title>${htmlEscape(workorder.number)} Workorder</title>
  <style>
    body { color: #111; font-family: Arial, sans-serif; line-height: 1.35; margin: 28px; }
    header { align-items: start; border-bottom: 3px solid #111; display: flex; justify-content: space-between; padding-bottom: 12px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; }
    h2 { border-bottom: 1px solid #bbb; font-size: 17px; margin: 24px 0 8px; padding-bottom: 4px; }
    .muted { color: #555; }
    .status-chip { border: 1px solid #222; border-radius: 999px; display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 10px; text-transform: uppercase; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .box { border: 1px solid #bbb; border-radius: 6px; padding: 10px; }
    table { border-collapse: collapse; margin-top: 8px; width: 100%; }
    th, td { border: 1px solid #aaa; padding: 7px; text-align: left; vertical-align: top; }
    th { background: #eee; }
    .num { text-align: right; }
    .totals { margin-left: auto; max-width: 360px; }
    .totals div { display: flex; justify-content: space-between; padding: 6px 0; }
    .grand { border-top: 2px solid #111; font-size: 20px; font-weight: 700; }
    .photos { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    figure { margin: 0; }
    img { border: 1px solid #aaa; max-height: 260px; max-width: 100%; object-fit: contain; }
    figcaption { color: #555; font-size: 12px; margin-top: 4px; }
    .signatures { display: grid; gap: 30px; grid-template-columns: repeat(2, 1fr); margin-top: 34px; }
    .line { border-top: 1px solid #111; padding-top: 5px; }
    .signature-meta { color: #555; font-size: 12px; margin-top: 4px; }
    @media print { body { margin: 16px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Service Work Order</h1>
      <p class="muted">Estimate and service summary</p>
      <p class="muted">Prepared ${htmlEscape(new Date().toLocaleString())}</p>
    </div>
    <div>
      <h2>${htmlEscape(workorder.number)}</h2>
      <p><span class="status-chip">${htmlEscape(workorder.status || 'open')}</span></p>
      <p>Date received: ${htmlEscape(workorder.createdAt || '')}</p>
    </div>
  </header>

  <section class="grid">
    <div class="box">
      <h2>Customer Contact</h2>
      <p><strong>${htmlEscape(workorder.customerName || 'No customer')}</strong></p>
      <p>${htmlEscape(workorder.customerPhone || '')}</p>
      <p>${htmlEscape(workorder.customerEmail || '')}</p>
      <p>${htmlEscape(workorder.customerNotes || '')}</p>
    </div>
    <div class="box">
      <h2>Machine Details</h2>
      <p><strong>${htmlEscape(workorder.equipmentName || 'No equipment')}</strong></p>
      <p>${htmlEscape([workorder.year, workorder.make, workorder.model].filter(Boolean).join(' '))}</p>
      <p>Fleet/Unit: ${htmlEscape(workorder.unitNumber || '')}</p>
      <p>Serial: ${htmlEscape(workorder.serial || '')}</p>
      <p>VIN: ${htmlEscape(workorder.vin || '')}</p>
      <p>Hours/Mileage: ${htmlEscape([workorder.hours, workorder.mileage].filter(Boolean).join(' / '))}</p>
    </div>
  </section>

  <h2>Service Intake</h2>
  <div class="box">${htmlEscape(workorder.complaint || '').replace(/\n/g, '<br>') || 'No customer concern recorded.'}</div>

  <h2>Estimate Approval</h2>
  <div class="box">
    ${workorder.estimateNotes ? `<p>${htmlEscape(workorder.estimateNotes).replace(/\n/g, '<br>')}</p>` : '<p>No estimate notes recorded.</p>'}
    ${approvalRows.length ? `<table><tbody>${approvalRows.map(([label, value]) => `<tr><th>${htmlEscape(label)}</th><td>${htmlEscape(value)}</td></tr>`).join('')}</tbody></table>` : ''}
  </div>

  <h2>Repair Summary</h2>
  <div class="box">${htmlEscape(workorder.diagnosis || workorder.laborNotes || '').replace(/\n/g, '<br>') || 'No repair notes recorded.'}</div>

  ${photos ? `<h2>Machine Intake Photos</h2><div class="photos">${photos}</div>` : ''}

  <h2>Parts Used</h2>
  <table>
    <thead>
      <tr><th>Qty</th><th>Part # / Code</th><th>Description</th><th class="num">Unit Price</th><th class="num">Line Total</th></tr>
    </thead>
    <tbody>${partsRows}</tbody>
  </table>

  <h2>Charges Summary</h2>
  <div class="totals">
    <div><span>Parts</span><strong>${money(partsRetail)}</strong></div>
    <div><span>Labor (${htmlEscape(billedLaborHours.toFixed(2))} hrs @ ${money(workorder.laborRate)})</span><strong>${money(laborTotal)}</strong></div>
    <div class="grand"><span>Total Due</span><strong>${money(grandTotal)}</strong></div>
  </div>

  <div class="signatures">
    ${signatureBlock}
    <div class="line">Technician Signature</div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSafeNumber}-workorder.html"`);
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to export workorder');
  }
});

app.post('/api/workorders', requireRole('owner', 'tech'), (req, res) => {
  const title = String(req.body.title || '').trim();
  const number = String(req.body.number || `WO-${Date.now().toString().slice(-6)}`).trim();
  const status = String(req.body.status || 'open').trim();
  const customerId = req.body.customerId ? Number(req.body.customerId) : null;
  const equipmentId = req.body.equipmentId ? Number(req.body.equipmentId) : null;
  const complaint = String(req.body.complaint || '').trim();
  const diagnosis = String(req.body.diagnosis || '').trim();
  const estimateNotes = String(req.body.estimateNotes || '').trim();
  const approvalStatus = String(req.body.approvalStatus || 'pending').trim();
  const approvalMethod = String(req.body.approvalMethod || '').trim();
  const approvalLimit = Number(req.body.approvalLimit) || 0;
  const approvedBy = String(req.body.approvedBy || '').trim();
  const approvedAt = String(req.body.approvedAt || '').trim();
  const laborNotes = String(req.body.laborNotes || '').trim();
  const laborHours = Number(req.body.laborHours) || 0;
  const laborRate = Number(req.body.laborRate) || 0;
  const laborStartedAt = req.body.laborStartedAt ? String(req.body.laborStartedAt) : null;
  const laborAccumulatedMs = Number(req.body.laborAccumulatedMs) || 0;
  const customerSignatureDataUrl = String(req.body.customerSignatureDataUrl || '').trim();
  const customerSignatureName = String(req.body.customerSignatureName || '').trim();
  const customerSignedAt = String(req.body.customerSignedAt || '').trim();

  if (!title) return res.status(400).json({ error: 'Workorder title required' });

  db.run(
    `INSERT INTO workorders (
      number, title, status, customerId, equipmentId, complaint, diagnosis, estimateNotes, approvalStatus, approvalMethod,
      approvalLimit, approvedBy, approvedAt, laborNotes, laborHours, laborRate, laborStartedAt, laborAccumulatedMs,
      customerSignatureDataUrl, customerSignatureName, customerSignedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      number, title, status, customerId, equipmentId, complaint, diagnosis, estimateNotes, approvalStatus, approvalMethod,
      approvalLimit, approvedBy, approvedAt, laborNotes, laborHours, laborRate, laborStartedAt, laborAccumulatedMs,
      customerSignatureDataUrl, customerSignatureName, customerSignedAt
    ],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add workorder' });
      }
      writeAudit(req, 'create', 'workorder', this.lastID, { number, title });
      res.json({ success: true, id: this.lastID, number });
    }
  );
});

app.put('/api/workorders/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const title = String(req.body.title || '').trim();
  const number = String(req.body.number || '').trim();
  const status = String(req.body.status || 'open').trim();
  const customerId = req.body.customerId ? Number(req.body.customerId) : null;
  const equipmentId = req.body.equipmentId ? Number(req.body.equipmentId) : null;
  const complaint = String(req.body.complaint || '').trim();
  const diagnosis = String(req.body.diagnosis || '').trim();
  const estimateNotes = String(req.body.estimateNotes || '').trim();
  const approvalStatus = String(req.body.approvalStatus || 'pending').trim();
  const approvalMethod = String(req.body.approvalMethod || '').trim();
  const approvalLimit = Number(req.body.approvalLimit) || 0;
  const approvedBy = String(req.body.approvedBy || '').trim();
  const approvedAt = String(req.body.approvedAt || '').trim();
  const laborNotes = String(req.body.laborNotes || '').trim();
  const laborHours = Number(req.body.laborHours) || 0;
  const laborRate = Number(req.body.laborRate) || 0;
  const laborStartedAt = req.body.laborStartedAt ? String(req.body.laborStartedAt) : null;
  const laborAccumulatedMs = Number(req.body.laborAccumulatedMs) || 0;
  const customerSignatureDataUrl = String(req.body.customerSignatureDataUrl || '').trim();
  const customerSignatureName = String(req.body.customerSignatureName || '').trim();
  const customerSignedAt = String(req.body.customerSignedAt || '').trim();

  if (!title || !number) return res.status(400).json({ error: 'Workorder number and title required' });

  db.run(
    `UPDATE workorders SET
      number = ?, title = ?, status = ?, customerId = ?, equipmentId = ?,
      complaint = ?, diagnosis = ?, estimateNotes = ?, approvalStatus = ?, approvalMethod = ?, approvalLimit = ?, approvedBy = ?, approvedAt = ?,
      laborNotes = ?, laborHours = ?, laborRate = ?,
      laborStartedAt = ?, laborAccumulatedMs = ?, customerSignatureDataUrl = ?, customerSignatureName = ?, customerSignedAt = ?,
      updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      number, title, status, customerId, equipmentId, complaint, diagnosis, estimateNotes, approvalStatus, approvalMethod, approvalLimit, approvedBy, approvedAt,
      laborNotes, laborHours, laborRate, laborStartedAt, laborAccumulatedMs, customerSignatureDataUrl, customerSignatureName, customerSignedAt, id
    ],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to update workorder' });
      }
      writeAudit(req, 'update', 'workorder', id, { number, status });
      res.json({ success: true, updated: this.changes });
    }
  );
});

app.post('/api/workorders/:id/timer/start', requireRole('owner', 'tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const workorder = await dbGet('SELECT * FROM workorders WHERE id = ?', [id]);
    if (!workorder) return res.status(404).json({ error: 'Workorder not found' });
    if (workorder.laborStartedAt) {
      return res.json({ success: true, alreadyRunning: true, laborStartedAt: workorder.laborStartedAt });
    }

    const startedAt = new Date().toISOString();
    db.run(
      'UPDATE workorders SET laborStartedAt = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [startedAt, id],
      function (err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Failed to start labor timer' });
        }
        writeAudit(req, 'start-labor-timer', 'workorder', id, { startedAt });
        res.json({ success: true, laborStartedAt: startedAt });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start labor timer' });
  }
});

app.post('/api/workorders/:id/timer/stop', requireRole('owner', 'tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const workorder = await dbGet('SELECT * FROM workorders WHERE id = ?', [id]);
    if (!workorder) return res.status(404).json({ error: 'Workorder not found' });
    if (!workorder.laborStartedAt) {
      return res.json({
        success: true,
        laborAccumulatedMs: Number(workorder.laborAccumulatedMs || 0),
        laborHours: Number(workorder.laborHours || 0)
      });
    }

    const elapsedMs = computeLaborMs(workorder);
    const laborHours = Math.max(Number(workorder.laborHours || 0), elapsedMs / 3600000);

    db.run(
      `UPDATE workorders
       SET laborStartedAt = NULL, laborAccumulatedMs = ?, laborHours = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [elapsedMs, laborHours, id],
      function (err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Failed to stop labor timer' });
        }
        writeAudit(req, 'stop-labor-timer', 'workorder', id, { laborAccumulatedMs: elapsedMs, laborHours });
        res.json({ success: true, laborAccumulatedMs: elapsedMs, laborHours });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to stop labor timer' });
  }
});

app.post('/api/workorders/:id/parts', requireRole('owner', 'tech'), (req, res) => {
  const workorderId = req.params.id;
  const partId = Number(req.body.partId);
  const qty = Number(req.body.qty || 1);
  const mode = req.body.mode === 'use' ? 'use' : 'reserve';
  const note = String(req.body.note || '').trim();

  if (!partId || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Part and quantity required' });
  }

  db.get('SELECT * FROM parts WHERE id = ?', [partId], (partErr, part) => {
    if (partErr || !part) return res.status(404).json({ error: 'Part not found' });

    db.get('SELECT * FROM workorders WHERE id = ?', [workorderId], (woErr, workorder) => {
      if (woErr || !workorder) return res.status(404).json({ error: 'Workorder not found' });

      const qtyUsed = mode === 'use' ? qty : 0;
      const qtyReserved = mode === 'reserve' ? qty : qty;
      const newQty = Math.max(0, Number(part.quantity || 0) - qtyUsed);
      const actualUsed = Number(part.quantity || 0) - newQty;

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (qtyUsed > 0) {
          db.run('UPDATE parts SET quantity = ? WHERE id = ?', [newQty, partId]);
        }

        db.run(
          `INSERT INTO workorder_parts (
            workorderId, partId, qtyReserved, qtyUsed, unitCost, retailPrice, note
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [workorderId, partId, qtyReserved, actualUsed, part.unitCost || 0, part.retailPrice || 0, note],
          function (insertErr) {
            if (insertErr) {
              console.error(insertErr);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to add workorder part' });
            }

            db.run('UPDATE workorders SET updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [workorderId]);

            if (actualUsed > 0) {
              db.run(
                `INSERT INTO transactions (
                  partId, type, qtyChange, note, workorderRef, customerRef, equipmentRef, unitCost
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  partId,
                  'workorder-use',
                  -actualUsed,
                  note,
                  workorder.number,
                  workorder.customerId || '',
                  workorder.equipmentId || '',
                  part.unitCost || 0
                ]
              );
              writeStockMovement(req, partId, 'workorder-use', -actualUsed, newQty, {
                reason: note || `Used on ${workorder.number}`,
                workorderRef: workorder.number,
                customerRef: workorder.customerId || '',
                equipmentRef: workorder.equipmentId || '',
                unitCost: part.unitCost || 0
              });
            }

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                console.error(commitErr);
                return res.status(500).json({ error: 'Failed to finish workorder part update' });
              }
              writeAudit(req, mode === 'use' ? 'use-part' : 'reserve-part', 'workorder', workorderId, {
                partId,
                qty,
                actualUsed
              });
              res.json({ success: true, id: this.lastID, actualUsed });
            });
          }
        );
      });
    });
  });
});

app.delete('/api/workorder-parts/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM workorder_parts WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Workorder part not found' });
    if (Number(row.qtyUsed) > 0) {
      return res.status(400).json({ error: 'Used parts stay on the workorder history. Add a return instead.' });
    }

    db.run('DELETE FROM workorder_parts WHERE id = ?', [id], function (deleteErr) {
      if (deleteErr) {
        console.error(deleteErr);
        return res.status(500).json({ error: 'Failed to remove reserved part' });
      }
      writeAudit(req, 'remove-reserved-part', 'workorder', row.workorderId, { workorderPartId: id });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

app.post('/api/workorder-parts/:id/return', requireRole('owner', 'tech'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const qty = Number(req.body.qty || 0);
    const note = String(req.body.note || '').trim();
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Return quantity required' });

    const row = await dbGet(
      `SELECT wp.*, w.number AS workorderNumber, w.customerId, w.equipmentId, p.quantity AS partQuantity
       FROM workorder_parts wp
       LEFT JOIN workorders w ON w.id = wp.workorderId
       LEFT JOIN parts p ON p.id = wp.partId
       WHERE wp.id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Workorder part not found' });
    if (Number(row.qtyUsed || 0) < qty) return res.status(400).json({ error: 'Cannot return more than was used' });

    const nextQtyUsed = Number(row.qtyUsed || 0) - qty;
    const nextQtyReserved = Math.max(0, Number(row.qtyReserved || 0) - qty);
    const nextPartQuantity = Number(row.partQuantity || 0) + qty;

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('UPDATE parts SET quantity = ? WHERE id = ?', [nextPartQuantity, row.partId]);
      db.run(
        `UPDATE workorder_parts
         SET qtyUsed = ?, qtyReserved = ?, note = TRIM(COALESCE(note, '') || ?), updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [nextQtyUsed, nextQtyReserved, note ? `\nReturn: ${note}` : '', id],
        (updateErr) => {
          if (updateErr) {
            console.error(updateErr);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to update workorder part return' });
          }
          db.run('UPDATE workorders SET updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [row.workorderId]);
          db.run(
            `INSERT INTO transactions (
              partId, type, qtyChange, note, workorderRef, customerRef, equipmentRef, unitCost
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.partId,
              'workorder-return',
              qty,
              note || `Returned from ${row.workorderNumber}`,
              row.workorderNumber || '',
              row.customerId || '',
              row.equipmentId || '',
              row.unitCost || 0
            ]
          );
          writeStockMovement(req, row.partId, 'workorder-return', qty, nextPartQuantity, {
            reason: note || `Returned from ${row.workorderNumber}`,
            workorderRef: row.workorderNumber || '',
            customerRef: row.customerId || '',
            equipmentRef: row.equipmentId || '',
            unitCost: row.unitCost || 0
          });
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              console.error(commitErr);
              return res.status(500).json({ error: 'Failed to finish part return' });
            }
            writeAudit(req, 'return-used-part', 'workorder', row.workorderId, { workorderPartId: id, qty });
            res.json({ success: true, qtyReturned: qty, nextQtyUsed, nextPartQuantity });
          });
        }
      );
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to return used part' });
  }
});

// PARTS
app.get('/api/parts', (req, res) => {
  db.all(
    `SELECT p.*,
      COALESCE(r.reservedQty, 0) AS reservedQty,
      p.quantity - COALESCE(r.reservedQty, 0) AS availableQty
     FROM parts p
     LEFT JOIN (
       SELECT partId, SUM(MAX(qtyReserved - qtyUsed, 0)) AS reservedQty
       FROM workorder_parts
       GROUP BY partId
     ) r ON r.partId = p.id
     ORDER BY p.name ASC`,
    [],
    (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load parts' });
    }
    res.json(rows);
    }
  );
});

app.get('/api/parts/export', (req, res) => {
  db.all('SELECT * FROM parts ORDER BY name ASC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to export parts' });
    }

    const header = ['id', ...partFields];
    const csv = [
      header.join(','),
      ...rows.map((row) => header.map((field) => csvEscape(row[field])).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory-parts.csv"');
    res.send(csv);
  });
});

app.get('/api/parts/export/low-stock', (req, res) => {
  db.all(
    'SELECT * FROM parts WHERE reorderThreshold > 0 AND quantity <= reorderThreshold ORDER BY name ASC',
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to export low stock parts' });
      }

      const header = ['id', ...partFields];
      const csv = [
        header.join(','),
        ...rows.map((row) => header.map((field) => csvEscape(row[field])).join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="low-stock-parts.csv"');
      res.send(csv);
    }
  );
});

app.post('/api/parts', requireRole('owner', 'tech'), (req, res) => {
  const part = normalizePart(req.body);

  if (!part.name) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.run(
    `INSERT INTO parts (
      name, brand, partNumber, internalCode, barcode,
      categoryId, locationId, type, condition, quantity, unit,
      reorderThreshold, reorderQty, unitCost, retailPrice, supplier, supplierSku, fitment, notes, imageUrl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    partFields.map((field) => part[field]),
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add part' });
      }
      writeAudit(req, 'create', 'part', this.lastID, { name: part.name, quantity: part.quantity });
      if (part.quantity !== 0) {
        writeStockMovement(req, this.lastID, 'initial', part.quantity, part.quantity, {
          reason: 'Initial stock',
          unitCost: part.unitCost
        });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.post('/api/parts/:id/checkout', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const qty = Number(req.body.qty || 1);
  const note = String(req.body.note || '').trim();
  const workorderRef = String(req.body.workorderRef || '').trim();
  const customerRef = String(req.body.customerRef || '').trim();
  const equipmentRef = String(req.body.equipmentRef || '').trim();

  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be greater than zero' });
  }

  db.get('SELECT quantity, unitCost FROM parts WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Part not found' });
    }

    const newQty = Math.max(0, row.quantity - qty);
    const actualQty = row.quantity - newQty;

    db.run('UPDATE parts SET quantity = ? WHERE id = ?', [newQty, id], (updateErr) => {
      if (updateErr) {
        console.error(updateErr);
        return res.status(500).json({ error: 'Failed to checkout part' });
      }

      db.run(
        `INSERT INTO transactions (
          partId, type, qtyChange, note, workorderRef, customerRef, equipmentRef, unitCost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'checkout', -actualQty, note, workorderRef, customerRef, equipmentRef, row.unitCost || 0]
      );
      writeStockMovement(req, id, 'checkout', -actualQty, newQty, {
        reason: note,
        workorderRef,
        customerRef,
        equipmentRef,
        unitCost: row.unitCost || 0
      });
      writeAudit(req, 'checkout', 'part', id, { qty: actualQty, quantityAfter: newQty, workorderRef });

      res.json({ success: true, quantity: newQty });
    });
  });
});

app.post('/api/parts/:id/return', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const qty = Number(req.body.qty || 1);
  const note = String(req.body.note || '').trim();
  const workorderRef = String(req.body.workorderRef || '').trim();
  const customerRef = String(req.body.customerRef || '').trim();
  const equipmentRef = String(req.body.equipmentRef || '').trim();

  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be greater than zero' });
  }

  db.get('SELECT quantity, unitCost FROM parts WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Part not found' });
    }

    const newQty = row.quantity + qty;

    db.run('UPDATE parts SET quantity = ? WHERE id = ?', [newQty, id], (updateErr) => {
      if (updateErr) {
        console.error(updateErr);
        return res.status(500).json({ error: 'Failed to return part' });
      }

      db.run(
        `INSERT INTO transactions (
          partId, type, qtyChange, note, workorderRef, customerRef, equipmentRef, unitCost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'return', qty, note, workorderRef, customerRef, equipmentRef, row.unitCost || 0]
      );
      writeStockMovement(req, id, 'return', qty, newQty, {
        reason: note,
        workorderRef,
        customerRef,
        equipmentRef,
        unitCost: row.unitCost || 0
      });
      writeAudit(req, 'return', 'part', id, { qty, quantityAfter: newQty, workorderRef });

      res.json({ success: true, quantity: newQty });
    });
  });
});

app.get('/api/transactions', (req, res) => {
  db.all(
    `SELECT t.*, p.name AS partName
     FROM transactions t
     LEFT JOIN parts p ON p.id = t.partId
     ORDER BY t.timestamp DESC
     LIMIT 200`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load transactions' });
      }
      res.json(rows);
    }
  );
});

// LOCATIONS
app.get('/api/locations', (req, res) => {
  db.all('SELECT * FROM locations ORDER BY name ASC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load locations' });
    }
    res.json(rows);
  });
});

app.post('/api/locations', requireRole('owner', 'tech'), (req, res) => {
  const { name, parentId = null, type = '' } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.run(
    'INSERT INTO locations (name, parentId, type) VALUES (?, ?, ?)',
    [name, parentId || null, type],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add location' });
      }
      writeAudit(req, 'create', 'location', this.lastID, { name, type });
      res.json({ id: this.lastID });
    }
  );
});

app.patch('/api/transactions/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const note = String(req.body.note || '').trim();

  db.run('UPDATE transactions SET note = ? WHERE id = ?', [note, id], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update transaction' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    writeAudit(req, 'update', 'transaction', id, { note });
    res.json({ success: true });
  });
});

app.post('/api/parts/:id/count', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const countedQty = Number(req.body.quantity);
  const reason = String(req.body.reason || 'Inventory count').trim();

  if (!Number.isFinite(countedQty) || countedQty < 0) {
    return res.status(400).json({ error: 'Counted quantity must be zero or greater' });
  }

  db.get('SELECT quantity, unitCost FROM parts WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Part not found' });
    }

    const qtyChange = countedQty - row.quantity;
    db.run('UPDATE parts SET quantity = ? WHERE id = ?', [countedQty, id], (updateErr) => {
      if (updateErr) {
        console.error(updateErr);
        return res.status(500).json({ error: 'Failed to save count' });
      }

      db.run(
        'INSERT INTO transactions (partId, type, qtyChange, note, unitCost) VALUES (?, ?, ?, ?, ?)',
        [id, 'count', qtyChange, reason, row.unitCost || 0]
      );
      writeStockMovement(req, id, 'count', qtyChange, countedQty, { reason, unitCost: row.unitCost || 0 });
      writeAudit(req, 'count', 'part', id, { previousQty: row.quantity, countedQty, qtyChange });
      res.json({ success: true, quantity: countedQty, qtyChange });
    });
  });
});

app.delete('/api/transactions/:id', requireRole('owner'), (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM transactions WHERE id = ?', [id], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete transaction' });
    }

    writeAudit(req, 'delete', 'transaction', id, { deleted: this.changes });
    res.json({ success: true, deleted: this.changes });
  });
});

app.put('/api/locations/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const { name, parentId = null, type = '' } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  if (Number(parentId) === Number(id)) {
    return res.status(400).json({ error: 'A location cannot be its own parent' });
  }

  db.run(
    'UPDATE locations SET name = ?, parentId = ?, type = ? WHERE id = ?',
    [String(name).trim(), parentId || null, type, id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to update location' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Location not found' });
      }

      writeAudit(req, 'update', 'location', id, { name: String(name).trim(), type });
      res.json({ success: true });
    }
  );
});

app.post('/api/parts/import', requireRole('owner'), (req, res) => {
  const rows = Array.isArray(req.body.parts) ? req.body.parts : [];
  const cleaned = rows.map(normalizePart).filter((part) => part.name);

  if (cleaned.length === 0) {
    return res.status(400).json({ error: 'No valid parts to import' });
  }

  const stmt = db.prepare(
    `INSERT INTO parts (
      name, brand, partNumber, internalCode, barcode,
      categoryId, locationId, type, condition, quantity, unit,
      reorderThreshold, reorderQty, unitCost, retailPrice, supplier, supplierSku, fitment, notes, imageUrl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    for (const part of cleaned) {
      stmt.run(partFields.map((field) => part[field]));
    }

    stmt.finalize((finalizeErr) => {
      if (finalizeErr) {
        console.error(finalizeErr);
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Failed to import parts' });
      }

      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          console.error(commitErr);
          return res.status(500).json({ error: 'Failed to finish import' });
        }

        writeAudit(req, 'import', 'part', null, { imported: cleaned.length });
        res.json({ success: true, imported: cleaned.length });
      });
    });
  });
});

app.put('/api/parts/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const part = normalizePart(req.body);

  if (!part.name) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.run(
    `UPDATE parts SET
      name = ?, brand = ?, partNumber = ?, internalCode = ?, barcode = ?,
      categoryId = ?, locationId = ?, type = ?, condition = ?, quantity = ?, unit = ?,
      reorderThreshold = ?, reorderQty = ?, unitCost = ?, retailPrice = ?, supplier = ?, supplierSku = ?, fitment = ?,
      notes = ?, imageUrl = ?
     WHERE id = ?`,
    [...partFields.map((field) => part[field]), id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to update part' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Part not found' });
      }

      writeAudit(req, 'update', 'part', id, { name: part.name, quantity: part.quantity });
      res.json({ success: true });
    }
  );
});

app.delete('/api/parts/:id', requireRole('owner'), (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM parts WHERE id = ?', [id], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete part' });
    }

    writeAudit(req, 'delete', 'part', id, { deleted: this.changes });
    res.json({ success: true, deleted: this.changes });
  });
});

app.post('/api/uploads/image', requireRole('owner', 'tech'), (req, res) => {
  const { dataUrl, fileName = 'part-image' } = req.body;
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    return res.status(400).json({ error: 'Image data required' });
  }

  const extByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };
  const ext = extByType[match[1]] || 'png';
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'part-image';
  const storedName = `${Date.now()}-${safeName}.${ext}`;
  const storedPath = path.join(uploadDir, storedName);

  fs.writeFile(storedPath, match[2], 'base64', (err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to save image' });
    }

    res.json({ success: true, imageUrl: `/uploads/images/${storedName}` });
  });
});

app.delete('/api/locations/:id', requireRole('owner'), (req, res) => {
  const id = req.params.id;

  db.get('SELECT COUNT(*) AS count FROM parts WHERE locationId = ?', [id], (partErr, partRow) => {
    if (partErr) {
      console.error(partErr);
      return res.status(500).json({ error: 'Failed to check location usage' });
    }

    if (partRow.count > 0) {
      return res.status(400).json({
        error: 'Location is in use by one or more parts. Reassign those parts first.'
      });
    }

    db.get('SELECT COUNT(*) AS count FROM locations WHERE parentId = ?', [id], (childErr, childRow) => {
      if (childErr) {
        console.error(childErr);
        return res.status(500).json({ error: 'Failed to check child locations' });
      }

      if (childRow.count > 0) {
        return res.status(400).json({
          error: 'Location has child locations. Delete or move those first.'
        });
      }

      db.run('DELETE FROM locations WHERE id = ?', [id], function (err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Failed to delete location' });
        }

        writeAudit(req, 'delete', 'location', id, { deleted: this.changes });
        res.json({ success: true, deleted: this.changes });
      });
    });
  });
});

// CATEGORIES
app.get('/api/categories', (req, res) => {
  db.all('SELECT * FROM categories ORDER BY name ASC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load categories' });
    }
    res.json(rows);
  });
});

app.post('/api/categories', requireRole('owner', 'tech'), (req, res) => {
  const { name, parentId = null } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.run(
    'INSERT INTO categories (name, parentId) VALUES (?, ?)',
    [name, parentId || null],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add category' });
      }
      writeAudit(req, 'create', 'category', this.lastID, { name });
      res.json({ id: this.lastID });
    }
  );
});

app.put('/api/categories/:id', requireRole('owner', 'tech'), (req, res) => {
  const id = req.params.id;
  const { name, parentId = null } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  if (Number(parentId) === Number(id)) {
    return res.status(400).json({ error: 'A category cannot be its own parent' });
  }

  db.run(
    'UPDATE categories SET name = ?, parentId = ? WHERE id = ?',
    [String(name).trim(), parentId || null, id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to update category' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      writeAudit(req, 'update', 'category', id, { name: String(name).trim() });
      res.json({ success: true });
    }
  );
});

app.delete('/api/categories/:id', requireRole('owner'), (req, res) => {
  const id = req.params.id

  db.get('SELECT COUNT(*) AS count FROM parts WHERE categoryId = ?', [id], (countErr, row) => {
    if (countErr) {
      console.error(countErr)
      return res.status(500).json({ error: 'Failed to check category usage' })
    }

    if (row.count > 0) {
      return res.status(400).json({
        error: 'Category is in use by one or more parts. Reassign those parts first.'
      })
    }

    db.get('SELECT COUNT(*) AS count FROM categories WHERE parentId = ?', [id], (childErr, childRow) => {
      if (childErr) {
        console.error(childErr)
        return res.status(500).json({ error: 'Failed to check child categories' })
      }

      if (childRow.count > 0) {
        return res.status(400).json({
          error: 'Category has child categories. Delete or move those first.'
        })
      }

      db.run('DELETE FROM categories WHERE id = ?', [id], function (err) {
        if (err) {
          console.error(err)
          return res.status(500).json({ error: 'Failed to delete category' })
        }

        writeAudit(req, 'delete', 'category', id, { deleted: this.changes })
        res.json({ success: true, deleted: this.changes })
      })
    })
  })
})

app.get('/api/backup', (req, res) => {
  createDatabaseBackup('manual-backup', (err, backupPath) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create backup' });
    }

    res.download(backupPath, path.basename(backupPath));
  });
});

app.post('/api/restore', (req, res) => {
  const { dataUrl } = req.body;
  const match = String(dataUrl || '').match(/^data:.*?;base64,(.+)$/);

  if (!match) {
    return res.status(400).json({ error: 'Backup file required' });
  }

  const safetyPath = path.join(backupDir, timestampName('before-restore', 'db'));
  const incomingPath = path.join(backupDir, timestampName('uploaded-restore', 'db'));

  fs.copyFile(dbPath, safetyPath, (backupErr) => {
    if (backupErr) {
      console.error(backupErr);
      return res.status(500).json({ error: 'Failed to create safety backup' });
    }

    fs.writeFile(incomingPath, match[1], 'base64', (writeErr) => {
      if (writeErr) {
        console.error(writeErr);
        return res.status(500).json({ error: 'Failed to read restore file' });
      }

      db.close((closeErr) => {
        if (closeErr) {
          console.error(closeErr);
          return res.status(500).json({ error: 'Failed to close database for restore' });
        }

        fs.copyFile(incomingPath, dbPath, (restoreErr) => {
          if (restoreErr) {
            console.error(restoreErr);
            return res.status(500).json({ error: 'Failed to restore database' });
          }

          res.json({
            success: true,
            message: 'Database restored. Restart the server now.',
            safetyBackup: path.basename(safetyPath)
          });
        });
      });
    });
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
