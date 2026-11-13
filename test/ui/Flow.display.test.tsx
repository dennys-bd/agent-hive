import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { Item, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';
import { firstFlow } from './flow-of.js';

// The flowchart under exibir's sources and esconder epics, and its workspaces legend (#576), in a file of its own: Flow.test.tsx is long already.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const task = (id: string, stage: string, item: Partial<Item> = {}, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, stage, boardColumn: 'Ready', auto: true, ...extra,
});
const state = (tasks: WithWork[], workers: Worker[] = [], workspaces = ['hive']): State =>
  withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, ...flowed(stages, []), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces, sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });
// flowView as stored for the fixtures' one flow (flowed → 'main'), with the display fields a test sets
const stored = (display: object) => ({ sourcesOff: [], loops: 'all', labels: 'all', epics: 'none', outline: [], ...display, canvas: { main: { zoom: 1, pan: { x: 0, y: 0 }, collapsed: [] } } });
const nodeOf = (stage: string): HTMLElement => screen.getByRole('region', { name: 'fluxograma' }).querySelector<HTMLElement>(`[data-stage="${stage}"]`)!;
const countOf = (stage: string): string | null | undefined => within(nodeOf(stage)).getByRole('heading', { name: stage }).nextElementSibling?.textContent;
const cards = (stage: string): string[] => [...nodeOf(stage).querySelectorAll('[data-task-id]')].map((li) => li.getAttribute('data-task-id') ?? '');
const show = (s: State) => render(<Flow state={s} flow={firstFlow(s)} />);
beforeEach(() => setLanguage('pt'));
afterEach(() => resetViewState());

test('a task of an unchecked source is not drawn, counted or listed; a Hive task\'s source is hive (#576 decision 7)', () => {
  const s = state([task('1', 'dev', { source: 'roadmap' }), task('2', 'dev'), task('3', 'review', { source: 'roadmap' })]);
  resetViewState({ flowView: stored({ sourcesOff: ['roadmap'] }) });
  const { unmount } = show(s);
  expect([cards('dev'), countOf('dev')]).toEqual([['I2'], '1']);
  expect([cards('review'), countOf('review')]).toEqual([[], '0']);
  unmount();
  resetViewState({ flowView: stored({ sourcesOff: ['hive'] }) });
  show(s);
  expect(cards('dev')).toEqual(['I1']);
});

// I1 (dev) lists I2 (dev), which lists I3 (review); I4 (dev) is in no tree
const forest = (): State => state([
  task('1', 'dev', { children: ['I2'] }), task('2', 'dev', { parent: 'I1', children: ['I3'] }), task('3', 'review', { parent: 'I2' }), task('4', 'dev'),
]);

test('esconder epics: intermediários drops the middle epic and keeps the root; todos drops both, the root\'s group stays over its leaf in review and goes from dev, where it had no task left (#576 decisions 5, 6)', () => {
  resetViewState({ flowView: stored({ epics: 'middle', tree: true }) });
  const { unmount } = show(forest());
  expect([cards('dev'), countOf('dev')]).toEqual([['I1', 'I4'], '2']);
  unmount();
  resetViewState({ flowView: stored({ epics: 'all', tree: true }) });
  show(forest());
  expect([cards('dev'), countOf('dev'), cards('review')]).toEqual([['I4'], '1', ['I3']]);
  expect(within(nodeOf('review')).getByText('⑂ #1 Task 1')).toBeInTheDocument();
  expect(within(nodeOf('dev')).queryByText('⑂ #1 Task 1')).not.toBeInTheDocument();
});

const legend = (): string[] => [...screen.getByRole('group', { name: 'workspaces' }).children].map((row) => row.textContent ?? '');

test('the legend lists the workspaces of the tasks drawn, in the Comb\'s order; a task left out takes its workspace with it; no task resolving to one, no box (#576 decision 9)', () => {
  const s = state([task('1', 'dev', { source: 'roadmap' }, { workspace: 'site' }), task('2', 'review', {}, { workspace: 'hive' })], [], ['hive', 'docs', 'site']);
  resetViewState();
  const { unmount } = show(s);
  expect(legend()).toEqual(['hive', 'site']);
  unmount();
  resetViewState({ flowView: stored({ sourcesOff: ['roadmap'] }) });
  const { unmount: second } = show(s);
  expect(legend()).toEqual(['hive']);
  second();
  resetViewState({ flowView: stored({ sourcesOff: ['roadmap', 'hive'] }) });
  show(s);
  expect(screen.queryByRole('group', { name: 'workspaces' })).not.toBeInTheDocument();
});
