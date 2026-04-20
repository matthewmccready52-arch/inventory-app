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
  unitCost REAL DEFAULT 0,
  retailPrice REAL DEFAULT 0,
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
  workorderRef TEXT,
  customerRef TEXT,
  equipmentRef TEXT,
  unitCost REAL DEFAULT 0,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'tech',
  pinHash TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER,
  userName TEXT,
  action TEXT NOT NULL,
  entityType TEXT,
  entityId INTEGER,
  details TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
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
);
