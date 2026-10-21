import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inheritedBlockers, treeLinks } from '../../src/sources/github-tree.js';
import type { GhBlockerRef, GhItemNode, GhSubIssue } from '../../src/sources/github-queries.js';
import { itemNode, T1 } from '../read-model/fixtures.js';

// #424: issue n (item PVTI_<n>, issue node I_<n>) with its sub-issues and the issues blocking it, as the items read asks them
const ref = (number: number, state: GhBlockerRef['state'] = 'OPEN'): GhBlockerRef => ({ number, title: `T${number}`, state, repository: { nameWithOwner: 'acme/r' } });
const issue = (n: number, subIssues: number[] = [], blockedBy: GhBlockerRef[] = []): GhItemNode => itemNode(n, 'Ready', T1, {
  subIssuesSummary: { total: subIssues.length, completed: 0 },
  subIssues: { nodes: subIssues.map((s): GhSubIssue => ({ id: `I_${s}`, number: s, state: 'OPEN' })) },
  blockedBy: { nodes: blockedBy },
});
const inheritedOf = (nodes: GhItemNode[]) => inheritedBlockers(nodes, treeLinks(nodes));

test('inheritedBlockers gives every descendant its ancestors\' open blockers, nearest ancestor first, each id once; a closed blocker and the sub-issues pass nothing (#424)', () => {
  // 1 → 2 → 3; 1 is blocked by an open #20, a closed #21 and an open #30; 2 by an open #30
  const inherited = inheritedOf([issue(1, [2], [ref(20), ref(21, 'CLOSED'), ref(30)]), issue(2, [3], [ref(30)]), issue(3)]);
  assert.deepEqual(inherited.get('PVTI_3'), [{ id: '30', via: '2' }, { id: '20', via: '1' }], '#30 once, at its nearest ancestor');
  assert.deepEqual(inherited.get('PVTI_2'), [{ id: '20', via: '1' }, { id: '30', via: '1' }]);
  assert.equal(inherited.has('PVTI_1'), false, 'a root inherits nothing: its own blockers are blockedBy');
});

test('inheritedBlockers drops a blocker that is the node itself or one of its descendants; a sibling and a sibling\'s subtree still block (#424)', () => {
  // 1 lists 2 and 4; 2 lists 3; 1 is blocked by its grandchild #3 and its child #4
  const inherited = inheritedOf([issue(1, [2, 4], [ref(3), ref(4)]), issue(2, [3]), issue(3), issue(4)]);
  assert.deepEqual(inherited.get('PVTI_2'), [{ id: '4', via: '1' }], '#3 is 2\'s own child');
  assert.deepEqual(inherited.get('PVTI_3'), [{ id: '4', via: '1' }], '#3 never waits for itself');
  assert.deepEqual(inherited.get('PVTI_4'), [{ id: '3', via: '1' }], 'the sibling\'s subtree still holds 4');
});

test('inheritedBlockers ends on a cycle the wire carries (#424)', () => {
  // 1 lists 2 and 2 lists 1: each is the other's parent
  const inherited = inheritedOf([issue(1, [2], [ref(9)]), issue(2, [1], [ref(8)])]);
  assert.deepEqual(inherited.get('PVTI_1'), [{ id: '8', via: '2' }]);
  assert.deepEqual(inherited.get('PVTI_2'), [{ id: '9', via: '1' }]);
});
