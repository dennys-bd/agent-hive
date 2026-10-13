import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { StartDialog } from '@/components/StartDialog';
import { setLanguage, t } from '@/i18n';
import { CreateTargetsContext, type CreateTargets } from '@/lib/create-targets';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { BaseOptions, Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DISCARD_FAILED, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

const stages: Stage[] = [
  { name: 'inbox', from: { board: ['Inbox'] } }, // no prompt: a task created here skips it
  { name: 'backlog', from: { board: ['Todo'] }, prompt: 'x' }, { name: 'dev', from: { board: ['Doing'] }, prompt: 'x' },
  { name: 'in review', from: { board: ['Review'] }, prompt: 'x', approval: true }, { name: 'done', from: { board: ['Done'] }, prompt: 'x' },
];
const task = (itemId: string, id: string, title: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId, id, title, body: '', url: '' }, stage: 'backlog', boardColumn: 'Todo', auto: true, workspace: 'site', ...extra,
});
const LANDING = task('I4', 'SITE-4', 'Landing copy review', { stage: 'dev' });
const HERO = task('I9', 'SITE-9', 'Landing hero for teams');
const state = (tasks: Task[] = [LANDING, HERO]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive', 'site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const SHIPPED = task('I7', 'SITE-7', 'Shipped pricing page', { stage: 'done' });
// #774: done with no prompt, the last stage: a task there has no stage left to run
const finished = (): State => ({ ...state([LANDING, HERO, SHIPPED]), stages: stages.map((s) => (s.name === 'done' ? { name: s.name, from: s.from } : s)) });
const AT = '2026-10-13T10:00:00.000Z';
const BASES: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let created = 0;
let sourceAnswer: unknown = { id: '5', itemId: 'board:PVTI_5' };
let bases: BaseOptions = BASES;
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/bases')) return reply(bases);
  if (url === '/tasks') {
    const sent = JSON.parse(String(_init?.body ?? '{}')) as { source?: string };
    if (sent.source !== undefined && sent.source !== 'hive') return reply(sourceAnswer, 201);
    created += 1; return reply({ id: `HIVE-${created}`, itemId: `local:${created}` }, 201); }
  if (url.endsWith('/open')) return reply({ ptyId: 'W1' });
  return reply({ ok: true });
});
const posts = (): [string, unknown][] => fetchMock.mock.calls
  .filter(([, init]) => init?.method === 'POST').map(([url, init]) => [String(url), init?.body === undefined ? undefined : JSON.parse(String(init.body))]);

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); created = 0; bases = BASES; sourceAnswer = { id: '5', itemId: 'board:PVTI_5' }; });
afterEach(() => vi.unstubAllGlobals());

test('Nova atividade opens on the closed task field; Enter opens the search, each task with its stage; a pick shows the base, the local switch and where the stages stop, and executar etapas starts it (redesign 11, 2c)', async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<StartDialog state={state()} onStarted={onStarted} onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'Nova atividade' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'tarefa' })).toHaveFocus(); // the field, closed: no list until the user opens it
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('combobox', { name: 'tarefa' })).toHaveFocus();
  const hero = screen.getByRole('option', { name: /#SITE-9 Landing hero for teams.*backlog/ });
  await user.click(hero);
  await screen.findByRole('combobox', { name: 'origin/main' });
  expect(screen.getByRole('switch', { name: 'executar no local, sem worktree' })).not.toBeChecked();
  expect(screen.getByText('backlog → dev → in review')).toBeInTheDocument();
  expect(screen.getByText('in review · aguardando aprovação')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false }]]);
  expect(onStarted).toHaveBeenCalledWith('I9');
});

test('a typed term offers + criar tarefa in hive: the task is created manual in the first stage with a prompt and the workspace, started, then handed to the flow (redesign 11)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { rerender } = render(<StartDialog state={state()} workspace="site" onStarted={vi.fn()} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('landing');
  const create = screen.getByRole('option', { name: /criar tarefa "landing".*em hive/ });
  expect(screen.getAllByRole('option').at(-1)).toBe(create);
  await user.click(create);
  await waitFor(() => expect(posts()[0]).toEqual(['/tasks', { title: 'landing', stage: 'backlog', auto: false, workspace: 'site', source: 'hive' }]));
  rerender(<StartDialog state={state([LANDING, HERO, task('local:1', 'HIVE-1', 'landing', { created: true, auto: false })])} workspace="site" onStarted={vi.fn()} onClose={onClose} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.keyboard('{Control>}{Enter}{/Control}'); // ⌘↵
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts().slice(1)).toEqual([['/tasks/local%3A1/start', { base: null, local: false }], ['/tasks/local%3A1/auto', { auto: true }]]);
});

