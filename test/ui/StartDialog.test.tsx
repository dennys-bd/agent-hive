import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { StartDialog } from '@/components/StartDialog';
import { ConsoleContext } from '@/hooks/use-console';
import { setLanguage, t } from '@/i18n';
import { CreateTargetsContext, type CreateTargets } from '@/lib/create-targets';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { BaseOptions, SetupRow, Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DISCARD_FAILED, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, withWork, type WithWork } from '../fixtures/work';

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
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
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

const CONSOLE = 'setup:I9';
const PREPARED: SetupRow[] = [{ kind: 'worktree', status: 'done', durationMs: 1200 }, { kind: 'branch', status: 'done', branch: 'hive/9-landing-hero', base: 'origin/main' }];
const PREPARING: SetupRow[] = [...PREPARED, { kind: 'step', status: 'running', label: 'pnpm install', header: 'RUN pnpm install', startedAt: AT }];
const SETUP_FAILED: SetupRow[] = [...PREPARED, { kind: 'step', status: 'failed', label: 'pnpm install', header: 'RUN pnpm install', durationMs: 34_000, code: '1' }];
const preparing = (): State => state([LANDING, { ...HERO, setup: { consoleId: CONSOLE, step: 'RUN pnpm install', rows: PREPARING } }]);
// The start held until the test answers it (#390): the bases first, then /start
function heldStart(): { answer(res: Response): void } {
  const held = { answer: (_res: Response): void => undefined };
  fetchMock.mockImplementationOnce(async () => reply(BASES)).mockImplementationOnce(() => new Promise<Response>((resolve) => { held.answer = resolve; }));
  return held;
}

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); created = 0; bases = BASES; sourceAnswer = { id: '5', itemId: 'board:PVTI_5' }; });
afterEach(() => vi.unstubAllGlobals());

test('Nova atividade opens on the closed task field; Enter opens the search, each task with its stage; a pick shows the base, the local switch and where the stages stop, and executar etapas starts it (redesign 11, 2c)', async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<StartDialog state={state()} onStarted={onStarted} onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'Nova atividade' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'tarefas' })).toHaveFocus(); // the field, closed: no list until the user opens it
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('combobox', { name: 'tarefas' })).toHaveFocus();
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.keyboard('one');
  await user.click(screen.getByRole('option', { name: /criar tarefa "one"/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.keyboard('two');
  await user.click(screen.getByRole('option', { name: /criar tarefa "two"/ }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  expect(screen.getAllByRole('option')).not.toHaveLength(0);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'tarefas' })).toHaveFocus();
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
  expect(within(dialog).queryByRole('button', { name: 'tarefas' })).not.toBeInTheDocument();
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
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['novacomeça sem contexto anterior', expect.stringMatching(/^mesma da etapa anteriorcontinua a sessão de dev · claude · dormindo há /), expect.stringMatching(/^bbbbbbbb · dev/)]);
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
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['novacomeça sem contexto anterior', expect.stringMatching(/^mesma da etapa anteriorcontinua a sessão de dev · claude/), expect.stringMatching(/^bbbbbbbb · sessão livre · /)]);
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

test('a pending start whose activity gets its setup shows the preparing view: the task\'s title, the rows, the session row, the note and the wait; no ver log icon (#390, #290)', async () => {
  const user = userEvent.setup();
  heldStart();
  const dialog = (st: State) => <ConsoleContext.Provider value={vi.fn()}><StartDialog state={st} taskId="I9" onClose={vi.fn()} /></ConsoleContext.Provider>;
  const { rerender } = render(dialog(state()));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(await screen.findByRole('button', { name: 'iniciando…' })).toBeDisabled(); // before the mark: the submit, as before
  rerender(dialog(preparing()));
  const shown = screen.getByRole('dialog', { name: 'Preparando a worktree de #SITE-9' });
  expect(shown).toHaveAccessibleDescription('Landing hero for teams · etapa backlog');
  const rows = within(shown).getByRole('list'); // the rows: the log's select names the running step too
  for (const text of ['worktree criada', 'pnpm install', 'iniciar sessão claude na etapa backlog']) expect(within(rows).getByText(text)).toBeInTheDocument();
  expect(within(shown).getByText(/^pode fechar:/)).toBeInTheDocument();
  expect(within(shown).getByRole('button', { name: 'preparando worktree…' })).toBeDisabled();
  expect(within(shown).getByRole('button', { name: 'abrir no console' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'ver log' })).not.toBeInTheDocument();
});

