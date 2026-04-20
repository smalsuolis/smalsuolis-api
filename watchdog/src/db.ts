import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { config } from './config';

export interface Subscriber {
  chatId: number;
  username: string | null;
  subscribedAt: string;
}

export interface AlertState {
  key: string;
  lastSentAt: string;
}

let db: Database.Database;

export function initDb(): Database.Database {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id INTEGER PRIMARY KEY,
      username TEXT,
      subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_state (
      key TEXT PRIMARY KEY,
      last_sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_state (
      name TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      down_since TEXT,
      last_alert_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

export function addSubscriber(chatId: number, username: string | null): boolean {
  const stmt = db.prepare(`INSERT OR IGNORE INTO subscribers (chat_id, username) VALUES (?, ?)`);
  const info = stmt.run(chatId, username);
  return info.changes > 0;
}

export function removeSubscriber(chatId: number): boolean {
  const info = db.prepare(`DELETE FROM subscribers WHERE chat_id = ?`).run(chatId);
  return info.changes > 0;
}

export function isSubscribed(chatId: number): boolean {
  const row = db.prepare(`SELECT 1 FROM subscribers WHERE chat_id = ?`).get(chatId);
  return !!row;
}

export function allSubscribers(): Subscriber[] {
  return db
    .prepare(`SELECT chat_id as chatId, username, subscribed_at as subscribedAt FROM subscribers`)
    .all() as Subscriber[];
}

export function subscriberCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM subscribers`).get() as { c: number };
  return row.c;
}

export function getAlertLastSent(key: string): Date | null {
  const row = db
    .prepare(`SELECT last_sent_at as lastSentAt FROM alert_state WHERE key = ?`)
    .get(key) as AlertState | undefined;
  return row ? new Date(row.lastSentAt) : null;
}

export function markAlertSent(key: string): void {
  db.prepare(
    `INSERT INTO alert_state (key, last_sent_at) VALUES (?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET last_sent_at = datetime('now')`,
  ).run(key);
}

export function clearAlert(key: string): void {
  db.prepare(`DELETE FROM alert_state WHERE key = ?`).run(key);
}

export interface ServiceState {
  name: string;
  consecutiveFailures: number;
  downSince: Date | null;
  lastAlertAt: Date | null;
  lastError: string | null;
}

export function getServiceState(name: string): ServiceState {
  const row = db
    .prepare(
      `SELECT name,
              consecutive_failures as consecutiveFailures,
              down_since as downSince,
              last_alert_at as lastAlertAt,
              last_error as lastError
         FROM service_state WHERE name = ?`,
    )
    .get(name) as
    | {
        name: string;
        consecutiveFailures: number;
        downSince: string | null;
        lastAlertAt: string | null;
        lastError: string | null;
      }
    | undefined;

  if (!row) {
    return {
      name,
      consecutiveFailures: 0,
      downSince: null,
      lastAlertAt: null,
      lastError: null,
    };
  }
  return {
    name: row.name,
    consecutiveFailures: row.consecutiveFailures,
    downSince: row.downSince ? new Date(row.downSince) : null,
    lastAlertAt: row.lastAlertAt ? new Date(row.lastAlertAt) : null,
    lastError: row.lastError,
  };
}

export function getKv(key: string): string | null {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteKv(key: string): void {
  db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
}

export function setServiceState(state: ServiceState): void {
  db.prepare(
    `INSERT INTO service_state (name, consecutive_failures, down_since, last_alert_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (name) DO UPDATE SET
       consecutive_failures = excluded.consecutive_failures,
       down_since = excluded.down_since,
       last_alert_at = excluded.last_alert_at,
       last_error = excluded.last_error,
       updated_at = datetime('now')`,
  ).run(
    state.name,
    state.consecutiveFailures,
    state.downSince ? state.downSince.toISOString() : null,
    state.lastAlertAt ? state.lastAlertAt.toISOString() : null,
    state.lastError,
  );
}
