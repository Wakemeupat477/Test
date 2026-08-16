import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssignments } from '../src/threading.mts';
import type { LinkRow } from '../src/types.mts';

function link(message_id: string, position: number, target_id: string): LinkRow {
  return { message_id, position, target_id };
}

test('a late bridge merges two previously independent conversations', () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const links = [
    link('B', 0, 'A'),
    link('C', 0, 'D'),
    link('E', 0, 'B'),
    link('E', 1, 'D'),
  ];

  const result = buildAssignments(ids, links);
  const keys = new Set([...result.values()].map((x) => x.threadKey));
  assert.equal(keys.size, 1);
  assert.equal(result.get('E')?.parentId, 'D');
});

test('parent walks links backwards and skips references absent from the feed', () => {
  const ids = ['A', 'B', 'X'];
  const links = [
    link('B', 0, 'ghost-old'),
    link('B', 1, 'A'),
    link('B', 2, 'ghost-in-reply-to'),
    link('X', 0, 'ghost-only'),
  ];

  const result = buildAssignments(ids, links);
  assert.equal(result.get('B')?.parentId, 'A');
  assert.equal(result.get('X')?.parentId, null);
  assert.notEqual(result.get('X')?.threadKey, result.get('A')?.threadKey);
});

test('the last present link wins, matching references then in_reply_to ordering', () => {
  const ids = ['A', 'B', 'C'];
  const links = [
    link('C', 0, 'A'),
    link('C', 1, 'B'),
  ];

  const result = buildAssignments(ids, links);
  assert.equal(result.get('C')?.parentId, 'B');
});


test('a shared missing referenced message still connects present messages', () => {
  const ids = ['A', 'B', 'C'];
  const links = [
    link('A', 0, 'missing-root'),
    link('B', 0, 'missing-root'),
  ];

  const result = buildAssignments(ids, links);
  assert.equal(result.get('A')?.threadKey, result.get('B')?.threadKey);
  assert.notEqual(result.get('A')?.threadKey, result.get('C')?.threadKey);
  assert.equal(result.get('A')?.parentId, null);
  assert.equal(result.get('B')?.parentId, null);
});

test('a self-reference is not emitted as parent_id', () => {
  const ids = ['A'];
  const links = [link('A', 0, 'A')];

  const result = buildAssignments(ids, links);
  assert.equal(result.get('A')?.parentId, null);
});
