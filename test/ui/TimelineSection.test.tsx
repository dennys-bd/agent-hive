import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TimelineSection } from '@/components/TimelineSection';
import { setLanguage } from '@/i18n';
import type { TimelineEvent } from '../../src/server-timeline';
import type { Checkpoint, Worker } from '../../src/types';
import { jsonResponse } from '../fakes';
import { movedWork, type WithWork } from '../fixtures/work';

vi.mock('@/hooks/use-timeline', async (importOriginal) => importOriginal()); // test/ui/setup.ts replaces it in every other file

const MIN = 60_000;
const NOW = new Date(2026, 8, 30, 12, 0); // local: 30 Sep 2026, 12:00
const at = (day: number, hour: number, minute: number): string => new Date(2026, 8, day, hour, minute).toISOString();
const EVENTS: TimelineEvent[] = [
  { kind: 'question', ts: at(28, 10, 20), durationMs: 6 * MIN, answered: true },
  { kind: 'stage', ts: at(28, 10, 36), stage: 'spec', attempt: 1, outcome: 'done', durationMs: 24 * MIN, waitedMs: 6 * MIN },
  { kind: 'move', ts: at(29, 10, 36), to: 'dev', by: 'auto' },
  { kind: 'stage', ts: at(29, 10, 58), stage: 'dev', attempt: 1, outcome: 'stop', durationMs: 22 * MIN, waitedMs: 0 },
  { kind: 'pr', ts: at(30, 9, 43), pr: 515 },
];
const checkpoint = (n: number, stage: string, iso: string): Checkpoint =>
  ({ n, stage, start: 'a'.repeat(40), head: 'b'.repeat(40), commit: 'c'.repeat(40), branch: 'hive/1-x', at: iso, ended: 'done' });
const CHECKPOINTS = [checkpoint(1, 'spec', new Date(Date.parse(at(28, 10, 36)) + 2_000).toISOString())];
const fixture = (checkpoints: Checkpoint[]): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, worktree: '/wt', stopped: true, checkpoints,
});
const stateOf = (checkpoints: Checkpoint[], workers: Worker[] = []) =>
  ({ ...movedWork({ tasks: [fixture(checkpoints)], activities: [], activityRecords: [] }), workers, terminals: [] });
const worker = (status: Worker['status']): Worker =>
  ({ id: 'w1', status, runId: 'r1', activityId: 'a-I1', freeSession: true, sessionId: 'abcdef12-0000-4000-8000-000000000000' });
