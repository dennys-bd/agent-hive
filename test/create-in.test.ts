import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceFields } from '../src/types.js';
import { canCreate, createInProblem } from '../src/create-in.js';

test('canCreate: a GitHub source can create only with a repository for new issues (#811)', () => {
  assert.equal(canCreate({ type: 'github', repository: 'acme/app' }), true);
  assert.equal(canCreate({ type: 'github' }), false);
});

test('createInProblem answers cannotCreate for a source canCreate refuses, and passes one an injected predicate accepts (#811)', () => {
  const bare = { name: 'work', type: 'github' as const };
  assert.equal(createInProblem({ hiveSource: true, createIn: 'work', sources: [bare] }), 'settings.error.createIn.cannotCreate');
  assert.equal(createInProblem({ hiveSource: true, createIn: 'work', sources: [{ ...bare, repository: 'acme/app' }] }), undefined);
  const tracker = { name: 'tracker', type: 'tracker' as unknown as SourceFields['type'] };
  assert.equal(createInProblem({ hiveSource: true, createIn: 'tracker', sources: [tracker] }, (s) => (s.type as string) === 'tracker'), undefined);
});

test('a jira source cannot take new tasks yet, so createIn may not name it (#820)', () => {
  assert.equal(canCreate({ type: 'jira' }), false);
  assert.equal(createInProblem({ hiveSource: true, createIn: 'tickets', sources: [{ name: 'tickets', type: 'jira' }] }), 'settings.error.createIn.cannotCreate');
});