test('a task created here and never started is removed on cancel; a picked task is left alone (redesign 11)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={state()} onStarted={vi.fn()} onClose={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('temp');
  await user.click(screen.getByRole('option', { name: /criar tarefa "temp"/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  expect(posts().at(-1)).toEqual(['/tasks/local%3A1/close', undefined]);
});

test('sessão livre shows the agent and the session and opens a new claude session on the task (redesign 11)', async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<StartDialog state={state()} onStarted={onStarted} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-4/ }));
  await user.click(screen.getByRole('radio', { name: 'sessão livre' }));
  expect(screen.getByText('sem prompts automáticos. você conduz o trabalho na tarefa e move a etapa quando quiser.')).toBeInTheDocument();
  expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: 'agente' })).toHaveTextContent('claude');
  expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: 'sessão' })).toHaveTextContent('nova');
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /sessão livre/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I4/open', { kind: 'claude', base: null, local: false }]]);
  expect(onStarted).not.toHaveBeenCalled();
});

test('every task created here and not the one started is removed once the dialog ends (redesign 11)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<StartDialog state={state()} onStarted={vi.fn()} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('one');
  await user.click(screen.getByRole('option', { name: /criar tarefa "one"/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('two');
  await user.click(screen.getByRole('option', { name: /criar tarefa "two"/ }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-9/ }));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts().slice(2)).toEqual([['/tasks/I9/start', { base: null, local: false }], ['/tasks/local%3A1/close', undefined], ['/tasks/local%3A2/close', undefined]]);
});

test('while the task still needs its workspace neither the button nor ⌘↵ starts it (redesign 11)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, needsWorkspace: true };
  render(<StartDialog state={state()} onStarted={vi.fn()} onClose={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-9/ }));
  await screen.findByRole('combobox', { name: 'workspace' });
  expect(screen.getByRole('button', { name: /executar etapas/ })).toBeDisabled();
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(posts()).toEqual([]);
});

test('Escape with the task list open closes the list alone and the focus goes back to the field; a second Escape closes the dialog (redesign 11)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<StartDialog state={state()} onStarted={vi.fn()} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  expect(screen.getAllByRole('option')).not.toHaveLength(0);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'tarefa' })).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Iniciar #id from a task: its title and stage under the title, no task field; a task base shows the stacked-PR switch, on by default, and the start posts it; sessão livre hides it (redesign 11, 2a, #217)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, tasks: [{ ref: 'hive/11-parent', id: 'HIVE-11', title: '510 a 516' }] };
  const onClose = vi.fn();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Iniciar #SITE-9' });
  expect(dialog).toHaveAccessibleDescription('Landing hero for teams · etapa backlog');
  expect(within(dialog).queryByRole('button', { name: 'tarefa' })).not.toBeInTheDocument();
  await user.click(await screen.findByRole('combobox', { name: 'origin/main' }));
  expect(screen.queryByRole('switch', { name: /avisar o worker/ })).not.toBeInTheDocument(); // not on the default base
  await user.click(screen.getByRole('option', { name: /#HIVE-11 510 a 516/ }));
  const stacked = screen.getByRole('switch', { name: 'avisar o worker de HIVE-11 · PR empilhado' });
  expect(stacked).toBeChecked();
  await user.click(screen.getByRole('radio', { name: 'sessão livre' }));
  expect(screen.queryByRole('switch', { name: /avisar o worker/ })).not.toBeInTheDocument(); // a session gets no stage prompt to tell
  await user.click(screen.getByRole('radio', { name: 'executar etapas' }));
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I9/start', { base: 'hive/11-parent', tellWorker: true, local: false }]]);
});

test('abrir sessão on a task with its worktree opens on sessão livre with no base; the session starts where a normal start would resume, lists new and then the sessions no worker holds, newest first, and the open posts the pick (redesign 11, 2b, #237)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, hasWorktree: true };
  const sessions = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((id, i) => ({ id: `${id}-0000-4000-8000-00000000000${i}`, startedAt: `2026-09-22T1${i}:00:00.000Z`, stages: ['dev'], agent: 'claude' as const, lastUsedAt: `2026-09-22T1${i}:00:00.000Z` }));
  const continuable = task('I4', 'SITE-4', 'Landing copy review', { stage: 'dev', worktree: '/wt/site-4' });
  const held: Worker = { id: 'm1', status: 'working', activityId: activityIdOf('I4'), runId: 'W1', freeSession: true, sessionId: sessions[0].id };
  const onContinue = withPointedWork({ ...state([continuable]), activityRecords: [{ id: 'a-I4', taskIds: ['I4'], sessions }], workers: [held], stages: stages.map((s) => (s.name === 'dev' ? { ...s, session: 'continue' as const } : s)) });
  const onClose = vi.fn();
  render(<StartDialog state={onContinue} taskId="I4" initialMode="free" onClose={onClose} />);
  expect(screen.getByRole('radio', { name: 'sessão livre' })).toBeChecked();
  const open = screen.getByRole('button', { name: /sessão livre/ });
  await waitFor(() => expect(open).toBeEnabled());
  expect(screen.queryByRole('combobox', { name: 'origin/main' })).not.toBeInTheDocument();
  const session = screen.getByRole('combobox', { name: 'sessão' });
  expect(session).toHaveTextContent('mesma da etapa anterior');
  await user.click(session);
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['nova', expect.stringMatching(/^mesma da etapa anteriorcontinua a sessão de dev · claude · dormindo há /), expect.stringMatching(/^bbbbbbbb · dev/)]);
  await user.click(screen.getByRole('option', { name: /^bbbbbbbb/ }));
  await user.click(open);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I4/open', { kind: 'claude', continueId: sessions[1].id }]]);
});

