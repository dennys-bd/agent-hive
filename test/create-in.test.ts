import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceFields } from '../src/types.js';
import { canCreate, createInProblem, hasIssueTypes, sourceTypeName } from '../src/create-in.js';

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

test('a jira source can take new tasks, so createIn may name it (#831)', () => {
  assert.equal(canCreate({ type: 'jira' }), true);
  assert.equal(createInProblem({ hiveSource: true, createIn: 'tickets', sources: [{ name: 'tickets', type: 'jira' }] }), undefined);
});

test('only a jira source has issue types, and each type is named in a log line (#831)', () => {
  assert.deepEqual([hasIssueTypes('jira'), hasIssueTypes('github'), hasIssueTypes('tracker')], [true, false, false]);
  assert.deepEqual([sourceTypeName('github'), sourceTypeName('jira'), sourceTypeName(undefined), sourceTypeName('tracker')], ['GitHub', 'Jira', 'the source', 'the source']);
});