test('fechar closes the preparing view and leaves the request running: nothing is cancelled and a late answer attaches nothing (#390)', async () => {
  const user = userEvent.setup();
  const held = heldStart();
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const { rerender } = render(<StartDialog state={state()} taskId="I9" onStarted={onStarted} onClose={onClose} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  rerender(<StartDialog state={preparing()} taskId="I9" onStarted={onStarted} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  held.answer(reply({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false }]]);
  expect([onClose.mock.calls.length, onStarted.mock.calls.length]).toEqual([1, 0]);
});

test('an ok answer that comes before the state drops the setup waits; with no lastSetup the dialog then closes on the started run (#390)', async () => {
  const user = userEvent.setup();
  const held = heldStart();
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const dialog = (st: State) => <StartDialog state={st} taskId="I9" onStarted={onStarted} onClose={onClose} />;
  const { rerender } = render(dialog(state()));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  rerender(dialog(preparing()));
  held.answer(reply({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onClose).not.toHaveBeenCalled(); // the setup is still in the state
  rerender(dialog(state()));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onStarted).toHaveBeenCalledWith('I9');
});

test('a setup that failed stays on the view: × with its exit code and tentar de novo, which posts the same start again (#390)', async () => {
  const user = userEvent.setup();
  const held = heldStart();
  const onClose = vi.fn();
  const dialog = (st: State) => <StartDialog state={st} taskId="I9" onStarted={vi.fn()} onClose={onClose} />;
  const { rerender } = render(dialog(state()));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  rerender(dialog(preparing()));
  held.answer(reply({ ok: true }));
  rerender(dialog(state([LANDING, { ...HERO, lastSetup: { consoleId: CONSOLE, rows: SETUP_FAILED }, error: 'start failed: setup failed at line 1 (RUN pnpm install): exit 1' }])));
  const retry = await screen.findByRole('button', { name: 'tentar de novo' });
  expect(screen.getByText('falhou · exit 1')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // the view, not the form's error line
  expect(onClose).not.toHaveBeenCalled();
  await user.click(retry);
  await waitFor(() => expect(posts().filter(([url]) => url === '/tasks/I9/start')).toHaveLength(2));
  expect(posts().at(-1)).toEqual(['/tasks/I9/start', { base: null, local: false }]);
});

test('a sessão livre open refused while its worktree prepares fails the view at once, and tentar de novo opens again (#390)', async () => {
  const user = userEvent.setup();
  let refuse = (_res: Response): void => undefined;
  let opens = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/open') && init?.method === 'POST') {
      opens += 1;
      if (opens === 1) return new Promise<Response>((resolve) => { refuse = resolve; });
    }
    return reply(url.endsWith('/bases') ? BASES : { ok: true });
  }));
  const dialog = (st: State) => <StartDialog state={st} taskId="I9" initialMode="free" onClose={vi.fn()} />;
  const { rerender } = render(dialog(state()));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /sessão livre/ }));
  rerender(dialog(preparing()));
  expect(screen.getByText('abrir sessão claude')).toBeInTheDocument();
  refuse(reply({ error: 'setup failed at line 1 (RUN pnpm install): exit 1' }, 500));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('setup failed at line 1 (RUN pnpm install): exit 1'));
  // the state still holds the setup, which blocks an open as the server does: the wait stays until it leaves
  expect(screen.getByRole('button', { name: 'preparando worktree…' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'tentar de novo' })).not.toBeInTheDocument();
  rerender(dialog(state([LANDING, { ...HERO, lastSetup: { consoleId: CONSOLE, rows: SETUP_FAILED } }])));
  await user.click(await screen.findByRole('button', { name: 'tentar de novo' }));
  await waitFor(() => expect(opens).toBe(2));
});

test('a refusal with no failed row keeps its message on the view and fails the row that was running (#390)', async () => {
  const user = userEvent.setup();
  const held = heldStart();
  const dialog = (st: State) => <StartDialog state={st} taskId="I9" onStarted={vi.fn()} onClose={vi.fn()} />;
  const { rerender } = render(dialog(state()));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  rerender(dialog(preparing()));
  held.answer(reply({ error: 'spawn failed: no agent' }, 500));
  rerender(dialog(state())); // setupEnded with no failed row: no lastSetup
  expect(await screen.findByRole('alert')).toHaveTextContent('spawn failed: no agent');
  expect(within(screen.getByRole('list')).getByText('falhou')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'tentar de novo' })).toBeEnabled();
});