test('the session picker offers the last stage run\'s session as mesma da etapa anterior and names a free session sessão livre among the others (#812, #290)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, hasWorktree: true };
  const sessions = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-22T10:00:00.000Z' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', startedAt: '2026-09-22T11:00:00.000Z', stages: [], agent: 'claude' as const, lastUsedAt: '2026-09-22T11:00:00.000Z', free: true as const },
  ];
  const landing = task('I4', 'SITE-4', 'Landing copy review', { stage: 'dev', worktree: '/wt/site-4' });
  render(<StartDialog state={withPointedWork({ ...state([landing]), activityRecords: [{ id: 'a-I4', taskIds: ['I4'], sessions }] })} taskId="I4" initialMode="free" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /sessão livre/ })).toBeEnabled());
  await user.click(screen.getByRole('combobox', { name: 'sessão' }));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['nova', expect.stringMatching(/^mesma da etapa anteriorcontinua a sessão de dev · claude/), expect.stringMatching(/^bbbbbbbb · sessão livre · /)]);
});

test('executar etapas on a task whose activity was deleted posts continue to its newest record when the stage already ran, never a start (#283, #629)', async () => {
  const user = userEvent.setup();
  const ran = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-22T10:00:00.000Z', repo: true as const }];
  const deleted = { ...state([LANDING]), activityRecords: [{ id: 'old-I4', taskIds: ['I4'], sessions: ran }] };
  const onClose = vi.fn();
  render(<StartDialog state={deleted} taskId="I4" initialMode="stages" onClose={onClose} />);
  const run = screen.getByRole('button', { name: /executar etapas/ });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/activities/old-I4/continue', {}]]); // #808: a body now, with no size when no terminal shows
});

test('executar etapas after a free run in the stage posts a start, never a continue (#812)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, hasWorktree: true };
  const ran = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-22T10:00:00.000Z' }];
  const adjusted = task('I4', 'SITE-4', 'Landing copy review', { stage: 'dev', worktree: '/wt/site-4', freeSessionStage: 'dev' });
  const onClose = vi.fn();
  render(<StartDialog state={withPointedWork({ ...state([adjusted]), activityRecords: [{ id: 'a-I4', taskIds: ['I4'], sessions: ran }] })} taskId="I4" initialMode="stages" onClose={onClose} />);
  const run = screen.getByRole('button', { name: /executar etapas/ });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts().map(([url]) => url)).toEqual(['/tasks/I4/start']);
});

