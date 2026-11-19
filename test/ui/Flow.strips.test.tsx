import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { Item, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';
import { firstFlow } from './flow-of.js';

// The bug flow under exibir's etapas vazias (#914): triage and review hold a task; repro, fix and release are empty
const BUG: Stage[] = ['triage', 'repro', 'fix', 'review', 'release'].map((name) => ({ name, from: { board: [name] } }));
const task = (id: string, stage: string, item: Partial<Item> = {}, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, stage, boardColumn: stage, auto: true, ...extra,
});
const state = (tasks: WithWork[]): State =>
  withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's1', status: 'empty' }], ...flowed(BUG, []), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });
const TASKS = [task('1', 'triage', {}, { auto: false }), task('2', 'review')];
const show = (s: State) => render(<Flow state={s} flow={firstFlow(s)} />);
const strips = (): string[][] => [...document.querySelectorAll('[data-strip]')].map((s) => [...s.querySelectorAll('[data-segment]')].map((g) => g.getAttribute('data-segment') ?? ''));
const nodes = (): string[] => [...document.querySelectorAll('[data-stage]')].map((n) => n.getAttribute('data-stage') ?? '');
const segment = (name: string): HTMLElement => screen.getByRole('group', { name: `${name}, vazia, recolhida` });
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('under recolher e juntar, the default, empty neighbours render as one strip with a segment each and a lone one as its own (#914)', () => {
  show(state(TASKS));
  expect(nodes()).toEqual(['triage', 'review']);
  expect(strips()).toEqual([['repro', 'fix'], ['release']]);
});

test('under recolher each empty stage is its own strip; under não recolher each is a node reading nenhuma tarefa (#914)', () => {
  resetViewState({ flowView: { emptyStages: 'collapse' } });
  const { unmount } = show(state(TASKS));
  expect(strips()).toEqual([['repro'], ['fix'], ['release']]);
  unmount();
  resetViewState({ flowView: { emptyStages: 'open' } });
  show(state(TASKS));
  expect([nodes(), strips()]).toEqual([['triage', 'repro', 'fix', 'review', 'release'], []]);
  expect(within(screen.getByRole('list', { name: 'fix' })).getByText('nenhuma tarefa')).toBeInTheDocument();
});

test('a task entering a stage turns its strip into a node; a stage whose task the sources hide collapses with its neighbours (#914, #576)', () => {
  const { rerender, unmount } = show(state(TASKS));
  const entered = state([...TASKS, task('3', 'fix')]);
  rerender(<Flow state={entered} flow={firstFlow(entered)} />);
  expect([nodes(), strips()]).toEqual([['triage', 'fix', 'review'], [['repro'], ['release']]]);
  resetViewState({ flowView: { sourcesOff: ['roadmap'] } });
  const hidden = state([TASKS[0], task('2', 'review', { source: 'roadmap' })]);
  unmount(); // the view is read on mount, so a fresh Flow reads the stored sourcesOff
  show(hidden);
  expect(strips()).toEqual([['repro', 'fix', 'review', 'release']]);
});

test('a segment\'s ⋯ lista › opens that stage\'s list panel (#914)', async () => {
  const user = userEvent.setup();
  show(state(TASKS));
  await user.click(within(segment('fix')).getByRole('button', { name: 'ações da etapa' }));
  await user.click(screen.getByRole('menuitem', { name: 'lista ›' }));
  expect(screen.getByRole('region', { name: 'fix' })).toBeInTheDocument();
});

test('dropping a card on a segment moves the task to that segment\'s stage (#366, #914)', () => {
  show(state(TASKS));
  const data = new Map<string, string>();
  const dt = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'move', dropEffect: 'move' };
  fireEvent.dragStart(screen.getByText('#1 Task 1').closest('li')!, { dataTransfer: dt });
  const at = (type: string) => fireEvent(segment('fix'), Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: dt }));
  at('dragover');
  expect(segment('fix')).toHaveAttribute('data-drop', 'over');
  at('drop');
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'fix', drop: {} }) }));
});