// A task created here (local:1) whose first start the test refuses while its worktree prepares (#390)
async function createdAndRefused() {
  const user = userEvent.setup();
  let starts = 0;
  let refuse = (): void => undefined;
  const fetching = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/tasks') return reply({ id: 'HIVE-1', itemId: 'local:1' }, 201);
    if (url.endsWith('/start') && init?.method === 'POST' && ++starts === 1) return new Promise<Response>((resolve) => { refuse = () => resolve(reply({ error: 'spawn failed: no agent' }, 500)); });
    return reply(url.endsWith('/bases') ? BASES : { ok: true });
  });
  vi.stubGlobal('fetch', fetching);
  const onClose = vi.fn();
  const created = (extra: Partial<WithWork> = {}): State => state([LANDING, HERO, task('local:1', 'HIVE-1', 'landing', { created: true, auto: false, ...extra })]);
  const dialog = (st: State) => <StartDialog state={st} onStarted={vi.fn()} onClose={onClose} />;
  const { rerender } = render(dialog(state()));
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.keyboard('landing');
  await user.click(screen.getByRole('option', { name: /criar tarefa "landing"/ }));
  await waitFor(() => expect(fetching).toHaveBeenCalledWith('/tasks', expect.anything()));
  rerender(dialog(created()));
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.keyboard('{Control>}{Enter}{/Control}');
  rerender(dialog(created({ setup: { consoleId: 'setup:local:1', step: 'RUN pnpm install', rows: PREPARING } })));
  refuse();
  await screen.findByRole('alert');
  rerender(dialog(created()));
  const sent = (): string[] => fetching.mock.calls.filter(([, i]) => i?.method === 'POST').map(([u]) => String(u));
  return { user, onClose, sent, retry: await screen.findByRole('button', { name: 'tentar de novo' }) };
}

test('fechar after a failure keeps the task created here: the plan keeps it, as a start on its way does (#390)', async () => {
  const { user, onClose, sent } = await createdAndRefused();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(sent()).not.toContain('/tasks/local%3A1/close');
});

test('tentar de novo on a task created here still hands it to the flow once it starts (#390)', async () => {
  const { user, onClose, sent, retry } = await createdAndRefused();
  await user.click(retry);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(sent().slice(-2)).toEqual(['/tasks/local%3A1/start', '/tasks/local%3A1/auto']);
});

test('a task whose worktree is already set up never shows the preparing view: the start closes the dialog as before (#390)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/Preparando a worktree/)).not.toBeInTheDocument();
});

