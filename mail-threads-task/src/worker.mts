import { applyMigrations, bindCandidate, getSyncState, loadGraph, openDatabase, persistPage } from './db.mts';
import { fetchPage } from './provider.mts';
import { buildAssignments } from './threading.mts';

const dbPath = process.env.DB_PATH ?? '/data/mail.db';
const providerUrl = process.env.PROVIDER_URL ?? 'http://provider:8080';
const candidate = process.env.CANDIDATE;

if (!candidate) {
  console.error('CANDIDATE is required');
  process.exit(2);
}

const db = openDatabase(dbPath);

try {
  applyMigrations(db);
  bindCandidate(db, candidate);

  for (;;) {
    const state = getSyncState(db);
    if (state.completed) break;

    const page = await fetchPage(providerUrl, state.cursor);
    const committed = persistPage(db, state.cursor, page);
    if (!committed) {
      console.log('[worker] checkpoint advanced by another worker; discarding stale page');
      continue;
    }

    const newState = getSyncState(db);
    console.log(
      `[worker] page ${newState.pages}: received=${page.items.length}, next=${page.next_cursor === null ? 'END' : 'cursor'}`,
    );
  }

  const { ids, links } = loadGraph(db);
  console.log(`[worker] feed complete: ${ids.length} unique messages, ${links.length} links`);

  const assignments = buildAssignments(ids, links);
  const update = db.prepare('UPDATE messages SET thread_key = ?, parent_id = ? WHERE external_id = ?');

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const [id, assignment] of assignments) {
      update.run(assignment.threadKey, assignment.parentId, id);
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  const threadCount = new Set([...assignments.values()].map((v) => v.threadKey)).size;
  console.log(`[worker] threading complete: ${threadCount} conversations`);
} catch (error) {
  console.error('[worker] fatal:', error);
  process.exitCode = 1;
} finally {
  db.close();
}
