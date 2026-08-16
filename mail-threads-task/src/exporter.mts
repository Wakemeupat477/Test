import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getSyncState, openDatabase } from './db.mts';

const dbPath = process.env.DB_PATH ?? '/data/mail.db';
const outputPath = process.env.OUTPUT_PATH ?? '/out/result.jsonl';
const db = openDatabase(dbPath, true);

try {
  const state = getSyncState(db);
  if (!state.completed) throw new Error('Feed is not fully downloaded yet; run worker first');

  const rows = db.prepare(`
    SELECT external_id, thread_key, parent_id, sent_at, subject
    FROM messages
    ORDER BY external_id
  `).all() as Array<{
    external_id: string;
    thread_key: string;
    parent_id: string | null;
    sent_at: string;
    subject: string;
  }>;

  const unfinished = rows.find((row) => !row.thread_key);
  if (unfinished) throw new Error(`Threading is not complete for ${unfinished.external_id}`);

  mkdirSync(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp`;
  const body = rows.map((row) => JSON.stringify({
    external_id: row.external_id,
    thread_key: row.thread_key,
    parent_id: row.parent_id ?? '',
    sent_at: row.sent_at,
    subject: row.subject,
  })).join('\n') + (rows.length ? '\n' : '');

  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, outputPath);
  console.log(`[exporter] wrote ${rows.length} messages to ${outputPath}`);
} catch (error) {
  console.error('[exporter] fatal:', error);
  process.exitCode = 1;
} finally {
  db.close();
}
