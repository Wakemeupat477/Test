import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderMessage, ProviderPage, LinkRow } from './types.mts';

export type SyncState = {
  cursor: string | null;
  completed: boolean;
  candidate: string | null;
  pages: number;
};

function normalizeCandidate(value: string): string {
  return value.trim().toLowerCase();
}

export function openDatabase(path: string, readOnly = false): DatabaseSync {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly, timeout: 10_000 });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const migrations: Array<{ version: number; sql: string }> = [
    {
      version: 1,
      sql: `
        CREATE TABLE messages (
          external_id TEXT PRIMARY KEY,
          sent_at TEXT NOT NULL,
          subject TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipients_json TEXT NOT NULL,
          thread_key TEXT NOT NULL DEFAULT '',
          parent_id TEXT NULL
        ) STRICT;

        CREATE TABLE message_links (
          message_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          target_id TEXT NOT NULL,
          PRIMARY KEY (message_id, position),
          FOREIGN KEY (message_id) REFERENCES messages(external_id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX idx_message_links_target_id ON message_links(target_id);

        CREATE TABLE sync_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          cursor TEXT NULL,
          completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
          candidate TEXT NULL,
          pages INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO sync_state(singleton, cursor, completed, candidate, pages, updated_at)
        VALUES (1, NULL, 0, NULL, 0, CURRENT_TIMESTAMP);
      `,
    },
  ];

  for (const migration of migrations) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      // Re-check after acquiring the write lock. This makes first-start migrations
      // safe when two workers are started against the same empty database.
      const alreadyApplied = db.prepare(
        'SELECT 1 AS present FROM schema_migrations WHERE version = ?',
      ).get(migration.version) as { present: number } | undefined;
      if (!alreadyApplied) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }
      db.exec('COMMIT;');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  }
}

export function bindCandidate(db: DatabaseSync, candidate: string): string {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) throw new Error('CANDIDATE is empty');

  db.exec('BEGIN IMMEDIATE;');
  try {
    const row = db.prepare('SELECT candidate FROM sync_state WHERE singleton = 1').get() as
      | { candidate: string | null }
      | undefined;
    if (!row) throw new Error('sync_state is missing');

    if (row.candidate === null) {
      db.prepare('UPDATE sync_state SET candidate = ?, updated_at = ? WHERE singleton = 1')
        .run(normalized, new Date().toISOString());
    } else if (normalizeCandidate(row.candidate) !== normalized) {
      throw new Error(
        `Database belongs to CANDIDATE=${row.candidate}. Run "docker compose down -v" before changing CANDIDATE.`,
      );
    }
    db.exec('COMMIT;');
    return normalized;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function getSyncState(db: DatabaseSync): SyncState {
  const row = db.prepare(
    'SELECT cursor, completed, candidate, pages FROM sync_state WHERE singleton = 1',
  ).get() as { cursor: string | null; completed: number; candidate: string | null; pages: number } | undefined;

  if (!row) throw new Error('sync_state is missing');
  return {
    cursor: row.cursor,
    completed: row.completed === 1,
    candidate: row.candidate,
    pages: Number(row.pages),
  };
}

function sameCursor(a: string | null, b: string | null): boolean {
  return a === b;
}

/**
 * Atomically stores a page and advances the checkpoint.
 * Returns false when another worker already advanced this cursor.
 */
export function persistPage(
  db: DatabaseSync,
  requestedCursor: string | null,
  page: ProviderPage,
): boolean {
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages(external_id, sent_at, subject, sender, recipients_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO message_links(message_id, position, target_id)
    VALUES (?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE;');
  try {
    const current = getSyncState(db);
    if (current.completed || !sameCursor(current.cursor, requestedCursor)) {
      db.exec('ROLLBACK;');
      return false;
    }

    for (const message of page.items) {
      validateMessage(message);
      insertMessage.run(
        message.message_id,
        message.sent_at,
        message.subject,
        message.from,
        JSON.stringify(message.to),
      );

      const references = Array.isArray(message.references) ? message.references : [];
      const orderedLinks = [...references];
      if (message.in_reply_to) orderedLinks.push(message.in_reply_to);
      for (let i = 0; i < orderedLinks.length; i++) {
        const target = orderedLinks[i];
        if (typeof target === 'string' && target.length > 0) {
          insertLink.run(message.message_id, i, target);
        }
      }
    }

    db.prepare(`
      UPDATE sync_state
      SET cursor = ?, completed = ?, pages = pages + 1, updated_at = ?
      WHERE singleton = 1
    `).run(page.next_cursor, page.next_cursor === null ? 1 : 0, new Date().toISOString());

    db.exec('COMMIT;');
    return true;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw error;
  }
}

function validateMessage(message: ProviderMessage): void {
  if (!message || typeof message !== 'object') throw new Error('Provider returned a non-object message');
  for (const field of ['message_id', 'subject', 'from', 'sent_at'] as const) {
    if (typeof message[field] !== 'string') throw new Error(`Invalid message field: ${field}`);
  }
  if (!Array.isArray(message.to) || !message.to.every((v) => typeof v === 'string')) {
    throw new Error('Invalid message field: to');
  }
  if (message.references != null && (!Array.isArray(message.references) || !message.references.every((v) => typeof v === 'string'))) {
    throw new Error('Invalid message field: references');
  }
  if (message.in_reply_to != null && typeof message.in_reply_to !== 'string') {
    throw new Error('Invalid message field: in_reply_to');
  }
}

export function loadGraph(db: DatabaseSync): { ids: string[]; links: LinkRow[] } {
  const messageRows = db.prepare('SELECT external_id FROM messages ORDER BY external_id')
    .all() as Array<{ external_id: string }>;
  const ids = messageRows.map((row) => String(row.external_id));

  const linkRows = db.prepare(`
    SELECT message_id, position, target_id
    FROM message_links
    ORDER BY message_id, position
  `).all() as Array<{ message_id: string; position: number | bigint; target_id: string }>;
  const links = linkRows.map((row) => ({
    message_id: String(row.message_id),
    position: Number(row.position),
    target_id: String(row.target_id),
  }));

  return { ids, links };
}
