import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinationOf } from '../src/stage-delete.js';
import type { Stage, Task } from '../src/types.js';

const OLD: Stage[] = ['spec', 'dev', 'qa', 'review', 'done'].map((name) => ({ name, from: {} }));
const at = (column: string, source?: string): Pick<Task, 'item' | 'boardColumn'> =>
  ({ item: { itemId: 'board:1', id: '1', title: 'T', body: '', url: '', ...(source === undefined ? {} : { source }) }, boardColumn: column });
const named = (stages: (Stage | undefined)[]): (string | undefined)[] => stages.map((s) => s?.name);

test('destinationOf: the stage that pulls the task\'s column at its source wins (#861)', () => {
  const next: Stage[] = [{ name: 'spec', from: {} }, { name: 'build', from: { board: ['Doing'] } }, { name: 'done', from: {} }];
  assert.equal(destinationOf(at('Doing', 'board'), 'dev', OLD, next)?.name, 'build');
  assert.equal(destinationOf(at('Doing', 'other'), 'dev', OLD, next)?.name, 'spec', 'another source\'s column pulls nothing: the stage before');
});

test('destinationOf: else the nearest surviving stage before the deleted one, else the first after it; adjacent deletions meet on one survivor (#861)', () => {
  const next = OLD.filter((s) => s.name !== 'dev' && s.name !== 'qa');
  assert.deepEqual(named([destinationOf(at(''), 'dev', OLD, next), destinationOf(at(''), 'qa', OLD, next)]), ['spec', 'spec'], 'dev and qa both go back to spec');
  const firstGone = OLD.filter((s) => s.name !== 'spec' && s.name !== 'dev');
  assert.deepEqual(named([destinationOf(at(''), 'spec', OLD, firstGone), destinationOf(at(''), 'dev', OLD, firstGone)]), ['qa', 'qa'], 'nothing before: the first survivor after');
});

test('destinationOf: a stage the old list never had, or a flow with no survivor, lands on a new stage; no stage at all is undefined (#861)', () => {
  assert.equal(destinationOf(at(''), 'ghost', OLD, OLD.slice(1))?.name, 'dev', 'the first old stage that survives');
  assert.equal(destinationOf(at(''), 'dev', OLD, [{ name: 'triage', from: {} }])?.name, 'triage', 'every old stage replaced: the new first');
  assert.equal(destinationOf(at(''), 'dev', OLD, []), undefined);
});
