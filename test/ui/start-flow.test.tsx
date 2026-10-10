import { expect, test } from 'vitest';
import { hasStagesToRun, stagePath } from '@/lib/start-flow';
import type { Stage } from '../../src/types';

const stage = (name: string, approval?: true): Stage => ({ name, from: { board: [name] }, prompt: 'x', ...(approval ? { approval } : {}) });
const STAGES = [stage('backlog'), stage('plan'), stage('dev'), stage('in review', true), stage('done')];

test('the path runs from the task\'s stage to the first that awaits approval, which is where it stops (redesign 11)', () => {
  expect(stagePath('backlog', STAGES)).toEqual({ next: ['backlog', 'plan', 'dev', 'in review'], stop: 'in review', approval: true });
  expect(stagePath('in review', STAGES)).toEqual({ next: ['in review'], stop: 'in review', approval: true });
});

test('with no approval ahead it runs to the last stage; an unknown stage has no path (redesign 11)', () => {
  expect(stagePath('done', STAGES)).toEqual({ next: ['done'], stop: 'done', approval: false });
  expect(stagePath('nope', STAGES)).toEqual({ next: [], approval: false });
});

test('a task has stages to run while its own stage or one after it has a prompt or an action; an unknown stage is left to startMode (#774)', () => {
  const bare = (name: string): Stage => ({ name, from: { board: [name] } });
  const done = bare('done');
  expect(hasStagesToRun('done', [stage('dev'), done])).toBe(false); // the last stage, no prompt
  expect(hasStagesToRun('done', [stage('dev'), { ...done, action: 'deleteActivity' }])).toBe(true);
  expect(hasStagesToRun('inbox', [bare('inbox'), stage('dev'), done])).toBe(true); // promptless, a prompted stage after it
  expect(hasStagesToRun('nope', [stage('dev'), done])).toBe(true);
});
