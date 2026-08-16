import type { LinkRow, ThreadAssignment } from './types.mts';

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  add(value: string): void {
    if (!this.parent.has(value)) {
      this.parent.set(value, value);
      this.rank.set(value, 0);
    }
  }

  find(value: string): string {
    const p = this.parent.get(value);
    if (p === undefined) throw new Error(`Unknown node: ${value}`);
    if (p === value) return value;
    const root = this.find(p);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;

    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) [ra, rb] = [rb, ra];
    this.parent.set(rb, ra);
    if (rankA === rankB) this.rank.set(ra, rankA + 1);
  }
}

function makeThreadKey(minExternalId: string): string {
  // The lexicographically smallest real message in a component is unique to it,
  // so using it directly avoids any possibility of a hash collision.
  return `t:${minExternalId}`;
}

export function buildAssignments(ids: string[], links: LinkRow[]): Map<string, ThreadAssignment> {
  const present = new Set(ids);
  const uf = new UnionFind();
  for (const id of ids) uf.add(id);

  // Referenced messages may be absent from the feed. We do not create DB records
  // for them, but their identifiers still participate in connectivity: two
  // present messages that both reference the same missing ancestor are connected.
  for (const link of links) {
    if (!present.has(link.message_id)) continue;
    uf.add(link.target_id);
    uf.union(link.message_id, link.target_id);
  }

  const minByRoot = new Map<string, string>();
  for (const id of ids) {
    const root = uf.find(id);
    const current = minByRoot.get(root);
    if (current === undefined || id < current) minByRoot.set(root, id);
  }

  const linksByMessage = new Map<string, LinkRow[]>();
  for (const link of links) {
    let list = linksByMessage.get(link.message_id);
    if (!list) linksByMessage.set(link.message_id, (list = []));
    list.push(link);
  }
  for (const list of linksByMessage.values()) {
    list.sort((a, b) => b.position - a.position);
  }

  const result = new Map<string, ThreadAssignment>();
  for (const id of ids) {
    const root = uf.find(id);
    const minId = minByRoot.get(root);
    if (minId === undefined) throw new Error(`No component key for ${id}`);

    let parentId: string | null = null;
    for (const link of linksByMessage.get(id) ?? []) {
      // A self-reference is not a valid reply parent; the supplied selfcheck
      // treats it as a hard inconsistency.
      if (link.target_id !== id && present.has(link.target_id)) {
        parentId = link.target_id;
        break;
      }
    }

    result.set(id, { threadKey: makeThreadKey(minId), parentId });
  }
  return result;
}
