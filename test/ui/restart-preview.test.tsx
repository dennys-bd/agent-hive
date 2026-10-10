import { beforeEach, expect, test } from 'vitest';
import { discardText, keptStages, keptText, returnTo } from '@/components/restart-preview';
import { setLanguage } from '@/i18n';
import type { Session, Stage } from '../../src/types';
import { bareTask, movedWork, type WithWork } from '../fixtures/work';

const at = '2026-09-30T10:00:00.000Z';
const session = (n: number, stages: string[]): Session => ({ id: `a42d186${n}-0000-4000-8000-00000000000${n}`, startedAt: at, stages, lastUsedAt: at });
const stages: Stage[] = ['backlog', 'plan', 'dev', 'review'].map((name) => ({ name, from: { board: [name] }, prompt: '/x' }));
const COMMIT = '3f1c9e2d4b5a69788796a5b4c3d2e1f001234567';
const SESSIONS = [session(1, ['backlog']), session(2, ['plan']), session(3, ['dev'])];
const fixture = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '480', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true,
  stageStart: { stage: 'dev', commit: COMMIT, after: 'plan' }, ...extra,
});
const task = bareTask(fixture());
// #629: the start is the activity's, the sessions the record's
const work = (extra: Partial<WithWork> = {}, sessions: Session[] = SESSIONS) =>
  movedWork({ tasks: [fixture(extra)], activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions }] });
beforeEach(() => setLanguage('pt'));

test('discardText: commits, files and the stage\'s session in reset mode; no commits in branch mode; no session when the stage has none (#580)', () => {
  expect(discardText(task, work(), { mode: 'reset', commits: 4, files: 12 })).toBe('4 commits · 12 arquivos · sessão a42d1863');
  expect(discardText(task, work(), { mode: 'branch', commits: 4, files: 1 })).toBe('1 arquivo · sessão a42d1863');
  expect(discardText(task, work({}, []), { mode: 'reset', commits: 1, files: 0 })).toBe('1 commit · 0 arquivos');
});

test('returnTo: the short start commit and the stage that ended there, this stage\'s own start without after; nothing without a recorded start (#580)', () => {
  expect(returnTo(task, work())).toEqual({ sha: '3f1c9e2', label: 'fim da etapa plan' });
  expect(returnTo(task, work({ stageStart: { stage: 'dev', commit: COMMIT } }))).toEqual({ sha: '3f1c9e2', label: 'início da etapa dev' });
  expect(returnTo(task, work({ stageStart: undefined }))).toBeUndefined();
});

test('keptStages: the other stages the sessions ran, in column order, a stage no column holds left out; keptText joins them with the language\'s and (#580)', () => {
  const sessions = [session(1, ['plan', 'dev']), session(2, ['gone']), session(3, ['backlog']), session(4, ['dev'])];
  expect(keptStages(task, work({}, sessions), stages)).toEqual(['backlog', 'plan']);
  expect(keptStages(task, work({}, [session(1, ['dev'])]), stages)).toEqual([]);
  expect([keptText(['plan']), keptText(['backlog', 'plan']), keptText(['backlog', 'plan', 'review'])])
    .toEqual(['resultados de plan', 'resultados de backlog e plan', 'resultados de backlog, plan e review']);
});
