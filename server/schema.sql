CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parentId INTEGER
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT,
  parentId INTEGER
);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  partNumber TEXT,
  internalCode TEXT,
  barcode TEXT,
  categoryId INTEGER,
  locationId INTEGER,
  type TEXT,
  condition TEXT,
  quantity INTEGER DEFAULT 0,
  unit TEXT DEFAULT 'each',
  reorderThreshold INTEGER DEFAULT 0,
  reorderQty INTEGER DEFAULT 0,
  supplier TEXT,
  supplierSku TEXT,
  fitment TEXT,
  notes TEXT,
  imageUrl TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partId INTEGER,
  type TEXT,
  qtyChange INTEGER,
  note TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
