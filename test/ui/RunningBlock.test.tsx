import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RunningBlock } from '@/components/RunningBlock';
import { StageOutputContext } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import type { Activity, Stage, StageCi, StageCiCheck, StageCommands, State, Task, Transition } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';

// The details panel's block while a stage runs with no agent (#914): a wait for CI or a commands stage, over a fixed clock.

const NOW = '2026-10-10T10:05:10.000Z';
const CI: Stage = { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false };
const CHECKS: Stage = { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build', 'test', 'lint'], stopOnFailure: true };
const taskIn = (stage: string): Task => ({ item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage, boardColumn: '', auto: true });
const at = (stage: string, work: Partial<Activity>, transitions: Transition[] = []): State => withWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [CI, CHECKS], transitions, tasks: [taskIn(stage)], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
}, 'I1', work);
const block = (s: State) => <RunningBlock task={s.tasks[0]} state={s} />;
const JOB = 'https://github.com/acme/app/actions/runs/1/job/3';
const CHECK_LIST: StageCiCheck[] = [
  { name: 'lint', state: 'success', startedAt: '2026-10-10T10:00:00.000Z', completedAt: '2026-10-10T10:00:45.000Z' },
  { name: 'build', state: 'success', startedAt: '2026-10-10T10:00:00.000Z', completedAt: '2026-10-10T10:01:30.000Z' },
  { name: 'test', state: 'pending', startedAt: '2026-10-10T10:02:00.000Z', url: JOB },
  { name: 'e2e', state: 'pending' },
];
const WAIT: StageCi = { stage: 'ci', since: '2026-10-10T10:00:00.000Z', reran: [], done: 2, total: 4, checks: CHECK_LIST };
const RUN: StageCommands = { stage: 'checks', at: 1, ptyId: 'P1', runId: 'R1', failed: [], workerId: 'w1', started: ['2026-10-10T10:00:00.000Z', '2026-10-10T10:02:05.000Z'] };
// a running line's mark is the spinner, an svg with no text: ◌ stands for it
const texts = (region: HTMLElement): string[] => within(region).getAllByRole('listitem').map((li) => `${within(li).queryByTestId('spinner') ? '◌' : ''}${li.textContent ?? ''}`);
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => {
  setLanguage('pt');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('a wait for CI with four checks, two passed, shows two ✓ with their durations, one spinner with its running duration and one muted queued line, in the working tone (#914)', () => {
  render(block(at('ci', { ci: WAIT })));
  const region = screen.getByRole('region', { name: 'aguardando CI' });
  expect(region).toHaveClass('border-working', 'bg-working/12');
  expect(within(region).getByText('etapa ci')).toBeInTheDocument();
  expect(texts(region)).toEqual(['✓lint45s', '✓build1m 30s', '◌test3m 10s', 'e2e']);
  expect(within(region).getAllByRole('listitem')[3]).toHaveClass('text-muted-foreground');
});

test('a commands stage on its second command shows the first ✓ with its duration and the second a spinner; a failed one ✕, a skipped one pulado (#914)', () => {
  const { rerender } = render(block(at('checks', { commands: RUN })));
  const region = screen.getByRole('region', { name: 'executando checks' });
  expect(within(region).getByText('etapa checks')).toBeInTheDocument();
  expect(texts(region)).toEqual(['✓build2m 5s', '◌test3m 5s', 'lint']);
  const third: StageCommands = { ...RUN, at: 2, started: [...RUN.started, '2026-10-10T10:04:00.000Z'], failed: [{ name: 'build', code: 1, output: 'x' }], skipped: [1] };
  rerender(block(at('checks', { commands: third })));
  expect(texts(screen.getByRole('region', { name: 'executando checks' }))).toEqual(['✕build2m 5s', 'testpulado', '◌lint1m 10s']);
});

test('an activity that came through checks → build with maxTries 3, on its second try, shows volta 2/3 (#914)', () => {
  const back: Transition = { from: 'checks', to: 'build', when: 'verdict', verdict: 'failed', maxTries: 3 };
  const key = '["checks","verdict","failed"]';
  render(block(at('checks', { commands: RUN, via: key, tries: { [key]: 2 } }, [back])));
  expect(screen.getByText('volta 2/3')).toBeInTheDocument();
});

test('ver saída opens the execution\'s console on a commands stage and the running check\'s page on a wait; parar posts the stage\'s stop (#914)', async () => {
  const user = userEvent.setup();
  const openOutput = vi.fn();
  const { unmount } = render(<StageOutputContext.Provider value={openOutput}>{block(at('checks', { commands: RUN }))}</StageOutputContext.Provider>);
  await user.click(screen.getByRole('button', { name: 'ver saída' }));
  expect(openOutput).toHaveBeenCalledWith('I1', 'stage:checks', 'R1');
  await user.click(screen.getByRole('button', { name: 'parar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/ptys/P1/stop', expect.objectContaining({ method: 'POST' }));
  unmount();
  const { rerender } = render(block(at('ci', { ci: WAIT })));
  expect(screen.getByRole('link', { name: 'ver saída' })).toHaveAttribute('href', JOB);
  await user.click(screen.getByRole('button', { name: 'parar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/ci/stop', expect.objectContaining({ method: 'POST' }));
  rerender(block(at('ci', { ci: { ...WAIT, checks: CHECK_LIST.filter((c) => c.name !== 'test') } })));
  expect(screen.queryByRole('link', { name: 'ver saída' })).not.toBeInTheDocument(); // nothing runs: no page to open
});

test('a command silent for 3 min shows sem saída há 3 min · test and keeps the working tone; at 1 min it does not (#914)', () => {
  const quiet = (outputAt: string): State => at('checks', { commands: { ...RUN, outputAt } });
  const { rerender } = render(block(quiet('2026-10-10T10:02:10.000Z')));
  expect(screen.getByText('sem saída há 3 min · test')).toHaveClass('text-muted-foreground');
  expect(screen.getByRole('region', { name: 'executando checks' })).toHaveClass('border-working');
  rerender(block(quiet('2026-10-10T10:04:10.000Z')));
  expect(screen.queryByText(/sem saída/)).not.toBeInTheDocument();
});

test('a running line\'s clock moves every second (#914)', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(NOW));
  render(block(at('ci', { ci: WAIT })));
  expect(screen.getByText('3m 10s')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText('3m 12s')).toBeInTheDocument();
});
