const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'yasser.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  cart TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0f766e',
  currency TEXT NOT NULL DEFAULT 'MAD',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  quantity INTEGER NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',
  in_menu INTEGER NOT NULL DEFAULT 1,
  in_footer INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(store_id, customer_phone);
`);

// Lightweight migrations: add columns introduced after the first release.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
for (const [col, def] of [
  ['logo_url', "TEXT NOT NULL DEFAULT ''"],
  ['banner_url', "TEXT NOT NULL DEFAULT ''"],
  ['tagline', "TEXT NOT NULL DEFAULT ''"],
  ['announcement', "TEXT NOT NULL DEFAULT ''"],
  ['whatsapp', "TEXT NOT NULL DEFAULT ''"],
  ['phone', "TEXT NOT NULL DEFAULT ''"],
  ['email', "TEXT NOT NULL DEFAULT ''"],
  ['instagram', "TEXT NOT NULL DEFAULT ''"],
  ['facebook', "TEXT NOT NULL DEFAULT ''"],
  ['tiktok', "TEXT NOT NULL DEFAULT ''"],
  ['city', "TEXT NOT NULL DEFAULT ''"],
  ['shipping_fee', 'REAL NOT NULL DEFAULT 0'],
  ['free_shipping_over', 'REAL NOT NULL DEFAULT 0'],
]) addColumn('stores', col, def);
addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'merchant'");
addColumn('users', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stores', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stores', 'suspend_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('stores', 'custom_domain', 'TEXT');
addColumn('stores', 'domain_token', "TEXT NOT NULL DEFAULT ''");
addColumn('stores', 'domain_verified', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_domain ON stores(custom_domain) WHERE custom_domain IS NOT NULL');
addColumn('stores', 'home_sections', "TEXT NOT NULL DEFAULT ''");
addColumn('stores', 'font', "TEXT NOT NULL DEFAULT 'tajawal'");
addColumn('stores', 'radius', "TEXT NOT NULL DEFAULT 'soft'");
addColumn('stores', 'header_style', "TEXT NOT NULL DEFAULT 'classic'");
addColumn('products', 'category', "TEXT NOT NULL DEFAULT ''");
addColumn('products', 'compare_price', 'REAL NOT NULL DEFAULT 0');
addColumn('products', 'images', "TEXT NOT NULL DEFAULT '[]'");
addColumn('products', 'options', "TEXT NOT NULL DEFAULT '[]'");
addColumn('products', 'sku', "TEXT NOT NULL DEFAULT ''");
addColumn('products', 'cost_price', 'REAL NOT NULL DEFAULT 0');
addColumn('orders', 'ip', "TEXT NOT NULL DEFAULT ''");
addColumn('orders', 'shipping', 'REAL NOT NULL DEFAULT 0');

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, transaction };
