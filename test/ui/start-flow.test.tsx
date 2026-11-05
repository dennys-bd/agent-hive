import { expect, test } from 'vitest';
import { defaultDestination, destinationFlows, effectiveStage, hasStagesToRun, stagePath } from '@/lib/start-flow';
import type { Flow, Stage } from '../../src/types';

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

const flow = (name: string, stages: Stage[]): Flow => ({ name, stages, transitions: [] });
const INBOX: Stage = { name: 'inbox', from: { board: ['Inbox'] } }; // no prompt: runs no agent
const TRIAGE: Stage = { name: 'triage', from: { tracker: ['Triage'] }, prompt: 'x' };
const NOTES: Stage = { name: 'notes', from: { board: ['Notes'] } };
const FLOWS = [flow('feature', [INBOX, stage('spec'), stage('dev')]), flow('empty', []), flow('bug', [TRIAGE]), flow('manual', [NOTES])];
const OFFERED = destinationFlows(FLOWS);

test('a destination offers each flow with a stage, entering at its first stage that runs an agent, else its first; on a source, only the flows whose entry reads one of its columns (#580)', () => {
  expect(OFFERED).toEqual([{ flow: 'feature', entry: 'spec' }, { flow: 'bug', entry: 'triage' }, { flow: 'manual', entry: 'notes' }]);
  expect(destinationFlows(FLOWS, 'board')).toEqual([{ flow: 'feature', entry: 'spec' }, { flow: 'manual', entry: 'notes' }]);
  expect(destinationFlows(FLOWS, 'tracker')).toEqual([{ flow: 'bug', entry: 'triage' }]);
  expect(destinationFlows(FLOWS, 'nope')).toEqual([]);
});

test('the default destination is the first flow, outside the flow on a free session, and always a flow on a held source entry (#580)', () => {
  expect(defaultDestination(OFFERED, 'stages', false)).toEqual({ flow: 'feature' });
  expect(defaultDestination(OFFERED, 'free', false)).toBe('none');
  expect(defaultDestination(OFFERED, 'free', true)).toEqual({ flow: 'feature' });
  expect(defaultDestination([], 'stages', false)).toBe('none'); // no flow to offer
});

test('the effective stage is the task\'s own, else the chosen flow\'s entry, else none (#580)', () => {
  expect(effectiveStage({ stage: 'dev' }, { flow: 'bug' }, OFFERED)).toBe('dev');
  expect(effectiveStage({}, { flow: 'bug' }, OFFERED)).toBe('triage');
  expect(effectiveStage({}, 'none', OFFERED)).toBeUndefined();
  expect(effectiveStage(undefined, { flow: 'feature' }, OFFERED)).toBe('spec'); // a held entry: no task yet
});