test('a title from the search\'s + criar tarefa creates that task once on arrival and picks it (#584)', async () => {
  const onClose = vi.fn();
  const { rerender } = render(<StartDialog state={state()} title="Fix login" onStarted={vi.fn()} onClose={onClose} />);
  await waitFor(() => expect(posts()).toEqual([['/tasks', { title: 'Fix login', stage: 'backlog', auto: false, source: 'hive' }]]));
  rerender(<StartDialog state={state([LANDING, HERO, task('local:1', 'HIVE-1', 'Fix login', { created: true, auto: false })])} title="Fix login" onStarted={vi.fn()} onClose={onClose} />);
  expect(screen.getByRole('button', { name: 'tarefas' })).toHaveTextContent('HIVE-1 Fix login');
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.click(screen.getByRole('option', { name: /#SITE-7/ }));
  expect(screen.getByRole('radio', { name: 'sessão livre' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'executar etapas' })).toBeDisabled();
  expect(screen.getByText('nenhuma etapa para executar a partir de done.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: /sessão livre/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  expect(screen.getByRole('button', { name: 'tarefas' })).not.toHaveAttribute('title');
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.click(screen.getByRole('option', { name: /#SITE-9/ }));
  expect(screen.getByRole('button', { name: 'tarefas' })).toHaveAttribute('title', '#SITE-9 Landing hero for teams');
});

const TO_BOARD: CreateTargets = { hiveSource: true, createIn: 'board', sources: [{ name: 'board', type: 'github' }] };
const toBoard = (ui: ReactElement) => <CreateTargetsContext.Provider value={TO_BOARD}>{ui}</CreateTargetsContext.Provider>;

test('on a source the typed task is held: one create row, on the default destination\'s chip, and neither the pick nor a cancel creates anything (#846, #893)', async () => {
  const user = userEvent.setup();
  render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={vi.fn()} />));
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.keyboard('landing');
  const rows = screen.getAllByRole('option', { name: /criar tarefa "landing"/ });
  expect(rows).toHaveLength(1);
  expect(within(rows[0]).getByRole('button', { name: 'criar em board' })).toBeInTheDocument();
  await user.click(rows[0]);
  expect(screen.getByText(t('start.held', { title: 'landing', source: 'board' }))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  expect(posts()).toEqual([]);
});

test('picking hive in the chip\'s criar em menu and pressing the row creates the task in the hive at once (#893)', async () => {
  const user = userEvent.setup();
  render(toBoard(<StartDialog state={state()} workspace="site" onStarted={vi.fn()} onClose={vi.fn()} />));
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.keyboard('landing');
  await user.click(screen.getByRole('button', { name: 'criar em board' }));
  await user.click(screen.getByRole('option', { name: /^hive/ }));
  await user.click(screen.getByRole('option', { name: /criar tarefa "landing".*em hive/ }));
  await waitFor(() => expect(posts()[0]).toEqual(['/tasks', { title: 'landing', stage: 'backlog', auto: false, workspace: 'site', source: 'hive' }]));
});

test('starting a held task creates it on its source, then starts it once the state holds it (#846)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { rerender } = render(toBoard(<StartDialog state={state()} onStarted={vi.fn()} onClose={onClose} />));
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
  await user.keyboard('landing');
  await user.click(screen.getAllByRole('option', { name: /criar tarefa "landing"/ })[0]);
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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
  await user.click(screen.getByRole('button', { name: 'tarefas' }));
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

test('an orphan branch with no history in common with the base, or behind it with nothing of its own, says so and preselects Discard: the start sends the base and discardOrphan (#267)', async () => {
  const user = userEvent.setup();
  for (const relation of ['unrelated', 'stale'] as const) {
    bases = { ...BASES, orphan: { worktree: false, branch: true, relation, branchName: 'hive/9-landing' } };
    fetchMock.mockClear();
    const onClose = vi.fn();
    const { unmount } = render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
    expect(await screen.findByText(t(`start.orphan.${relation}`))).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: t('start.orphan.discard') })).toHaveAttribute('aria-checked', 'true');
    await screen.findByRole('combobox', { name: 'origin/main' });
    await user.click(screen.getByRole('button', { name: /executar etapas/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false, discardOrphan: true }]]);
    unmount();
  }
});

test('sessão livre on an unrelated orphan branch says the open keeps it aside and posts no base; an own branch keeps Reuse preselected with no class notice (#267)', async () => {
  const user = userEvent.setup();
  bases = { ...BASES, orphan: { worktree: false, branch: true, relation: 'unrelated', branchName: 'hive/9-landing' } };
  const { unmount } = render(<StartDialog state={state()} taskId="I9" initialMode="free" onClose={vi.fn()} />);
  expect(await screen.findByText(t('start.orphan.setAside', { name: 'hive/9-landing-old-…' }))).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: t('start.orphan.discard') })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'origin/main' })).not.toBeInTheDocument();
  const open = screen.getByRole('button', { name: /sessão livre/ });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await waitFor(() => expect(posts()).toEqual([['/tasks/I9/open', { kind: 'claude' }]]));
  unmount();
  bases = { ...BASES, orphan: { worktree: false, branch: true, relation: 'own', branchName: 'hive/9-landing' } };
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByRole('radio', { name: t('start.orphan.reuse') })).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByText(t('start.orphan.unrelated'))).not.toBeInTheDocument();
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
  await user.click(screen.getByRole('option', { name: /^nova/ }));
  expect(dialog.getByRole('combobox', { name: 'modelo' })).toBeEnabled();
  expect(dialog.getByRole('combobox', { name: 'modelo' })).toHaveTextContent('padrão do claude');
  await user.type(dialog.getByRole('textbox', { name: 'argumentos' }), '--verbose');
  const open = screen.getByRole('button', { name: /sessão livre/ });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I4/open', { kind: 'claude', args: ['--verbose'] }]]);
});

