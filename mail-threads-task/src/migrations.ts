import type Database from "better-sqlite3";

/**
 * Migrations are embedded as plain SQL strings rather than read from disk files.
 * This keeps the compiled `dist/` output self-contained (no need to copy a
 * separate migrations folder into the Docker image) and keeps ordering explicit.
 *
 * Each migration is applied at most once, tracked in `schema_migrations`.
 * Both the worker and the exporter call runMigrations() on startup, so the
 * schema is always ready regardless of which service happens to run first.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        external_id    TEXT PRIMARY KEY,
        in_reply_to    TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        subject        TEXT,
        from_addr      TEXT,
        to_addr        TEXT,
        sent_at        TEXT,
        fetched_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_in_reply_to ON messages(in_reply_to);

      -- Single-row table tracking pagination progress, so a restarted worker
      -- resumes from the last successfully committed page instead of
      -- re-walking the whole feed from scratch.
      CREATE TABLE IF NOT EXISTS ingest_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        next_cursor TEXT,
        completed   INTEGER NOT NULL DEFAULT 0,
        pages_fetched INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      INSERT OR IGNORE INTO ingest_state (id, next_cursor, completed) VALUES (1, NULL, 0);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const applied = new Set(
    db.prepare(`SELECT name FROM schema_migrations`).all().map((r: any) => r.name)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO schema_migrations (name) VALUES (?)`).run(migration.name);
    });
    apply();
    console.log(`[migrations] applied ${migration.name}`);
  }
}
