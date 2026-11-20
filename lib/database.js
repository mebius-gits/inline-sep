import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seedMenu } from './menu.js';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, is_open INTEGER NOT NULL DEFAULT 1 CHECK(is_open IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS menu (
      id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
      price INTEGER NOT NULL CHECK(price BETWEEN 1 AND 10000), image TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES rounds(id), student_id TEXT NOT NULL,
      total INTEGER NOT NULL CHECK(total BETWEEN 1 AND 150), note TEXT NOT NULL DEFAULT '',
      request_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_student_per_round ON orders(round_id,student_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), menu_id INTEGER NOT NULL REFERENCES menu(id),
      name TEXT NOT NULL, unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20)
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `);
  // Seed exactly once: administrator changes survive restarts.
  if (!db.prepare("SELECT value FROM settings WHERE key='menu_seeded'").get()) {
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO menu(id,category,name,price,image,sort_order) VALUES(?,?,?,?,?,?)');
      for (const m of seedMenu) insert.run(m.id, m.category, m.name, m.price, m.image, m.sort_order);
      db.prepare("INSERT INTO settings(key,value) VALUES('menu_seeded','1')").run();
    });
  }
  if (!db.prepare('SELECT id FROM rounds LIMIT 1').get()) db.prepare('INSERT INTO rounds(title) VALUES(?)').run('師園鹽酥雞・一起訂餐');
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
