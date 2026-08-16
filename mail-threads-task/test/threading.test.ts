import test from "node:test";
import assert from "node:assert/strict";
import { computeThreads } from "../src/threading";
import type { MessageRow } from "../src/types";

function row(
  external_id: string,
  in_reply_to: string | null,
  references: string[],
  sent_at = "2025-01-01T00:00:00.000Z"
): MessageRow {
  return {
    external_id,
    in_reply_to,
    references_json: JSON.stringify(references),
    subject: `subject of ${external_id}`,
    from_addr: null,
    to_addr: null,
    sent_at,
  };
}

test("merges two independent threads once a later message bridges them (A/B, C/D, E example from the brief)", () => {
  const rows: MessageRow[] = [
    row("A", null, []),
    row("B", "A", ["A"]),
    row("D", null, []),
    row("C", "D", ["D"]),
    row("E", null, ["B", "D"]),
  ];

  const records = computeThreads(rows);
  const byId = Object.fromEntries(records.map((r) => [r.external_id, r]));

  const keys = new Set(records.map((r) => r.thread_key));
  assert.equal(keys.size, 1, "all five messages should end up in a single conversation");
  assert.equal(byId.A.thread_key, byId.B.thread_key);
  assert.equal(byId.B.thread_key, byId.C.thread_key);
  assert.equal(byId.C.thread_key, byId.D.thread_key);
  assert.equal(byId.D.thread_key, byId.E.thread_key);
});

test("keeps unrelated messages in separate conversations", () => {
  const rows: MessageRow[] = [row("X", null, []), row("Y", null, [])];
  const records = computeThreads(rows);
  const byId = Object.fromEntries(records.map((r) => [r.external_id, r]));
  assert.notEqual(byId.X.thread_key, byId.Y.thread_key);
});

test("parent_id prefers in_reply_to over references", () => {
  const rows: MessageRow[] = [row("P1", null, []), row("P2", null, []), row("C", "P2", ["P1", "P2"])];
  const records = computeThreads(rows);
  const c = records.find((r) => r.external_id === "C")!;
  assert.equal(c.parent_id, "P2");
});

test("parent_id falls back to the last reference when in_reply_to is missing", () => {
  const rows: MessageRow[] = [row("R1", null, []), row("R2", null, []), row("C", null, ["R1", "R2"])];
  const records = computeThreads(rows);
  const c = records.find((r) => r.external_id === "C")!;
  assert.equal(c.parent_id, "R2");
});

test("parent_id falls back to an earlier reference when the closer ones point outside the feed", () => {
  const rows: MessageRow[] = [
    row("R1", null, []),
    row("C", "GHOST_PARENT", ["R1", "GHOST1", "GHOST2"]),
  ];
  const records = computeThreads(rows);
  const c = records.find((r) => r.external_id === "C")!;
  assert.equal(c.parent_id, "R1");
});

test("parent_id is empty string when no link resolves to a present message", () => {
  const rows: MessageRow[] = [row("C", "GHOST", ["ALSO_GHOST"])];
  const records = computeThreads(rows);
  const c = records.find((r) => r.external_id === "C")!;
  assert.equal(c.parent_id, "");
});

test("a thread can be bridged through a message missing from the feed", () => {
  const rows: MessageRow[] = [row("B", "MISSING", ["MISSING"]), row("F", null, ["MISSING"])];
  const records = computeThreads(rows);
  const byId = Object.fromEntries(records.map((r) => [r.external_id, r]));
  assert.equal(byId.B.thread_key, byId.F.thread_key);
});

