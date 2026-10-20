'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'kanban.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',          -- admin | member | viewer
  active INTEGER NOT NULL DEFAULT 1,
  avatar_color TEXT NOT NULL DEFAULT '#5b6ee1',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  background TEXT NOT NULL DEFAULT '#1d2b3a',
  cycle_start_column_id INTEGER,
  cycle_end_column_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#ebecf0',
  position REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS column_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  collapsed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, column_id)
);

CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS field_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                             -- text | textarea | number | currency | date | datetime | checkbox | select | multiselect | url | email | phone
  options TEXT NOT NULL DEFAULT '[]',             -- JSON (opções de seleção)
  position REAL NOT NULL,
  show_on_card INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES columns(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT,
  position REAL NOT NULL,
  due_date TEXT,
  cover_attachment_id INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',          -- manual | shopify
  external_id TEXT UNIQUE,
  external_url TEXT,
  cycle_started_at TEXT,
  cycle_ended_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, archived, position);

CREATE TABLE IF NOT EXISTS card_labels (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
);

CREATE TABLE IF NOT EXISTS card_members (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, user_id)
);

CREATE TABLE IF NOT EXISTS card_field_values (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
  value TEXT,                                     -- JSON
  PRIMARY KEY (card_id, field_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS card_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  from_column_id INTEGER,
  to_column_id INTEGER NOT NULL,
  user_id INTEGER,
  moved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_card ON card_movements(card_id, moved_at);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER,
  card_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_card ON activity(card_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_board ON activity(board_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, id);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL DEFAULT '{"type":"always"}',
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  position REAL NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_automations_board ON automations(board_id, position);

CREATE TABLE IF NOT EXISTS shopify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL,
  order_id TEXT,
  order_name TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  cards INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_board ON comments(board_id, card_id, id);

CREATE TABLE IF NOT EXISTS notification_log (
  dedupe_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

// Colunas novas em bancos já existentes (dados de envio pelos Correios)
const cardColumns = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
for (const [col, type] of [['shipping_zip', 'TEXT'], ['promised_date', 'TEXT'], ['correios_days', 'INTEGER'], ['correios_service', 'TEXT']]) {
  if (!cardColumns.includes(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}`);
}
// Endereço de origem das imagens baixadas automaticamente (evita anexar a mesma foto duas vezes)
if (!db.prepare('PRAGMA table_info(attachments)').all().some((c) => c.name === 'source_url')) {
  db.exec('ALTER TABLE attachments ADD COLUMN source_url TEXT');
}

// Visual pastel (v2): troca as cores padrão antigas pelas novas, sem tocar nas cores escolhidas pelo usuário
const DEFAULT_BACKGROUND = 'g:aurora';
const DEFAULT_COLUMN_COLOR = '#eef1f8';
const COLOR_UPGRADE = {
  '#1d2b3a': DEFAULT_BACKGROUND, '#ebecf0': DEFAULT_COLUMN_COLOR,
  '#cfe2ff': '#cde7ff', '#e2d9f3': '#dcd3ff', '#ffe5d0': '#ffe5b4', '#fff3cd': '#fff3b0', '#d1ecf1': '#c7f0ec', '#f8d7da': '#ffd6e0', '#d1e7dd': '#d4f8d4',
  '#e5484d': '#ff8f9e', '#d4a72c': '#ffd166', '#a0aec0': '#cbd5e1', '#7c66dc': '#b8a6ff',
};
const OPTION_UPGRADE = { '#d4a72c': '#ffe08a', '#a0aec0': '#e2e8f0', '#e8a598': '#ffd0c2', '#8e9aaf': '#d5dcea' };
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration:pastel'").get()) {
  db.exec('BEGIN');
  for (const [from, to] of Object.entries(COLOR_UPGRADE)) {
    db.prepare('UPDATE boards SET background = ? WHERE lower(background) = ?').run(to, from);
    db.prepare('UPDATE columns SET color = ? WHERE lower(color) = ?').run(to, from);
    db.prepare('UPDATE labels SET color = ? WHERE lower(color) = ?').run(to, from);
  }
  for (const [from, to] of Object.entries(OPTION_UPGRADE)) {
    db.prepare('UPDATE field_defs SET options = replace(options, ?, ?)').run(`"color":"${from}"`, `"color":"${to}"`);
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('migration:pastel', 'true')").run();
  db.exec('COMMIT');
}

function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

const q = {
  get: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
  run: (sql, ...params) => db.prepare(sql).run(...params),
};

function getSetting(key, fallback = null) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setSetting(key, value) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

const now = () => new Date().toISOString();

module.exports = { db, q, transaction, getSetting, setSetting, now, DATA_DIR, UPLOAD_DIR, DEFAULT_BACKGROUND, DEFAULT_COLUMN_COLOR };
