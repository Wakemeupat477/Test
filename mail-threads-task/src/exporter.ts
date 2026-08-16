import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db";
import { computeThreads } from "./threading";
import type { MessageRow } from "./types";

function main(): void {
  const outPath = process.env.OUT_PATH || "/out/result.jsonl";

  const db = openDb();
  const rows = db
    .prepare(`SELECT external_id, in_reply_to, references_json, subject, from_addr, to_addr, sent_at FROM messages`)
    .all() as MessageRow[];
  db.close();

  const records = computeThreads(rows);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r));
  fs.writeFileSync(outPath, lines.join("\n") + (lines.length ? "\n" : ""));

  const threadCount = new Set(records.map((r) => r.thread_key)).size;
  console.log(`[exporter] wrote ${records.length} messages across ${threadCount} conversations to ${outPath}`);
}

main();
