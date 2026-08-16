import { openDb } from "./db";
import { ProviderClient } from "./provider-client";
import type { ProviderMessage } from "./types";

interface IngestState {
  next_cursor: string | null;
  completed: number;
  pages_fetched: number;
}

async function main(): Promise<void> {
  const providerUrl = process.env.PROVIDER_URL || "http://localhost:8080";
  const pageLimit = Number(process.env.PAGE_LIMIT || 200);

  const db = openDb();
  const client = new ProviderClient({ baseUrl: providerUrl });

  const getState = db.prepare<[], IngestState>(
    `SELECT next_cursor, completed, pages_fetched FROM ingest_state WHERE id = 1`
  );
  const setState = db.prepare(
    `UPDATE ingest_state
     SET next_cursor = ?, completed = ?, pages_fetched = pages_fetched + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`
  );

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
      (external_id, in_reply_to, references_json, subject, from_addr, to_addr, sent_at)
    VALUES (@external_id, @in_reply_to, @references_json, @subject, @from_addr, @to_addr, @sent_at)
  `);

  const state = getState.get();
  if (!state) throw new Error("ingest_state row missing after migrations, this should not happen");

  if (state.completed) {
    console.log(`[worker] feed already fully ingested (${state.pages_fetched} pages previously). Nothing to do.`);
    db.close();
    return;
  }

  let cursor = state.next_cursor;
  let pagesThisRun = 0;
  let messagesSeenThisRun = 0;

  console.log(`[worker] starting from cursor=${cursor ?? "<beginning>"} (page limit ${pageLimit})`);

  for (;;) {
    const page = await client.fetchPage(cursor, pageLimit);
    const nextCursor = page.next_cursor;
    const done = nextCursor === null;

    // Insert the page and advance the cursor atomically: either the whole
    // page is committed together with the new cursor, or (on crash) none of
    // it is, and the same page is simply re-fetched on restart. Because
    // external_id is the primary key, re-inserting an already-seen message
    // (from a re-fetched page, or a genuine duplicate the feed sent) is a
    // no-op via INSERT OR IGNORE, so this is safe to repeat any number of times.
    const applyPage = db.transaction((items: ProviderMessage[]) => {
      for (const item of items) {
        insertMessage.run({
          external_id: item.message_id,
          in_reply_to: item.in_reply_to ?? null,
          references_json: JSON.stringify(item.references ?? []),
          subject: item.subject ?? null,
          from_addr: item.from ?? null,
          to_addr: JSON.stringify(item.to ?? []),
          sent_at: item.sent_at ?? null,
        });
      }
      setState.run(nextCursor, done ? 1 : 0);
    });
    applyPage(page.items);

    pagesThisRun += 1;
    messagesSeenThisRun += page.items.length;
    cursor = nextCursor;

    if (pagesThisRun % 10 === 0 || done) {
      console.log(`[worker] pages=${pagesThisRun} messages_seen=${messagesSeenThisRun} done=${done}`);
    }

    if (done) break;
  }

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
  console.log(`[worker] feed fully drained. ${totalRow.n} distinct messages stored.`);
  db.close();
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});