const show = (state = stateOf(CHECKPOINTS)) => render(<TimelineSection task={state.tasks[0]} state={state} locale="pt-BR" />);
const route = (...answers: Response[]) => {
  const fetchMock = vi.fn(async (_path: string) => answers.shift() ?? jsonResponse({ events: [] }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const section = (): HTMLDetailsElement => screen.getByRole('group', { name: 'linha do tempo' }) as HTMLDetailsElement;
const summary = (): HTMLElement => section().querySelector('summary')!;
const rows = (day: HTMLElement): (string | null)[] => [...day.querySelectorAll(':scope > div')].map((row) => row.textContent);
const bars = (row: Element): [string, string][] => [...row.querySelectorAll<HTMLElement>('[data-slot="timeline-split"] > span')]
  .map((bar) => [bar.classList.contains('bg-waiting') ? 'waited' : 'worked', bar.style.flexGrow]);

beforeEach(() => { setLanguage('pt'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('closed by default; its summary reads trabalhou and esperou você summed over the stage events (#961)', async () => {
  route(jsonResponse({ events: EVENTS }));
  show();
  expect(section().open).toBe(false);
  await waitFor(() => expect(summary()).toHaveTextContent('trabalhou 40m · esperou você 6m'));
});

test('the events by day, oldest first; a stage row reads its duration and checkpoint over a split bar of worked and waited (#961)', async () => {
  route(jsonResponse({ events: EVENTS }));
  show();
  await screen.findByRole('region', { name: 'hoje' });
  const days = screen.getAllByRole('region');
  expect(days.map((day) => day.getAttribute('aria-label'))).toEqual(['28 set', 'ontem', 'hoje']);
  expect(rows(days[0])).toEqual(['10:20pergunta · você respondeu em 6m', '10:36spec terminou · 24m · ponto 1trabalhou 18m · esperou você 6m']);
  expect(rows(days[1])).toEqual(['10:36foi para dev · automático', '10:58dev você parou · 22mtrabalhou 22m']);
  expect(rows(days[2])).toEqual(['09:43abriu o PR #515']);
  const [, specRow] = days[0].querySelectorAll(':scope > div');
  const [, devRow] = days[1].querySelectorAll(':scope > div');
  expect(bars(specRow)).toEqual([['worked', String(18 * MIN)], ['waited', String(6 * MIN)]]);
  expect(bars(devRow)).toEqual([['worked', String(22 * MIN)]]); // no wait: one part
  expect(specRow.querySelector('[data-slot="timeline-split"]')).toHaveAttribute('aria-hidden', 'true');
  expect(within(specRow as HTMLElement).getByText('spec', { selector: 'b' })).toBeInTheDocument();
});

test('an answer with since starts the summary with desde and the list with the history-start note (#961)', async () => {
  route(jsonResponse({ since: at(29, 8, 0), events: EVENTS.slice(2) }));
  show();
  await waitFor(() => expect(summary()).toHaveTextContent('desde 29 set · trabalhou 22m · esperou você 0m'));
  expect(screen.getByText('a história desta tarefa no Hive começa em 29 set.')).toBeInTheDocument();
});

test('an empty answer: nada registrado ainda, and the list holds the task\'s state alone (#961)', async () => {
  route(jsonResponse({ events: [] }));
  show();
  await waitFor(() => expect(summary()).toHaveTextContent('nada registrado ainda'));
  expect(screen.queryAllByRole('region')).toEqual([]);
  expect(screen.getByText('parada')).toBeInTheDocument();
});

test('while the read is pending the summary says lendo o log da tarefa… and the body shows the skeleton (#961)', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  show();
  expect(summary()).toHaveTextContent('lendo o log da tarefa…');
  const skeleton = within(section()).getByRole('status');
  expect(skeleton).toHaveAttribute('aria-busy', 'true');
  expect(skeleton).toHaveTextContent('lendo o log da tarefa…');
});

test('a failed read shows the error, destructive in the summary, and tentar de novo reads again (#961)', async () => {
  const user = userEvent.setup();
  const fetchMock = route(jsonResponse({ error: 'the usage store is off' }, 503), jsonResponse({ events: EVENTS }));
  show();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('não deu para ler o log da tarefa');
  expect(within(summary()).getByText('não deu para ler o log da tarefa')).toHaveClass('text-destructive');
  await user.click(within(alert).getByRole('button', { name: 'tentar de novo' }));
  await waitFor(() => expect(summary()).toHaveTextContent('trabalhou 40m · esperou você 6m'));
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/tasks/I1/timeline', '/tasks/I1/timeline']);
});

test('a broadcast that moves nothing reads nothing; a run ending with a new checkpoint reads again, the list staying shown meanwhile (#961)', async () => {
  const pending: ((res: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); })));
  const live = stateOf([], [worker('working')]);
  const { rerender } = render(<TimelineSection task={live.tasks[0]} state={live} locale="pt-BR" />);
  await act(async () => { pending[0](jsonResponse({ events: EVENTS.slice(0, 2) })); });
  await screen.findByRole('region', { name: '28 set' });
  rerender(<TimelineSection task={live.tasks[0]} state={{ ...live }} locale="pt-BR" />);
  expect(pending).toHaveLength(1);
  const ended = stateOf(CHECKPOINTS);
  rerender(<TimelineSection task={ended.tasks[0]} state={ended} locale="pt-BR" />);
  expect(pending).toHaveLength(2);
  expect(screen.getByRole('region', { name: '28 set' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await act(async () => { pending[1](jsonResponse({ events: EVENTS })); });
  expect(await screen.findByRole('region', { name: 'hoje' })).toBeInTheDocument();
});

test('the list ends with the task\'s state as the status box words it and the time since the last event, in that state\'s colour (#961)', async () => {
  route(jsonResponse({ events: EVENTS }));
  show(stateOf(CHECKPOINTS, [worker('waiting')]));
  const live = await screen.findByText('esperando você · há 2h17m');
  expect(live).toHaveClass('text-waiting');
  expect(live.closest('div')!.previousElementSibling).toBe(screen.getByRole('region', { name: 'hoje' }));
});
