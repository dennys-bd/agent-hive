import { beforeEach, expect, test } from 'vitest';
import { evaluateProgress, taskError } from '@/components/CommandsProgress';
import { setLanguage } from '@/i18n';
import type { Stage, State, Task } from '../../src/types';
import { STAGE_GONE } from '../../src/types';
import { withWork } from '../fixtures/work';

beforeEach(() => setLanguage('en'));

test('a task halted because its stage was deleted reads in the viewer\'s language (#861)', () => {
  expect(taskError(`${STAGE_GONE}Backlog`)).toBe('The stage "Backlog" no longer exists');
  setLanguage('pt');
  expect(taskError(`${STAGE_GONE}Backlog`)).toBe('A etapa "Backlog" não existe mais');
});

test('an evaluation reads avaliando · n revisores, then julgando; its failures read in the viewer\'s language (#877)', () => {
  setLanguage('pt');
  const stage: Stage = { name: 'eval', from: { board: ['Eval'] }, action: 'evaluate', reviewers: [{ agent: 'claude', focus: 'a' }, { agent: 'codex', focus: 'b' }], judge: { agent: 'claude' }, threshold: 7, rubric: 'Tests cover it?' };
  const task: Task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'eval', boardColumn: '', auto: true };
  const run = { stage: 'eval', runId: 'r', workerId: 'w', startedAt: '2026-10-21T10:00:00.000Z', phase: 'reviewing' as const };
  const at = (work: Record<string, unknown>): State => withWork({ stages: [stage], tasks: [task], activities: [], activityRecords: [], workers: [], terminals: [] } as unknown as State, 'I1', work);
  expect(evaluateProgress(task, at({ evaluate: run }))).toBe('avaliando · 2 revisores');
  expect(evaluateProgress(task, at({ evaluate: { ...run, phase: 'judging' } }))).toBe('julgando');
  expect(evaluateProgress(task, at({ evaluate: run, setup: { step: 'x' } }))).toBeUndefined();
  expect(evaluateProgress(task, at({}))).toBeUndefined();
  expect(taskError('evaluation rejected: Tests cover it?')).toBe('avaliação reprovou: Tests cover it?');
  expect(taskError('evaluation failed: judge (claude): no answer')).toBe('avaliação falhou: judge (claude): no answer');
});
