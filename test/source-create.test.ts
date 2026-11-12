import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateRefusedError, IssuePlacementError } from '../src/source-create.js';

test('a create refusal and a placement failure are Errors told apart by class; the placement one carries the issue that exists (#767)', () => {
  const issue = { number: 9, url: 'https://github.com/acme/app/issues/9' };
  const placed = new IssuePlacementError(`issue ${issue.url} was created but not labeled or placed on the Project: down`, issue);
  const refused = new CreateRefusedError('"Done" is not a Status option: Todo');
  assert.ok(placed instanceof Error && refused instanceof Error);
  assert.equal(refused instanceof IssuePlacementError, false);
  assert.deepEqual([placed.issue, placed.message.includes(issue.url)], [issue, true]);
});
