import crypto from "node:crypto";
import type { ExportRecord, MessageRow } from "./types";

/**
 * Disjoint-set over arbitrary string ids. Nodes are created lazily on first
 * touch. Links point at raw message-id strings from `references` /
 * `in_reply_to`, whether or not a message with that id was ever fetched:
 * that's what lets two threads merge correctly even when the message that
 * bridges them is missing from the feed (see the A/B + C/D + E example in
 * the task brief).
 */
class DisjointSet {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  private ensure(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    this.ensure(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

interface ParsedMessage {
  external_id: string;
  in_reply_to: string | null;
  references: string[];
  subject: string | null;
  sent_at: string | null;
}

function parseRow(row: MessageRow): ParsedMessage {
  let references: string[] = [];
  try {
    const parsed = JSON.parse(row.references_json);
    if (Array.isArray(parsed)) references = parsed.filter((x) => typeof x === "string");
  } catch {
    references = [];
  }
  return {
    external_id: row.external_id,
    in_reply_to: row.in_reply_to || null,
    references,
    subject: row.subject,
    sent_at: row.sent_at,
  };
}

/**
 * Links used for grouping: all `references` entries plus `in_reply_to`,
 * order doesn't matter here since union() is symmetric.
 */
function linksOf(m: ParsedMessage): string[] {
  const links = [...m.references];
  if (m.in_reply_to) links.push(m.in_reply_to);
  return links;
}

/**
 * parent_id rule: take references (in original order) then in_reply_to
 * appended last, walk that combined list from the end backwards, and return
 * the first id that corresponds to a message actually present in the feed.
 * This checks in_reply_to first (it's last in the list), then falls back to
 * the closest reference, then earlier ones. Empty string if nothing matches.
 */
function resolveParentId(m: ParsedMessage, existingIds: ReadonlySet<string>): string {
  const list = [...m.references];
  if (m.in_reply_to) list.push(m.in_reply_to);
  for (let i = list.length - 1; i >= 0; i--) {
    if (existingIds.has(list[i])) return list[i];
  }
  return "";
}

function threadKeyFor(memberIds: string[]): string {
  // Deterministic key derived from the group's smallest external_id, so
  // re-running the exporter against unchanged data yields stable keys
  // (not required by the spec, but a cheap and useful property).
  const min = memberIds.slice().sort()[0];
  const hash = crypto.createHash("sha1").update(min).digest("hex").slice(0, 16);
  return `t-${hash}`;
}

export function computeThreads(rows: MessageRow[]): ExportRecord[] {
  const messages = rows.map(parseRow);
  const existingIds = new Set(messages.map((m) => m.external_id));

  const dsu = new DisjointSet();
  for (const m of messages) {
    dsu.find(m.external_id); // ensure it exists even with no links
    for (const link of linksOf(m)) {
      dsu.union(m.external_id, link);
    }
  }

  const groups = new Map<string, string[]>();
  for (const m of messages) {
    const root = dsu.find(m.external_id);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(m.external_id);
  }

  const threadKeyByRoot = new Map<string, string>();
  for (const [root, memberIds] of groups) {
    threadKeyByRoot.set(root, threadKeyFor(memberIds));
  }

  return messages.map((m) => {
    const root = dsu.find(m.external_id);
    return {
      external_id: m.external_id,
      thread_key: threadKeyByRoot.get(root)!,
      parent_id: resolveParentId(m, existingIds),
      sent_at: m.sent_at,
      subject: m.subject,
    };
  });
}
