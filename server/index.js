require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    supplier: String(body.supplier || '').trim(),
    supplierSku: String(body.supplierSku || '').trim(),
    fitment: String(body.fitment || '').trim(),
    notes: String(body.notes || '').trim(),
    imageUrl: String(body.imageUrl || '').trim()
  };
}

function ensureSchema() {
  db.all('PRAGMA table_info(parts)', [], (err, columns) => {
    if (err) {
      console.error('Failed to inspect parts schema', err);
      return;
    }

    const names = columns.map((column) => column.name);
    if (!names.includes('imageUrl')) {
      db.run('ALTER TABLE parts ADD COLUMN imageUrl TEXT', [], (alterErr) => {
        if (alterErr) console.error('Failed to add imageUrl column', alterErr);
      });
    }
  });

  db.all('PRAGMA table_info(transactions)', [], (err, columns) => {
    if (err) {
      console.error('Failed to inspect transactions schema', err);
      return;
    }

    const names = columns.map((column) => column.name);
    if (!names.includes('note')) {
      db.run('ALTER TABLE transactions ADD COLUMN note TEXT', [], (alterErr) => {
        if (alterErr) console.error('Failed to add transaction note column', alterErr);
      });
    }
  });
}

ensureSchema();

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

app.post('/api/parts', (req, res) => {
  const part = normalizePart(req.body);

  if (!part.name) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.run(
    `INSERT INTO parts (
      name, brand, partNumber, internalCode, barcode,
      categoryId, locationId, type, condition, quantity, unit,
      reorderThreshold, reorderQty, supplier, supplierSku, fitment, notes, imageUrl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    partFields.map((field) => part[field]),
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to add part' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.post('/api/parts/:id/checkout', (req, res) => {
  const id = req.params.id;
  const qty = Number(req.body.qty || 1);
  const note = String(req.body.note || '').trim();

  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be greater than zero' });
  }

  db.get('SELECT quantity FROM parts WHERE id = ?', [id], (err, row) => {
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
        'INSERT INTO transactions (partId, type, qtyChange, note) VALUES (?, ?, ?, ?)',
        [id, 'checkout', -actualQty, note]
      );

      res.json({ success: true, quantity: newQty });
    });
  });
});

app.post('/api/parts/:id/return', (req, res) => {
  const id = req.params.id;
  const qty = Number(req.body.qty || 1);
  const note = String(req.body.note || '').trim();

  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be greater than zero' });
  }

  db.get('SELECT quantity FROM parts WHERE id = ?', [id], (err, row) => {
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
        'INSERT INTO transactions (partId, type, qtyChange, note) VALUES (?, ?, ?, ?)',
        [id, 'return', qty, note]
      );

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

app.post('/api/locations', (req, res) => {
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
      res.json({ id: this.lastID });
    }
  );
});

app.patch('/api/transactions/:id', (req, res) => {
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

    res.json({ success: true });
  });
});

app.delete('/api/transactions/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM transactions WHERE id = ?', [id], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete transaction' });
    }

    res.json({ success: true, deleted: this.changes });
  });
});

app.put('/api/locations/:id', (req, res) => {
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

      res.json({ success: true });
    }
  );
});

app.post('/api/parts/import', (req, res) => {
  const rows = Array.isArray(req.body.parts) ? req.body.parts : [];
  const cleaned = rows.map(normalizePart).filter((part) => part.name);

  if (cleaned.length === 0) {
    return res.status(400).json({ error: 'No valid parts to import' });
  }

  const stmt = db.prepare(
    `INSERT INTO parts (
      name, brand, partNumber, internalCode, barcode,
      categoryId, locationId, type, condition, quantity, unit,
      reorderThreshold, reorderQty, supplier, supplierSku, fitment, notes, imageUrl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

        res.json({ success: true, imported: cleaned.length });
      });
    });
  });
});

app.put('/api/parts/:id', (req, res) => {
  const id = req.params.id;
  const part = normalizePart(req.body);

  if (!part.name) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.run(
    `UPDATE parts SET
      name = ?, brand = ?, partNumber = ?, internalCode = ?, barcode = ?,
      categoryId = ?, locationId = ?, type = ?, condition = ?, quantity = ?, unit = ?,
      reorderThreshold = ?, reorderQty = ?, supplier = ?, supplierSku = ?, fitment = ?,
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

      res.json({ success: true });
    }
  );
});

app.delete('/api/parts/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM parts WHERE id = ?', [id], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete part' });
    }

    res.json({ success: true, deleted: this.changes });
  });
});

app.post('/api/uploads/image', (req, res) => {
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

app.delete('/api/locations/:id', (req, res) => {
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

app.post('/api/categories', (req, res) => {
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
      res.json({ id: this.lastID });
    }
  );
});

app.put('/api/categories/:id', (req, res) => {
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

      res.json({ success: true });
    }
  );
});

app.delete('/api/categories/:id', (req, res) => {
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
