import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Money is always stored as integer cents to avoid floating point errors.
-- The CHECK constraint is a last line of defence against overdrafts.
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  account_number TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL CHECK (type IN ('checking','savings')),
  balance_cents  INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

-- Append-only ledger. A transfer writes two rows sharing one reference.
CREATE TABLE IF NOT EXISTS transactions (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id                  INTEGER NOT NULL REFERENCES accounts(id),
  type                        TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','transfer_in','transfer_out')),
  amount_cents                INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents         INTEGER NOT NULL,
  description                 TEXT,
  counterparty_account_number TEXT,
  reference                   TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, id DESC);

-- Lets mobile clients safely retry a transfer after a network failure.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (key, user_id)
);
`;

export function openDb(path = './data/bank.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside an atomic SQLite transaction (all-or-nothing). */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
