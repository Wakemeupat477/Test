import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, getSyncState, persistPage } from '../src/db.mts';

test('page and cursor checkpoint are atomic and stale pages cannot overwrite progress', () => {
  const db = new DatabaseSync(':memory:', { timeout: 1000 });
  try {
    applyMigrations(db);

    const page = {
      items: [
        { message_id: 'A', references: [], subject: 'A', from: 'a@x', to: ['b@x'], sent_at: '2025-01-01T00:00:00.000Z' },
        { message_id: 'A', references: [], subject: 'A', from: 'a@x', to: ['b@x'], sent_at: '2025-01-01T00:00:00.000Z' },
      ],
      next_cursor: 'next-1',
    };

    assert.equal(persistPage(db, null, page), true);
    assert.equal(persistPage(db, null, page), false);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n), 1);
    assert.deepEqual(getSyncState(db), {
      cursor: 'next-1', completed: false, candidate: null, pages: 1,
    });
  } finally {
    db.close();
  }
});
