import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx); every state arrives through rerender.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const sessions = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-25T10:00:00.000Z', stages: ['dev'], lastUsedAt: '2026-09-25T10:00:00.000Z' }];
// A stopped task whose stage ran with a recorded start (so reiniciar etapa… shows) and a free session open on it (so dormir shows)
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  worktree: '/wt', stopped: true, stageStart: { stage: 'dev', commit: 'a1b2c3d' }, ...extra,
});
const session: Worker = { id: 'm1', status: 'working', activityId: activityIdOf('I1'), runId: 'W2', freeSession: true, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' };
const state = (c: Task, workers: Worker[] = [session]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions }], // #629: the record's
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive'], sourceWorkspaces: {}, commands: { hive: ['Run API'] }, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const menu = (): HTMLElement => screen.getByRole('menu');
const items = (): string[] => [...menu().querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? ''); // menuitem and the switch's menuitemcheckbox
const RUNNING = 'um worker ou sessão está executando nessa tarefa';
beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

test('the task menu is 236px, in the handoff\'s order: the runs, the diffs, começar sozinho and the moves, excluir atividade…; aprovar and enviar feedback… first while awaiting approval, excluir tarefa… last on a Hive task (#542)', async () => {
  const { rerender } = render(<Flow state={state(task())} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  await screen.findByRole('menuitem', { name: 'abrir sessão livre…' });
  expect(menu()).toHaveClass('w-[236px]');
  expect(items()).toEqual([
    'executar etapas…', 'abrir sessão livre…', 'reiniciar etapa…', 'executar', 'dormir',
    'diff da etapa', 'diff da worktree', 'mostrar PR',
    'começar sozinho', 'mover para etapa', 'mover para workspaceexclua a atividade antes',
    `excluir atividade… · ${RUNNING}`,
  ]);
  expect(within(menu()).getAllByRole('separator')).toHaveLength(3);
  rerender(<Flow state={state(task({ created: true, approval: { since: '2026-09-25T10:00:00.000Z' } }), [{ ...session, status: 'approval' }])} />); // #829: the approval is answerable only with no session of the task live
  expect(items()).toEqual([
    'aprovar', 'enviar feedback…',
    'executar etapas…', 'abrir sessão livre…', 'executar', 'dormir',
    'diff da etapa', 'diff da worktree', 'mostrar PR',
    'começar sozinho', 'mover para etapa', 'mover para workspaceexclua a atividade antes',
    `excluir atividade… · ${RUNNING}`, `excluir tarefa… · ${RUNNING}`,
  ]);
  expect(within(menu()).getAllByRole('separator')).toHaveLength(4);
});
