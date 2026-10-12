import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ExhaustedBlock, TriesSection } from '@/components/TriesBlocks';
import { setLanguage } from '@/i18n';
import type { Activity, Session, Stage, State, Task, Transition, TryRecord } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';

// The details panel's tries (#916): the collapsed list while tries are left, the exhausted block and its boxes once they ran out. A fixed clock.

const NOW = '2026-10-11T10:38:00.000Z';
const STAGES: Stage[] = [
  { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['lint'] },
  { name: 'build', from: { board: ['Ready'] }, prompt: '/build {url}' },
  { name: 'review', from: { board: ['Review'] }, prompt: '/review {url}', verdicts: ['reprovou'] },
];
const BACK: Transition = { from: 'checks', to: 'build', when: 'verdict', verdict: 'failed', maxTries: 3 };
const KEY = '["checks","verdict","failed"]';
const OUT = 'tries out: verdict:failed · 3';
const S = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const record = (n: number, extra: Partial<TryRecord> = {}): TryRecord =>
  ({ transition: KEY, n, max: 3, cause: 'lint', error: `lint error ${n}`, at: `2026-10-11T10:0${n}:00.000Z`, stage: 'build', sessionId: S[n - 1], ...extra });
const THREE = [record(1), record(2), record(3)];
const session = (id: string): Session => ({ id, startedAt: '', stages: ['build'], agent: 'claude' as const, lastUsedAt: '' });
const taskIn = (stage: string): Task => ({ item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage, boardColumn: '', auto: true });
const at = (work: Partial<Activity>, { stage = 'checks', transitions = [BACK] }: { stage?: string; transitions?: Transition[] } = {}): State => withWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: STAGES, transitions, tasks: [taskIn(stage)], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
}, 'I1', work, { sessions: S.map(session) });
const exhausted = (s: State) => <ExhaustedBlock task={s.tasks[0]} state={s} locale="pt-BR" />;
const HALTED: Partial<Activity> = { stopped: true, error: OUT, tries: { [KEY]: 3 }, tryLog: THREE };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const lastPost = (path: string, body?: unknown) =>
  expect(fetchMock).toHaveBeenLastCalledWith(path, expect.objectContaining({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
beforeEach(() => {
  setLanguage('pt');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('one failed try of three shows the collapsed tentativas section, 1/3 ✕ lint · há 38 min; nothing with no record or while out of tries (#916)', () => {
  const s = at({ via: KEY, tries: { [KEY]: 1 }, tryLog: [record(1, { at: '2026-10-11T10:00:00.000Z' })] }, { stage: 'build' });
  const { unmount } = render(<TriesSection task={s.tasks[0]} state={s} />);
  const section = screen.getByRole('group');
  expect(section).not.toHaveAttribute('open');
  expect(within(section).getByText('tentativas')).toBeInTheDocument();
  expect(within(section).getByText('1/3 ✕ lint · há 38 min')).toBeInTheDocument();
  unmount();
  for (const empty of [at({}), at(HALTED)]) {
    const { container, unmount: done } = render(<TriesSection task={empty.tasks[0]} state={empty} />);
    expect(container).toBeEmptyDOMElement();
    done();
  }
});

test('a task out of tries shows the destructive block: its title, the text naming falhou, the stage and the destination, three actions, the note, and three boxes newest first (#916)', () => {
  render(exhausted(at(HALTED)));
  const block = screen.getByRole('region', { name: 'tentativas esgotadas' });
  expect(block).toHaveClass('border-destructive', 'bg-destructive/12');
  expect(within(block).getByText('etapa checks')).toBeInTheDocument();
  expect(within(block).getByText('checks falhou 3 de 3 vezes e voltou para build a cada vez. a tarefa parou aqui e espera você.')).toBeInTheDocument();
  expect(within(block).getAllByRole('button').map((b) => b.textContent)).toEqual(['tentar de novo', 'mover para…', 'abrir sessão']);
  expect(within(block).getByText('tentar de novo zera o contador e executa build.')).toBeInTheDocument();
  const tries = screen.getByRole('region', { name: 'tentativas · falhou 3/3' });
  expect(within(tries).getAllByText(/✕ lint$/).map((line) => line.textContent)).toEqual(['3/3 ✕ lint', '2/3 ✕ lint', '1/3 ✕ lint']);
  expect(within(tries).getByText('build · 33333333')).toBeInTheDocument();
});

test('tentar de novo posts retry; abrir sessão opens the newest try\'s session; mover para… lists the other stages and posts move-to (#916)', async () => {
  const user = userEvent.setup();
  render(exhausted(at(HALTED)));
  await user.click(screen.getByRole('button', { name: 'tentar de novo' }));
  lastPost('/tasks/I1/retry');
  await user.click(screen.getByRole('button', { name: 'abrir sessão' }));
  await waitFor(() => lastPost(`/activities/a-I1/sessions/${S[2]}/open`, {}));
  // Radix's DropdownMenu opens from the keyboard under jsdom, as SleepButton's test does
  screen.getByRole('button', { name: 'mover para…' }).focus();
  await user.keyboard('{Enter}');
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['build', 'review']);
  await user.click(items[1]);
  await waitFor(() => lastPost('/tasks/I1/move-to', { stage: 'review' }));
});

test('an agent\'s own verdict out of tries reads its word in the same block: reprovou (#916)', () => {
  const redo: Transition = { from: 'review', to: 'build', when: 'verdict', verdict: 'reprovou', maxTries: 3 };
  render(exhausted(at({ stopped: true, error: 'tries out: verdict:reprovou · 3' }, { stage: 'review', transitions: [redo] })));
  expect(screen.getByText(/^review reprovou 3 de 3 vezes e voltou para build a cada vez/)).toBeInTheDocument();
});

test('a transition renamed since the halt shows the block without tentar de novo, without the note and without its tries (#916)', () => {
  render(exhausted(at(HALTED, { transitions: [{ ...BACK, verdict: 'passed' }] })));
  const block = screen.getByRole('region', { name: 'tentativas esgotadas' });
  expect(within(block).getByText('checks esgotou as tentativas.')).toBeInTheDocument();
  expect(within(block).queryByRole('button', { name: 'tentar de novo' })).not.toBeInTheDocument();
  expect(within(block).queryByText(/zera o contador/)).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /^tentativas ·/ })).not.toBeInTheDocument();
});

test('a try box with no session has no ver saída and names the stage alone; one with an empty error has no error line; ver saída opens the try\'s session (#916)', async () => {
  const user = userEvent.setup();
  const { sessionId: _none, ...bare } = record(1, { error: '' });
  render(exhausted(at({ ...HALTED, tryLog: [bare, record(2)] })));
  const [second, first] = within(screen.getByRole('region', { name: 'tentativas · falhou 2/3' })).getAllByRole('listitem');
  expect(within(second).getByText('lint error 2')).toBeInTheDocument();
  expect(within(first).queryByText(/lint error/)).not.toBeInTheDocument();
  expect(within(first).queryByRole('button', { name: 'ver saída' })).not.toBeInTheDocument();
  expect(within(first).getByText('build')).toBeInTheDocument();
  await user.click(within(second).getByRole('button', { name: 'ver saída' }));
  await waitFor(() => lastPost(`/activities/a-I1/sessions/${S[1]}/open`, {}));
});