test('executar etapas shows the run the stage would launch; personalizar opens its block, a change shows alterado and restaurar padrão, and the start posts only what changed (#290)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={onClose} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  const summary = screen.getByText('claude · padrão do claude · sessão nova');
  expect(summary.parentElement?.querySelector('svg')).toHaveClass('text-agent-claude'); // the mark in its agent's colour, as the agent field shows it
  await user.click(screen.getByRole('button', { name: /personalizar/ }));
  const block = within(screen.getByRole('region', { name: 'execução de backlog' }));
  expect(block.getByText('padrão da etapa')).toBeInTheDocument();
  expect(block.getByText('vale só para esta execução. as próximas etapas usam o que está configurado no fluxo.')).toBeInTheDocument();
  expect(block.queryByText('alterado')).not.toBeInTheDocument();
  await user.type(block.getByRole('textbox', { name: 'argumentos' }), '--verbose');
  expect(block.getByText('alterado')).toBeInTheDocument();
  await user.click(block.getByRole('button', { name: 'restaurar padrão' }));
  expect(block.queryByText('alterado')).not.toBeInTheDocument();
  expect(block.getByRole('textbox', { name: 'argumentos' })).toHaveValue('');
  await user.type(block.getByRole('textbox', { name: 'argumentos' }), '--verbose');
  await user.click(screen.getByRole('button', { name: /executar etapas/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/tasks/I9/start', { base: null, local: false, args: ['--verbose'] }]]);
});

test('a stage with a model shows it as the stage\'s default; another agent drops a session it cannot resume back to nova and runs its own default model (#290, #925)', async () => {
  const user = userEvent.setup();
  const ran = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: AT, stages: ['backlog'], agent: 'claude' as const, lastUsedAt: AT }];
  const inDev = task('I9', 'SITE-9', 'Landing hero for teams', { stage: 'dev' });
  const continuing = withPointedWork({ ...state([inDev]), activityRecords: [{ id: 'a-I9', taskIds: ['I9'], sessions: ran }], stages: stages.map((s) => (s.name === 'dev' ? { ...s, session: 'continue' as const, model: 'opus' } : s)) });
  render(<StartDialog state={continuing} taskId="I9" onClose={vi.fn()} />);
  expect(screen.getByText('claude · opus · sessão mesma da etapa anterior')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /personalizar/ }));
  const block = within(screen.getByRole('region', { name: 'execução de dev' }));
  expect(block.getByRole('combobox', { name: 'modelo' })).toHaveTextContent('padrão da etapa · opus');
  expect(block.getByRole('combobox', { name: 'sessão' })).toHaveTextContent('mesma da etapa anterior');
  await user.click(block.getByRole('combobox', { name: 'agente' }));
  await user.click(screen.getByRole('option', { name: 'codex' }));
  expect(block.getByRole('combobox', { name: 'sessão' })).toHaveTextContent('nova');
  expect(block.getByRole('combobox', { name: 'modelo' })).toHaveTextContent('padrão do codex');
  await user.click(block.getByRole('button', { name: 'personalizar ‹' }));
  expect(screen.getByText('codex · padrão do codex · sessão nova')).toBeInTheDocument(); // closing keeps the picks
});

test('a continue shows the run without personalizar, since its session is fixed; so does a task whose handover decides its next run (#290, #134)', () => {
  const ran = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: AT, stages: ['dev'], agent: 'claude' as const, lastUsedAt: AT }];
  const { unmount } = render(<StartDialog state={withPointedWork({ ...state([LANDING]), activityRecords: [{ id: 'a-I4', taskIds: ['I4'], sessions: ran }] })} taskId="I4" onClose={vi.fn()} />);
  expect(screen.getByText('claude · padrão do claude · sessão nova')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /personalizar/ })).not.toBeInTheDocument();
  unmount();
  render(<StartDialog state={withWork(state(), 'I9', { handover: { prompt: 'from the transition' } })} taskId="I9" onClose={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /personalizar/ })).not.toBeInTheDocument();
});

test('sessão livre reads the launch options of the task\'s workspace (#316)', async () => {
  render(<StartDialog state={state()} taskId="I4" initialMode="free" onClose={vi.fn()} />);
  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/launch-options?workspace=site'));
});
