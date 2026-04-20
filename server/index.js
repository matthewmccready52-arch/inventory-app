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
}

ensureSchema();
app.use(resolveUser);

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

// PARTS
app.get('/api/parts', (req, res) => {
  db.all('SELECT * FROM parts ORDER BY name ASC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load parts' });
    }
    res.json(rows);
  });
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