test('the base list shows no remote branch until a search surfaces it (#131)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, local: ['feature-x'], remote: ['origin/feature-y'] };
  render(<StartDialog state={state()} taskId="I9" onClose={vi.fn()} />);
  await user.click(await screen.findByRole('combobox', { name: 'origin/main' }));
  expect(screen.getByRole('option', { name: 'feature-x' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'origin/feature-y' })).not.toBeInTheDocument();
  await user.keyboard('feature-y');
  expect(screen.getByRole('option', { name: 'origin/feature-y' })).toBeInTheDocument();
});

test('a sessão livre open that answers after the dialog closed attaches nothing: the task carries the session (#351)', async () => {
  const user = userEvent.setup();
  const focusDetached = vi.fn(async () => true);
  vi.stubGlobal('hive', { focusDetached });
  let answer: (res: Response) => void = () => undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/open')) return new Promise<Response>((resolve) => { answer = resolve; });
    return reply(url.endsWith('/bases') ? bases : { ok: true });
  }));
  const onClose = vi.fn();
  render(<StartDialog state={state()} taskId="I4" initialMode="free" onClose={onClose} />);
  const open = screen.getByRole('button', { name: /sessão livre/ });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  answer(reply({ ptyId: 'W1' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(focusDetached).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('onActivity hears the activity a start or a free session opened, whichever mode (#587)', async () => {
  const user = userEvent.setup();
  const onActivity = vi.fn();
  render(<StartDialog state={state()} taskId="I9" initialMode="free" onActivity={onActivity} onClose={vi.fn()} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() => expect(onActivity).toHaveBeenCalledWith('I9'));
});

test('while a start waits on the worktree setup the button says iniciando…, then preparando a worktree…, never the step\'s own command (#351)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementationOnce(async () => reply(BASES)).mockImplementationOnce(() => new Promise<Response>(() => {})); // /start never answers
  const { rerender } = render(<StartDialog state={state()} taskId="I9" onClose={vi.fn()} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(await screen.findByRole('button', { name: 'iniciando…' })).toBeDisabled();
  rerender(<StartDialog state={state([LANDING, { ...HERO, setup: { consoleId: 'setup:I9', step: 'RUN pnpm install' } }])} taskId="I9" onClose={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'preparando a worktree…' })).toBeDisabled();
  expect(screen.queryByText(/RUN pnpm install/)).not.toBeInTheDocument();
});

test('a title from the search\'s + criar tarefa creates that task once on arrival and picks it (#584)', async () => {
  const onClose = vi.fn();
  const { rerender } = render(<StartDialog state={state()} title="Fix login" onStarted={vi.fn()} onClose={onClose} />);
  await waitFor(() => expect(posts()).toEqual([['/tasks', { title: 'Fix login', stage: 'backlog', auto: false, source: 'hive' }]]));
  rerender(<StartDialog state={state([LANDING, HERO, task('local:1', 'HIVE-1', 'Fix login', { created: true, auto: false })])} title="Fix login" onStarted={vi.fn()} onClose={onClose} />);
  expect(screen.getByRole('button', { name: 'tarefa' })).toHaveTextContent('HIVE-1 Fix login');
  expect(posts()).toHaveLength(1);
});

test('confirm follows its binding: rebound to Alt+Enter, Ctrl+Enter starts nothing and Alt+Enter starts (#585)', async () => {
  setShortcuts({ confirm: 'Alt+Enter' });
  onTestFinished(() => setShortcuts({}));
  const onClose = vi.fn();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  const dialog = screen.getByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Enter', code: 'Enter', ctrlKey: true });
  expect(posts()).toEqual([]);
  expect(within(dialog).getByRole('button', { name: /executar etapas/ })).toHaveTextContent('Alt+Enter');
  fireEvent.keyDown(dialog, { key: 'Enter', code: 'Enter', altKey: true });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false }]]);
});

test('the switchStartMode key flips executar etapas and sessão livre while the dialog is open (#585)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={vi.fn()} />);
  const free = (): HTMLElement => screen.getByRole('radio', { name: 'sessão livre' });
  expect(free()).toHaveAttribute('aria-checked', 'false');
  await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}'); // Ctrl+Shift+M off macOS
  expect(free()).toHaveAttribute('aria-checked', 'true');
  await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
  expect(free()).toHaveAttribute('aria-checked', 'false');
});

