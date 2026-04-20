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

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS equipment (
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
);

CREATE TABLE IF NOT EXISTS workorders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  customerId INTEGER,
  equipmentId INTEGER,
  complaint TEXT,
  diagnosis TEXT,
  laborNotes TEXT,
  laborHours REAL DEFAULT 0,
  laborRate REAL DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workorder_parts (
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
);
