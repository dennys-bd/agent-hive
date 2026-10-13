import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FlowTask, taskAction } from '@/components/FlowTask';
import { TreeHoverContext } from '@/components/tree-hover';
import { Flow } from '@/components/Flow';
import { SyncBlock } from '@/components/ForkSyncNotice';
import { CiNotice } from '@/components/CiProgress';
import { StageOutputContext } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import type { Activity, BaseOptions, Item, Task, TaskPr, Session, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SPAWN_FAILED } from '../../src/types';
import { activityIdOf, withPointedWork, withWork, type WithWork } from '../fixtures/work';

// The task face (redesign 10, #542), rendered in its board: the task menu, the drag and the Start dialog need what Flow hands them.
const stages: Stage[] = [
  { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } },
  { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' },
];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const working = (extra: Partial<Worker> = {}): Worker => ({ id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1', ...extra });
const state = (c: Task, workers: Worker[] = [], extra: Partial<State> = {}): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, ...extra,
});
const since = '2026-09-25T10:00:00.000Z';
const ran: Session[] = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: since, stages: ['dev'], agent: 'claude' as const, lastUsedAt: since }];
const records = [{ id: 'a-I1', taskIds: ['I1'], sessions: ran }]; // #629: the session is the task's record's
const tile = (): HTMLElement => screen.getByText('#1 Task 1').closest('li')!;
const bases: BaseOptions = { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }; // what the Start dialog reads
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).endsWith('/bases') ? bases : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('taskAction picks one button by priority: aprovar while no session of the task is live, abrir on a live session (aguardando você too, an approval pending or not), continuar, excluir in a delete-activity stage, iniciar; none for a blocked, a missing or a nothing-to-run task (#542, #829, #812)', () => {
  // #629: the run fields are the activity's, so the task is read from the state
  const actionOf = (c: WithWork, workers: Worker[] = [], extra: Partial<State> = {}) => taskAction(c, state(c, workers, extra));
  const waiting = working({ status: 'waiting', freeSession: true, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' });
  expect(actionOf(task({ approval: { since }, workerId: 's1' }), [working({ status: 'approval' })])).toBe('approve');
  expect(actionOf(task({ approval: { since } }), [waiting])).toBe('open'); // #829: a session of it waits, the user answers there
  expect(actionOf(task({ approval: { since } }), [working({ status: 'backoff' })])).toBe('open');
  const reviewed = [{ ...records[0], prs: [{ url: 'https://github.com/acme/r/pull/2', state: 'open' as const }] }];
  expect(actionOf(task({ approval: { since } }), [], { activityRecords: reviewed })).toBe('approve'); // review with nothing live: still the user's
  expect(actionOf(task({ workerId: 's1' }), [working()])).toBe('open');
  expect(actionOf(task(), [waiting])).toBe('open');
  expect(actionOf(task({ stopped: true }), [], { activityRecords: records })).toBe('continue');
  expect(actionOf(task({ stopped: true, freeSessionStage: 'dev', stageStart: { stage: 'dev', commit: 'a1b2c3d' } }), [], { activityRecords: records })).toBe('start'); // #812: a free run in the stage: start, restart in the menu
  expect(actionOf(task({ stage: 'done', worktree: '/wt' }))).toBe('delete');
  expect(actionOf(task({ stage: 'done', worktree: '/wt' }), [waiting])).toBe('open'); // a session open: abrir before excluir
  expect(actionOf(task())).toBe('start');
  expect(actionOf(task({ item: { ...task().item, blockedBy: ['9'] } }))).toBeUndefined();
  expect(actionOf(task({ missing: true }))).toBeUndefined();
  expect(actionOf(task({ stage: 'review' }))).toBeUndefined();
});

test('the face (#134): the workspace square before the id, the workspace\'s name as its title, the title on two lines at most, no workspace line nor branch; the auto badge and the status on one line; the border takes the status colour (#542)', () => {
  const { rerender } = render(<Flow state={state(task({ workerId: 's1', branch: 'hive/1-task-1' }), [working()])} />);
  expect(tile()).toHaveClass('rounded-lg', 'bg-background', 'border-working');
  const title = screen.getByText('#1 Task 1');
  expect(title).toHaveClass('line-clamp-2');
  expect(within(title).getByTitle('hive')).toHaveAttribute('aria-hidden', 'true');
  expect(within(tile()).queryByText('hive/1-task-1')).not.toBeInTheDocument();
  expect(within(tile()).getByText('auto')).toBeInTheDocument();
  expect(within(tile()).getByText('trabalhando')).toHaveClass('text-working');
  expect(within(tile()).getByText('auto').parentElement).toHaveClass('flex', 'min-w-0', 'items-center'); // one line: the button never wraps below
  rerender(<Flow state={state(task(), [], { workspaces: ['hive', 'site'] })} />);
  expect(within(screen.getByText('#1 Task 1')).queryByTitle('hive')).not.toBeInTheDocument();
  rerender(<Flow state={state(task({ auto: false, approval: { since } }))} />);
  expect(tile()).toHaveClass('border-approval');
  expect(within(tile()).getByText('aguardando aprovação')).toHaveClass('text-approval');
  rerender(<Flow state={state(task({ missing: true }))} />);
  expect(tile()).toHaveClass('border-destructive');
  expect(within(tile()).getByRole('button', { name: 'fechar' })).toBeInTheDocument();
});

test('a task that came through a transition with tries shows its verdict and n/max beside its status; one with no limit shows nothing (#134)', () => {
  const back = { from: 'review', to: 'dev', when: 'verdict' as const, verdict: 'failed', maxTries: 3 };
  const key = '["review","verdict","failed"]';
  const { rerender } = render(<Flow state={state(task({ via: key, tries: { [key]: 1 } }), [], { transitions: [back] })} />);
  expect(within(tile()).getByText('falhou · 1/3')).toBeInTheDocument();
  rerender(<Flow state={state(task({ via: key }), [], { transitions: [{ ...back, maxTries: undefined }] })} />);
  expect(within(tile()).queryByText(/\/3/)).not.toBeInTheDocument();
});

test('a task whose run waits out an API error shows the backoff word and the time left in its colour, in both languages (#805)', () => {
  const until = new Date(Date.now() + 4 * 60_000 + 30_000).toISOString();
  const waiting = working({ status: 'backoff', backoff: { error: 'overloaded', until } });
  const { rerender } = render(<Flow state={state(task({ workerId: 's1' }), [waiting])} />);
  expect(tile()).toHaveClass('border-backoff');
  expect(within(tile()).getByText('aguardando · 4m')).toHaveClass('text-backoff');
  setLanguage('en');
  rerender(<Flow state={state(task({ workerId: 's1' }), [waiting])} />);
  expect(within(tile()).getByText('backing off · 4m')).toBeInTheDocument();
});

test('the task\'s auto badge is struck through only while the task is stopped; its auto stays on (#735, #727)', () => {
  const { rerender } = render(<Flow state={state(task())} />);
  expect(within(tile()).getByText('auto')).not.toHaveClass('line-through');
  rerender(<Flow state={state(task({ stopped: true }))} />);
  expect(within(tile()).getByText('auto')).toHaveClass('opacity-50', 'line-through');
});

test('a task awaiting approval that is blocked keeps the approval look and adds a muted line with its blocker; without a blocker there is no line (#595)', () => {
  const blocked = task({ approval: { since }, item: { ...task().item, blockedBy: ['#98'] } });
  const { rerender } = render(<Flow state={state(blocked)} />);
  expect(tile()).toHaveClass('border-approval');
  expect(within(tile()).getByText('aguardando aprovação')).toHaveClass('text-approval');
  expect(within(tile()).getByRole('button', { name: 'aprovar' })).toBeInTheDocument();
  expect(within(tile()).getByText('⊘ bloqueada por #98')).toHaveClass('text-muted-foreground');
  setLanguage('en');
  rerender(<Flow state={state(blocked)} />);
  expect(within(tile()).getByText('⊘ blocked by #98')).toBeInTheDocument();
  rerender(<Flow state={state(task({ approval: { since } }))} />);
  expect(within(tile()).queryByText(/⊘/)).not.toBeInTheDocument();
});

test('a blocked task shows every blocker once, on its own ⊘ line with the full text as title, outside approval too; the footer keeps its own status and no button (#54)', () => {
  const blocked = task({ item: { ...task().item, blockedBy: ['274', '280'] } });
  const { rerender } = render(<Flow state={state(blocked)} />);
  const line = within(tile()).getByText('⊘ bloqueada por 274, 280');
  expect(line).toHaveClass('truncate', 'text-muted-foreground', 'text-xs');
  expect(line).toHaveAttribute('title', '⊘ bloqueada por 274, 280');
  expect(within(tile()).getAllByText(/bloqueada por/)).toHaveLength(1);
  expect(within(tile()).getByText('nova')).toBeInTheDocument(); // the footer's own status, not the blocker
  expect(within(tile()).queryByRole('button', { name: /^(iniciar|abrir|continuar)$/ })).not.toBeInTheDocument();
  rerender(<Flow state={state(task({ item: { ...task().item, blockedBy: ['274'] } }), [working({ status: 'waiting' })])} />);
  expect(within(tile()).getByText('⊘ bloqueada por 274')).toBeInTheDocument();
});

test('an epic hides the ⊘ line when its blockers are only its children, and names only the others when there are (#54)', () => {
  const child = (n: string): Task => ({ ...task(), item: { ...task().item, itemId: `C${n}`, id: n, title: `Child ${n}` } });
  const epic = (blockedBy: string[]): Task => task({ item: { ...task().item, blockedBy, children: ['C2', 'C3'], epic: { follows: 'behind', switchAt: 'dev' } } });
  const withChildren = (e: Task): State => ({ ...state(e), tasks: [e, child('2'), child('3')] });
  const { rerender } = render(<Flow state={withChildren(epic(['2', '3']))} />);
  expect(within(tile()).queryByText(/⊘/)).not.toBeInTheDocument();
  rerender(<Flow state={withChildren(epic(['2', '274']))} />);
  expect(within(tile()).getByText('⊘ bloqueada por 274')).toBeInTheDocument();
});

test('the status in muted: the worktree setup (iniciando, then its step), a spawn error in full as its title; iniciar stays on an error (#351, #542)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Flow state={state(task({ setup: { consoleId: 'setup:I1' } }))} />);
  expect(within(tile()).getByText('iniciando')).toBeInTheDocument();
  rerender(<Flow state={state(task({ setup: { consoleId: 'setup:I1', step: 'RUN pnpm install' } }))} />);
  expect(within(tile()).getByText('preparando: RUN pnpm install')).toHaveClass('text-muted-foreground');
  rerender(<Flow state={state(task({ error: 'pty: posix_spawnp failed.' }))} />);
  expect(within(tile()).getByText('pty: posix_spawnp failed.')).toHaveAttribute('title', 'pty: posix_spawnp failed.');
  await user.click(within(tile()).getByRole('button', { name: 'iniciar' }));
  expect(await screen.findByRole('dialog', { name: 'Iniciar #1' })).toBeInTheDocument();
});

test('abrir focuses the task\'s activity on its agent session, a waiting one included; the task open in the panel wears its status ring, ring\'s own with no status (#542)', async () => {
  const user = userEvent.setup();
  const focusDetached = vi.fn(async () => true);
  vi.stubGlobal('hive', { focusDetached });
  const waiting = working({ status: 'waiting', freeSession: true, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', runId: 'W2' });
  const terminal = { terminalId: 'W9', activityId: activityIdOf('I1'), startedAt: since, cwd: '/repo' };
  const { rerender } = render(<Flow state={withPointedWork({ ...state(task(), [waiting]), terminals: [terminal] })} selectedId="I1" />);
  expect(tile()).toHaveClass('ring-2', 'ring-waiting/35');
  expect(tile()).toHaveAttribute('aria-current', 'true');
  await user.click(within(tile()).getByRole('button', { name: 'abrir' }));
  expect(focusDetached).toHaveBeenCalledWith('W2');
  rerender(<Flow state={state(task())} selectedId="I1" />);
  expect(tile()).toHaveClass('ring-2', 'ring-ring/35');
  rerender(<Flow state={state(task())} />);
  expect(tile()).not.toHaveClass('ring-2');
  expect(tile()).not.toHaveAttribute('aria-current');
});

test('continuar posts continue, aprovar posts approve, excluir in a delete-activity stage posts its start; none of them opens the panel (#283, #349, #542)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const { rerender } = render(<Flow state={state(task({ stopped: true }), [], { activityRecords: records })} onOpen={onOpen} />);
  await user.click(within(tile()).getByRole('button', { name: 'continuar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/continue', expect.objectContaining({ method: 'POST' }));
  rerender(<Flow state={state(task({ approval: { since } }))} onOpen={onOpen} />);
  await user.click(within(tile()).getByRole('button', { name: 'aprovar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approve', expect.objectContaining({ method: 'POST' })));
  rerender(<Flow state={state(task({ stage: 'done' }))} onOpen={onOpen} />);
  const remove = within(tile()).getByRole('button', { name: 'excluir' });
  expect(remove).toHaveAttribute('data-variant', 'destructive');
  await user.click(remove);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/start', expect.objectContaining({ method: 'POST', body: undefined }));
  expect(onOpen).not.toHaveBeenCalled();
});

test('continuar after a delete posts continue to the newest record when the task has no live activity (#629)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state(task(), [], { activityRecords: records })} />);
  await user.click(within(tile()).getByRole('button', { name: 'continuar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/continue', expect.objectContaining({ method: 'POST' }));
});

test('a task takes the focus on a click and names its task for the search (#584)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state(task())} />);
  await user.click(screen.getByText('#1 Task 1'));
  expect(tile()).toHaveFocus();
  expect(tile()).toHaveAttribute('data-task-id', 'I1');
});

test('a task with no session left and an open PR wears the review border and word; a session at work wins over it (#663)', () => {
  const reviewed = [{ id: 'a-I1', taskIds: ['I1'], sessions: [], prs: [{ url: 'https://github.com/acme/r/pull/9', state: 'open' as const }] }]; // #629: the record's
  const { rerender } = render(<Flow state={state(task({ stage: 'review', stopped: true }), [], { activityRecords: reviewed })} />);
  expect(tile()).toHaveClass('border-review');
  expect(within(tile()).getByText('aguardando review')).toHaveClass('text-review');
  rerender(<Flow state={state(task({ stage: 'review', workerId: 's1' }), [working()], { activityRecords: reviewed })} />);
  expect(tile()).toHaveClass('border-working');
  expect(within(tile()).getByText('trabalhando')).toBeInTheDocument();
});

test('the PR line shows the own repository\'s stack and how much of it merged, then the PRs of other repositories; only with a slice PR or several repositories (#698)', () => {
  const APP = 'https://github.com/acme/app/pull/';
  const withPrs = (prs: TaskPr[]) => state(task(), [], { activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions: [], prs }] });
  const stack: TaskPr[] = [
    { url: `${APP}7`, state: 'merged', slice: { k: 1, type: 'stacked' } }, { url: `${APP}8`, state: 'open', slice: { k: 2, type: 'stacked' } },
  ];
  const site: TaskPr = { url: 'https://github.com/acme/site/pull/3', state: 'open' };
  const { rerender } = render(<Flow state={withPrs([{ url: `${APP}7`, state: 'open' }])} />);
  expect(tile()).not.toHaveTextContent(/mergeados|\+\d/); // one PR without a slice: as before
  rerender(<Flow state={withPrs(stack)} />);
  expect(within(tile()).getByText('pilha 1/2 mergeados')).toHaveClass('truncate');
  rerender(<Flow state={withPrs([...stack, site])} />);
  expect(within(tile()).getByText('pilha 1/2 mergeados · +1 site')).toBeInTheDocument();
  rerender(<Flow state={withPrs([...stack, site, { url: 'https://github.com/acme/docs/pull/1', state: 'open' }])} />);
  expect(within(tile()).getByText('pilha 1/2 mergeados · +2 repos')).toBeInTheDocument();
  rerender(<Flow state={withPrs([{ url: `${APP}7`, state: 'open' }, site])} />);
  expect(within(tile()).getByText('+1 site')).toBeInTheDocument();
});

test('a commands stage shows the command running after the setup\'s own line and ver saída, which opens its locked tab; after a failure, the failure in the viewer\'s language with the same link (#755)', async () => {
  const user = userEvent.setup();
  const openOutput = vi.fn();
  const checks: Stage = { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build', 'lint'], stopOnFailure: true };
  const at = (work: Partial<Activity>, made: Parameters<typeof withWork>[3] = {}): State => withWork(state(task({ stage: 'checks' }), [], { stages: [...stages, checks] }), 'I1', work, made);
  const flow = (s: State) => <StageOutputContext.Provider value={openOutput}><Flow state={s} /></StageOutputContext.Provider>;
  const running = { stage: 'checks', at: 1, ptyId: 'P1', runId: 'R1', failed: [], workerId: 'w1', started: [] };
  const { rerender } = render(flow(at({ commands: running, setup: { consoleId: 'setup:I1' } })));
  expect(within(tile()).getByText('iniciando')).toBeInTheDocument(); // the worktree setup's line first
  rerender(flow(at({ commands: running })));
  expect(within(tile()).getByText('executando lint · 2/2')).toBeInTheDocument();
  await user.click(within(tile()).getByRole('button', { name: 'ver saída' }));
  expect(openOutput).toHaveBeenCalledWith('I1', 'stage:checks', 'R1');
  rerender(flow(at({ stopped: true, error: 'checks failed: lint (1)' })));
  expect(within(tile()).getByText('checks falharam: lint (1)')).toBeInTheDocument();
  expect(within(tile()).queryByRole('button', { name: 'ver saída' })).not.toBeInTheDocument(); // no record of the execution: never an unscoped tab
  rerender(flow(at({ stopped: true, error: 'checks failed: lint (1)' }, { result: { commands: { verdict: 'failed', output: 'x', runId: 'R1' } } })));
  await user.click(within(tile()).getByRole('button', { name: 'ver saída' }));
  expect(openOutput).toHaveBeenLastCalledWith('I1', 'stage:checks', 'R1'); // the verdict's execution once the run is gone
  rerender(flow(at({ stopped: true, error: 'slug hive-1 is used by 2' })));
  expect(within(tile()).queryByRole('button', { name: 'ver saída' })).not.toBeInTheDocument();
});

test('a task waiting for CI reads aguardando PR, then aguardando CI · n/total in the working colour; its failure reads in the viewer\'s language, with no ver saída (#834)', () => {
  const ciStage: Stage = { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false };
  const at = (work: Partial<Activity>): State => withWork(state(task({ stage: 'ci' }), [], { stages: [...stages, ciStage] }), 'I1', work);
  const wait = { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [] };
  const { rerender } = render(<Flow state={at({ ci: { ...wait, waitingPr: true } })} />);
  expect(within(tile()).getByText('aguardando PR')).toBeInTheDocument();
  rerender(<Flow state={at({ ci: { ...wait, done: 2, total: 5 } })} />);
  expect(within(tile()).getByText('aguardando CI · 2/5')).toHaveClass('text-working');
  rerender(<Flow state={at({ stopped: true, error: 'CI failed: build, test' })} />);
  expect(within(tile()).getByText('CI falhou: build, test')).toBeInTheDocument();
  expect(within(tile()).queryByRole('button', { name: 'ver saída' })).not.toBeInTheDocument();
});

test('a failed sync adds sem sync · partiu da base da fork to the card, never its status, and a block to the panel; a wait whose workflows await a maintainer reads CI aguarda mantenedor in muted, one with no re-run CI falhou (#854)', () => {
  const sync = { result: 'diverged' as const, mode: 'github' as const, commits: 2, base: 'me:main', sha: 'a1b2c3d', at: '2026-10-08T10:00:00.000Z' };
  const failed = withWork(state(task()), 'I1', { sync });
  const { rerender } = render(<Flow state={failed} />);
  expect(within(tile()).getByText('sem sync · partiu da base da fork')).toBeInTheDocument();
  rerender(<Flow state={withWork(state(task()), 'I1', { sync: { ...sync, result: 'synced' } })} />);
  expect(within(tile()).queryByText('sem sync · partiu da base da fork')).not.toBeInTheDocument();
  const ciStage: Stage = { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: true };
  const at = (work: Partial<Activity>): State => withWork(state(task({ stage: 'ci' }), [], { stages: [...stages, ciStage] }), 'I1', work);
  const wait = { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [] };
  rerender(<Flow state={at({ ci: { ...wait, awaiting: 3 } })} />);
  expect(within(tile()).getByText('CI aguarda mantenedor')).toHaveClass('text-muted-foreground');
  rerender(<Flow state={at({ ci: { ...wait, noRerun: true } })} />);
  expect(within(tile()).getByText('CI falhou')).toHaveClass('text-destructive');
});

test('the panel\'s sync block says why and from what the worktree started; the CI notice says who must act (#854)', () => {
  const sync = { result: 'conflict' as const, mode: 'local' as const, files: ['src/a.ts'], base: 'me:main', sha: 'a1b2c3d', at: '2026-10-08T10:00:00.000Z' };
  const work = withWork(state(task()), 'I1', { sync });
  const { unmount } = render(<SyncBlock task={work.tasks[0]} state={work} />);
  const block = screen.getByRole('region', { name: 'sincronização falhou' });
  expect(block).toHaveTextContent('a mescla local do original em me:main teve conflito em src/a.ts.');
  expect(block).toHaveTextContent('a worktree partiu da base da fork como estava.');
  expect(block).toHaveTextContent('me:main · a1b2c3d');
  unmount();
  const prs = [{ url: 'https://github.com/ex/app/pull/8812', state: 'open' as const }];
  const waiting = withWork(state(task()), 'I1', { ci: { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [], awaiting: 3 } }, { prs });
  const notice = render(<CiNotice task={waiting.tasks[0]} state={waiting} />);
  expect(screen.getByRole('region', { name: 'CI aguarda mantenedor' })).toHaveTextContent('os workflows de #8812 não executaram: aguardam a aprovação de um mantenedor de ex/app.');
  notice.unmount();
  const held = withWork(state(task()), 'I1', { ci: { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [], noRerun: true } });
  render(<CiNotice task={held.tasks[0]} state={held} />);
  expect(screen.getByRole('status')).toHaveTextContent('sem permissão para re-executar. a etapa espera um push novo ou um mantenedor.');
});

test('a task stopped with no transition or out of tries reads it in the viewer\'s language (#134)', () => {
  render(<Flow state={state(task({ stopped: true, error: 'no transition: verdict:failed' }))} />);
  expect(within(tile()).getByText('nenhuma transição para "falhou"')).toBeInTheDocument();
  cleanup();
  render(<Flow state={state(task({ stopped: true, error: 'tries out: verdict:redo · 3' }))} />);
  expect(within(tile()).getByText('esgotou · redo 3x')).toBeInTheDocument();
  setLanguage('en');
  cleanup();
  render(<Flow state={state(task({ stopped: true, error: 'no transition: approved' }))} />);
  expect(within(tile()).getByText('no transition for "approved"')).toBeInTheDocument();
});

test('a new task\'s face says so in muted text, no status colour; a blocked one too, its blocker on its own line (#727, #54)', () => {
  const { rerender } = render(<Flow state={state(task())} />);
  expect(within(tile()).getByText('nova')).toHaveClass('text-muted-foreground');
  rerender(<Flow state={state(task({ item: { ...task().item, blockedBy: ['9'] } }))} />);
  expect(within(tile()).getByText('nova')).toBeInTheDocument();
  expect(within(tile()).getByText('⊘ bloqueada por 9')).toBeInTheDocument();
});

test('a task out of tries reads destructive: border, ring, the status and abrir, which opens its details instead of continuar (#913)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const out = task({ stopped: true, error: 'tries out: verdict:failed · 3' });
  render(<Flow state={state(out, [], { activityRecords: records })} selectedId="I1" onOpen={onOpen} />);
  expect(tile()).toHaveClass('border-destructive', 'ring-destructive/35');
  const status = within(tile()).getByText('esgotou · falhou 3x');
  expect(status).toHaveClass('text-destructive', 'truncate');
  expect(status).toHaveAttribute('title', 'esgotou · falhou 3x');
  expect(within(tile()).queryByRole('button', { name: 'continuar' })).not.toBeInTheDocument();
  await user.click(within(tile()).getByRole('button', { name: 'abrir' }));
  expect(onOpen).toHaveBeenCalledWith('I1');
  expect(taskAction(out, state(out, [], { activityRecords: records }))).toBe('details');
});

test('a failed start reads destructive with its short message in the viewer\'s language, never the raw text; iniciar stays; a live worker\'s status wins (#945)', () => {
  const error = `${SPAWN_FAILED}/repo has changes that are not committed:\n M src/app.ts`;
  const { rerender } = render(<Flow state={state(task({ error }))} />);
  expect(tile()).toHaveClass('border-destructive');
  const status = within(tile()).getByText('o workspace tem mudanças não commitadas: faça commit ou stash e inicie de novo');
  expect(status).toHaveClass('text-destructive');
  expect(tile()).not.toHaveTextContent('/repo');
  expect(within(tile()).getByRole('button', { name: 'iniciar' })).toBeInTheDocument();
  rerender(<Flow state={state(task({ error, workerId: 's1' }), [working()])} />);
  expect(within(tile()).getByText('trabalhando')).toHaveClass('text-working');
  setLanguage('en');
  rerender(<Flow state={state(task({ error: `${SPAWN_FAILED}pty: posix_spawnp failed.` }))} />);
  expect(within(tile()).getByText('the terminal could not start')).toHaveClass('text-destructive');
});

test('a show epic reads aguarda filhas · done/total in muted, before any other state, with no button and no auto badge, in both languages (#31)', () => {
  const epic = task({ item: { ...task().item, children: ['C1', 'C2', 'C3'], closedChildren: ['C1'], epic: { follows: 'behind', switchAt: 'dev' } } });
  const { rerender } = render(<Flow state={state(epic)} />);
  expect(within(tile()).getByText('aguarda filhas · 1/3')).toHaveClass('text-muted-foreground');
  expect(within(tile()).queryByRole('button', { name: /^(iniciar|abrir|continuar|excluir|aprovar)$/ })).not.toBeInTheDocument();
  expect(within(tile()).queryByText('auto')).not.toBeInTheDocument();
  expect(taskAction(epic, state(epic))).toBeUndefined();
  setLanguage('en');
  rerender(<Flow state={state(epic)} />);
  expect(within(tile()).getByText('waiting for children · 1/3')).toBeInTheDocument();
});

test('a show epic whose end action was refused shows its error in destructive instead of the wait (#31)', () => {
  const epic = task({ error: 'archive refused', item: { ...task().item, children: ['C1'], epic: { follows: 'behind', switchAt: 'dev' } } });
  render(<Flow state={state(epic)} />);
  expect(within(tile()).queryByText(/aguarda filhas/)).not.toBeInTheDocument();
  expect(tile()).toHaveClass('border-destructive');
});

// #34: 1 lists five children: 2 in the last stage (done), 3 at work, 4 new in review, 5 closed with no task, 6 open with no task
type Links = Pick<Item, 'parent' | 'children' | 'closedChildren'>;
const treeTask = (id: string, stage: string, links: Links, extra: Partial<WithWork> = {}): WithWork =>
  task({ item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...links }, stage, ...extra });
const FAMILY = [
  treeTask('1', 'dev', { children: ['I2', 'I3', 'I4', 'I5', 'I6'], closedChildren: ['I5'] }),
  treeTask('2', 'done', { parent: 'I1' }),
  treeTask('3', 'dev', { parent: 'I1' }, { workerId: 's1' }),
  treeTask('4', 'review', { parent: 'I1' }),
];
const family = (): State => state(FAMILY[0], [working({ activityId: activityIdOf('I3') })], { tasks: FAMILY });
const tileOf = (title: string): HTMLElement => screen.getByText(title).closest('li')!;

test('a child shows ↳ before its id and a root does not; a parent shows N filhas · done/N, one segment per direct child in its status colour, and no auto badge (#34)', () => {
  render(<Flow state={family()} />);
  expect(within(screen.getByText('#3 Task 3')).getByText('↳')).toHaveClass('font-mono', 'font-normal', 'text-muted-foreground');
  expect(within(screen.getByText('#1 Task 1')).queryByText('↳')).not.toBeInTheDocument();
  const parent = tileOf('#1 Task 1');
  expect(within(parent).getByText('5 filhas · 2/5')).toHaveClass('truncate');
  const segments = [...parent.querySelectorAll('[data-tree-bar] > span')];
  expect(segments.map((s) => s.className.match(/bg-[a-z-]+/)?.[0])).toEqual(['bg-muted-foreground', 'bg-working', 'bg-empty', 'bg-muted-foreground', 'bg-empty']);
  expect(within(parent).queryByText('auto')).not.toBeInTheDocument();
  expect(within(tileOf('#3 Task 3')).getByText('auto')).toBeInTheDocument();
  expect(within(parent).getByRole('button', { name: 'focar ›' })).toBeInTheDocument(); // #35: Flow wires the focus
});

test('focar › shows with onFocusTree and calls it with the parent\'s itemId; the card TreeHoverContext names draws the foreground border and its ring, another keeps its status border (#34, #36)', async () => {
  const user = userEvent.setup();
  const onFocusTree = vi.fn();
  const s = family();
  const NO_DRAG = { draggable: true as const, onDragStart: () => {}, onDragEnd: () => {}, onDragOver: () => {}, onDrop: () => {} };
  const card = (itemId: string) => (
    <FlowTask task={s.tasks.find((c) => c.item.itemId === itemId)!} state={s} dragHandlers={NO_DRAG} isDimmed={false} isDropBefore={false} isSelected={false} onFocusTree={onFocusTree} />
  );
  render(<TreeHoverContext.Provider value={{ hoveredId: 'I1', setHoveredId: () => {} }}><ul>{card('I1')}{card('I3')}</ul></TreeHoverContext.Provider>);
  await user.click(screen.getByRole('button', { name: 'focar ›' }));
  expect(onFocusTree).toHaveBeenCalledWith('I1');
  expect(tileOf('#1 Task 1')).toHaveClass('border-foreground', 'ring-2', 'ring-foreground/25');
  expect(tileOf('#3 Task 3')).not.toHaveClass('border-foreground');
  expect(tileOf('#3 Task 3')).toHaveClass('border-working');
});

test('a card out of the focus reads at .3; a dragged one reads at the drag\'s .5, faded or not (#35)', () => {
  const s = state(task());
  const one = s.tasks.find((c) => c.item.itemId === 'I1')!;
  const NO_DRAG = { draggable: true as const, onDragStart: () => {}, onDragEnd: () => {}, onDragOver: () => {}, onDrop: () => {} };
  const face = (isDimmed: boolean, isFaded: boolean) => (
    <ul><FlowTask task={one} state={s} dragHandlers={NO_DRAG} isDimmed={isDimmed} isDropBefore={false} isSelected={false} isFaded={isFaded} /></ul>
  );
  const { rerender } = render(face(false, true));
  expect(tile()).toHaveClass('opacity-30');
  rerender(face(true, true));
  expect(tile()).toHaveClass('opacity-50');
  expect(tile()).not.toHaveClass('opacity-30');
  rerender(face(false, false));
  expect(tile()).not.toHaveClass('opacity-30');
});

// Radix draws the content twice (visible, and a visually hidden role="tooltip" copy): read the role, not the text.
test('a cut title shows in full in a tooltip on hover, hiding the card\'s drag hint meanwhile; a title that fits leaves only the hint (#91, #284)', async () => {
  render(<Flow state={state(task())} />);
  const title = screen.getByText('#1 Task 1');
  const card = tile(); // read before the tooltip repeats the text
  const hint = card.getAttribute('title');
  fireEvent.pointerMove(title, { pointerType: 'mouse' });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expect(title).not.toHaveAttribute('title');
  fireEvent.pointerLeave(title, { pointerType: 'mouse' });
  Object.defineProperty(title, 'scrollHeight', { configurable: true, value: 48 });
  Object.defineProperty(title, 'clientHeight', { configurable: true, value: 32 });
  fireEvent.pointerMove(title, { pointerType: 'mouse' });
  expect(await screen.findByRole('tooltip')).toHaveTextContent('#1 Task 1');
  expect(title).toHaveAttribute('title', '');
  expect(card).toHaveAttribute('title', hint ?? '');
  cleanup();
});