test('picking a task with no stage left to run lands on sessão livre with executar etapas off and says why; a pick with stages to run turns it back on and leaves the mode alone (#774)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={finished()} onStarted={vi.fn()} onClose={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-7/ }));
  expect(screen.getByRole('radio', { name: 'sessão livre' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'executar etapas' })).toBeDisabled();
  expect(screen.getByText('nenhuma etapa para executar a partir de done.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: /sessão livre/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-9/ }));
  expect(screen.getByRole('radio', { name: 'executar etapas' })).toBeEnabled();
  expect(screen.getByRole('radio', { name: 'sessão livre' })).toBeChecked();
  expect(screen.queryByText(/nenhuma etapa para executar/)).not.toBeInTheDocument();
  expect(screen.getByText('sem prompts automáticos. você conduz o trabalho na tarefa e move a etapa quando quiser.')).toBeInTheDocument();
});

test('Iniciar #id on a task with no stage left to run opens on sessão livre though asked for executar etapas, and the switchStartMode key leaves it there (#774)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={finished()} taskId="I7" initialMode="stages" onClose={vi.fn()} />);
  const free = screen.getByRole('radio', { name: 'sessão livre' });
  expect(free).toBeChecked(); // the first frame already: the switch is the initial state, not an effect
  expect(screen.getByRole('radio', { name: 'executar etapas' })).toBeDisabled();
  await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}'); // Ctrl+Shift+M off macOS
  expect(free).toBeChecked();
});

test('the dialog\'s children may shrink below their content, so a long title truncates, and the closed task field carries the picked task\'s full label as its tooltip (#774)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={state()} onClose={vi.fn()} />);
  expect(screen.getByRole('dialog')).toHaveClass('*:min-w-0'); // jsdom lays nothing out: the overflow itself is checked by eye
  expect(screen.getByRole('button', { name: 'tarefa' })).not.toHaveAttribute('title');
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-9/ }));
  expect(screen.getByRole('button', { name: 'tarefa' })).toHaveAttribute('title', '#SITE-9 Landing hero for teams');
});

const TO_BOARD: CreateTargets = { hiveSource: true, createIn: 'board', sources: ['board'] };
const toBoard = (ui: ReactElement) => <CreateTargetsContext.Provider value={TO_BOARD}>{ui}</CreateTargetsContext.Provider>;

test('on a source the typed task is held: its row comes first, and neither the pick nor a cancel creates anything (#846)', async () => {
  const user = userEvent.setup();
  render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={vi.fn()} />));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('landing');
  const rows = screen.getAllByRole('option', { name: /criar tarefa "landing"/ });
  expect(rows.map((r) => r.textContent?.endsWith('em board') ? 'board' : 'hive')).toEqual(['board', 'hive']);
  await user.click(rows[0]);
  expect(screen.getByText(t('start.held', { title: 'landing', source: 'board' }))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  expect(posts()).toEqual([]);
});

test('starting a held task creates it on its source, then starts it once the state holds it (#846)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { rerender } = render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={onClose} />));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('landing');
  await user.click(screen.getAllByRole('option', { name: /criar tarefa "landing"/ })[0]);
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(posts()).toEqual([['/tasks', { title: 'landing', stage: 'backlog', auto: false, source: 'board' }]]));
  rerender(toBoard(<StartDialog state={state([LANDING, HERO, task('board:PVTI_5', '5', 'landing')])} onStarted={vi.fn()} onClose={onClose} />));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts().slice(1)).toEqual([['/tasks/board%3APVTI_5/start', { base: null, local: false }], ['/tasks/board%3APVTI_5/auto', { auto: true }]]);
});

test('a create that answers a notice leaves the dialog open with it and starts nothing (#846)', async () => {
  sourceAnswer = { itemId: 'board:PVTI_5', notice: 'filtered' };
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={onClose} />));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('landing');
  await user.click(screen.getAllByRole('option', { name: /criar tarefa "landing"/ })[0]);
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('start.notInFlow', { source: 'board' }));
  expect(posts()).toHaveLength(1);
  expect(onClose).not.toHaveBeenCalled();
});

