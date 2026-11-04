import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinationOf } from '../src/stage-delete.js';
import type { Flow, Stage, Task } from '../src/types.js';

const flow = (name: string, stages: Stage[]): Flow => ({ name, stages, transitions: [] });
const main = (stages: Stage[]): Flow[] => [flow('main', stages)];
const OLD: Stage[] = ['spec', 'dev', 'qa', 'review', 'done'].map((name) => ({ name, from: {} }));
const at = (column: string, source?: string): Pick<Task, 'item' | 'boardColumn'> =>
  ({ item: { itemId: 'board:1', id: '1', title: 'T', body: '', url: '', ...(source === undefined ? {} : { source }) }, boardColumn: column });
const named = (stages: (Stage | undefined)[]): (string | undefined)[] => stages.map((s) => s?.name);

test('destinationOf: the stage that pulls the task\'s column at its source wins (#861)', () => {
  const next: Stage[] = [{ name: 'spec', from: {} }, { name: 'build', from: { board: ['Doing'] } }, { name: 'done', from: {} }];
  assert.equal(destinationOf(at('Doing', 'board'), 'dev', main(OLD), main(next))?.name, 'build');
  assert.equal(destinationOf(at('Doing', 'other'), 'dev', main(OLD), main(next))?.name, 'spec', 'another source\'s column pulls nothing: the stage before');
});

test('destinationOf: else the nearest surviving stage before the deleted one, else the first after it; adjacent deletions meet on one survivor (#861)', () => {
  const next = main(OLD.filter((s) => s.name !== 'dev' && s.name !== 'qa'));
  assert.deepEqual(named([destinationOf(at(''), 'dev', main(OLD), next), destinationOf(at(''), 'qa', main(OLD), next)]), ['spec', 'spec'], 'dev and qa both go back to spec');
  const firstGone = main(OLD.filter((s) => s.name !== 'spec' && s.name !== 'dev'));
  assert.deepEqual(named([destinationOf(at(''), 'spec', main(OLD), firstGone), destinationOf(at(''), 'dev', main(OLD), firstGone)]), ['qa', 'qa'], 'nothing before: the first survivor after');
});

test('destinationOf: a stage no old flow holds, or a flow with no surviving stage, has no destination (#565)', () => {
  assert.equal(destinationOf(at(''), 'ghost', main(OLD), main(OLD.slice(1))), undefined);
  assert.equal(destinationOf(at(''), 'dev', main(OLD), main([{ name: 'triage', from: {} }])), undefined, 'every old stage replaced');
  assert.equal(destinationOf(at(''), 'dev', main(OLD), []), undefined);
});

test('destinationOf never returns a stage of another flow: not its neighbour, not its pull; a renamed flow is still the same flow (#565)', () => {
  const s = (name: string, from: Stage['from'] = {}): Stage => ({ name, from });
  const feature = flow('feature', [s('spec'), s('build', { board: ['Doing'] })]);
  const bug = flow('bug', [s('triage'), s('fix'), s('verify')]);
  const old = [feature, bug];
  const triaged = [feature, flow('bug', [s('fix'), s('verify')])];
  assert.equal(destinationOf(at(''), 'triage', old, triaged)?.name, 'fix', 'the first stage of bug goes to fix, never to feature\'s last');
  assert.equal(destinationOf(at('Doing', 'board'), 'triage', old, triaged)?.name, 'fix', 'feature\'s pull does not reach a task of bug');
  assert.equal(destinationOf(at(''), 'fix', old, [feature]), undefined, 'bug gone: no destination, whatever feature holds');
  assert.equal(destinationOf(at(''), 'triage', old, [feature, { ...triaged[1], name: 'hotfix' }])?.name, 'fix');
});