test('picking an existing task after holding a source entry drops the entry: the pick starts, nothing is created (#846)', async () => {
  const user = userEvent.setup();
  render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={vi.fn()} />));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('landing');
  await user.click(screen.getAllByRole('option', { name: /criar tarefa "landing"/ })[0]);
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.click(screen.getByRole('option', { name: /#SITE-9/ }));
  expect(screen.queryByText(t('start.held', { title: 'landing', source: 'board' }))).not.toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false }]]));
});

test('while a source create is in flight the dialog cannot be closed, by the button or by escape: closing would leave the issue behind (#846)', async () => {
  let release: (r: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={onClose} />));
  await user.click(screen.getByRole('button', { name: 'tarefa' }));
  await user.keyboard('landing');
  await user.click(screen.getAllByRole('option', { name: /criar tarefa "landing"/ })[0]);
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  expect(screen.getByRole('button', { name: 'cancelar' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  release(reply(sourceAnswer, 201));
  await waitFor(() => expect(screen.getByRole('button', { name: 'cancelar' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  expect(onClose).toHaveBeenCalled();
});

test('an orphan worktree: the notice says so, Reuse is the default and sends no base; Discard shows the base and sends discardOrphan (#861)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, orphan: { worktree: true, branch: true } };
  const onClose = vi.fn();
  const { unmount } = render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
  expect(await screen.findByText(t('start.orphan.worktree'))).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'origin/main' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I9/start', {}]]);
  unmount();
  fetchMock.mockClear();
  const discarded = vi.fn();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={discarded} />);
  await user.click(await screen.findByRole('radio', { name: t('start.orphan.discard') }));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(discarded).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false, discardOrphan: true }]]);
});

test('a discard git refuses shows its words under the dialog\'s own heading, and the dialog stays (#861)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, orphan: { worktree: false, branch: true } };
  const original = fetchMock.getMockImplementation()!;
  onTestFinished(() => { fetchMock.mockImplementation(original); });
  fetchMock.mockImplementation(async (input, init) => (String(input).endsWith('/start') ? reply({ error: "the branch 'x' is not fully merged into HEAD", code: DISCARD_FAILED }, 409) : original(input, init)));
  const onClose = vi.fn();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
  expect(await screen.findByText(t('start.orphan.branch'))).toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: t('start.orphan.discard') }));
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(t('start.orphan.failed'));
  expect(alert).toHaveTextContent("the branch 'x' is not fully merged into HEAD");
  expect(onClose).not.toHaveBeenCalled();
});

test('sessão livre always shows the five run fields; a resume shows its session\'s own picks, disabled, and a new session opens with the explicit picks (#290)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, hasWorktree: true };
  const resumed = { id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: AT, stages: ['dev'], agent: 'claude' as const, lastUsedAt: AT, launch: { model: 'opus' } };
  const landing = task('I4', 'SITE-4', 'Landing copy review', { stage: 'dev', worktree: '/wt/site-4' });
  const onContinue = withPointedWork({ ...state([landing]), activityRecords: [{ id: 'a-I4', taskIds: ['I4'], sessions: [resumed] }], stages: stages.map((s) => (s.name === 'dev' ? { ...s, session: 'continue' as const } : s)) });
  const onClose = vi.fn();
  render(<StartDialog state={onContinue} taskId="I4" initialMode="free" onClose={onClose} />);
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('combobox', { name: 'agente' })).toHaveTextContent('claude');
  expect(dialog.getByRole('combobox', { name: 'sessão' })).toHaveTextContent('mesma da etapa anterior');
  expect(dialog.getByRole('combobox', { name: 'modelo' })).toHaveTextContent('opus');
  for (const name of ['modelo', 'agente especializado']) expect(dialog.getByRole('combobox', { name })).toBeDisabled();
  expect(dialog.getByRole('textbox', { name: 'argumentos' })).toBeDisabled();
  await user.click(dialog.getByRole('combobox', { name: 'sessão' }));
  await user.click(screen.getByRole('option', { name: 'nova' }));
  expect(dialog.getByRole('combobox', { name: 'modelo' })).toBeEnabled();
  expect(dialog.getByRole('combobox', { name: 'modelo' })).toHaveTextContent('padrão do claude');
  await user.type(dialog.getByRole('textbox', { name: 'argumentos' }), '--verbose');
  const open = screen.getByRole('button', { name: /sessão livre/ });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I4/open', { kind: 'claude', args: ['--verbose'] }]]);
});
