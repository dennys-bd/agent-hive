import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StartDialog } from '@/components/StartDialog';
import { setLanguage, t } from '@/i18n';
import type { BaseOptions, Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';

// #893's design pass: the dialog's look and copy, apart from StartDialog.test.tsx's flows
const stages: Stage[] = [
  { name: 'backlog', from: { board: ['Todo'] }, prompt: 'x' }, { name: 'dev', from: { board: ['Doing'] }, prompt: 'x' },
  { name: 'done', from: { board: ['Done'] } }, // no prompt, the last stage: a task there has nothing to run (#774)
];
const task = (itemId: string, id: string, title: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId, id, title, body: '', url: '' }, stage: 'backlog', boardColumn: 'Todo', auto: true, workspace: 'site', ...extra,
});
const HERO = task('I9', 'SITE-9', 'Landing hero for teams');
const SHIPPED = task('I7', 'SITE-7', 'Shipped pricing page', { stage: 'done' });
const state = (tasks: Task[] = [HERO, SHIPPED]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive', 'site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const BASES: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL) => reply(String(input).endsWith('/bases') ? BASES : { ok: true }));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('Nova atividade names the field tarefas, with the hint under it, and the closed field reads buscar ou criar tarefa… (#893)', () => {
  render(<StartDialog state={state()} onClose={vi.fn()} />);
  expect(screen.getByText('tarefas')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'tarefas' })).toHaveTextContent('buscar ou criar tarefa…');
  expect(screen.getByText('toda atividade parte de pelo menos uma tarefa. se ela não existir, crie aqui.')).toHaveClass('text-muted-foreground', 'text-xs');
});

test('the mode toggle is a segmented control: a muted track, the active segment on the background, no outline per item; it switches modes, and executar etapas stays disabled for a task with nothing to run (#893, #774)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<StartDialog state={state()} taskId="I9" onClose={vi.fn()} />);
  const stagesItem = screen.getByRole('radio', { name: 'executar etapas' });
  expect(stagesItem.parentElement).toHaveClass('bg-muted', 'p-0.5', 'gap-0.5');
  expect(stagesItem).not.toHaveAttribute('data-variant', 'outline');
  expect(stagesItem).toHaveClass('data-[state=on]:bg-background', 'text-[13px]', 'font-medium');
  expect(stagesItem).toHaveAttribute('data-state', 'on');
  await user.click(screen.getByRole('radio', { name: 'sessão livre' }));
  expect(screen.getByRole('radio', { name: 'sessão livre' })).toHaveAttribute('data-state', 'on');
  expect(screen.getByText(t('start.hint.free'))).toBeInTheDocument();
  unmount();
  render(<StartDialog state={state()} taskId="I7" onClose={vi.fn()} />);
  expect(screen.getByRole('radio', { name: 'executar etapas' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'sessão livre' })).toHaveAttribute('data-state', 'on');
});

test('personalizar open drops the execução row from the stages box, keeps próximas and para em, and sits above the box with no border; personalizar ‹ closes it and brings the row back (#893)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={state()} taskId="I9" onStarted={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole('combobox', { name: 'origin/main' });
  expect(screen.getByText(t('run.label'))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'personalizar ›' }));
  expect(screen.getByRole('button', { name: 'personalizar ‹' })).toHaveFocus(); // the button that held it unmounted
  const block = screen.getByRole('region', { name: 'execução de backlog' });
  expect(block).not.toHaveClass('border');
  expect(screen.queryByText(t('run.label'))).not.toBeInTheDocument();
  const next = screen.getByText(t('start.next'));
  expect(screen.getByText(t('start.stopsAt'))).toBeInTheDocument();
  expect(block.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0); // the block above the box
  await user.click(within(block).getByRole('button', { name: 'personalizar ‹' }));
  expect(screen.queryByRole('region', { name: 'execução de backlog' })).not.toBeInTheDocument();
  expect(screen.getByText(t('run.label'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'personalizar ›' })).toHaveFocus();
});

test('the session menu\'s nova and the specialized menu\'s nenhum show their second lines; the specialized menu\'s footer names the agent (#893)', async () => {
  const user = userEvent.setup();
  render(<StartDialog state={state()} taskId="I9" initialMode="free" onClose={vi.fn()} />);
  const dialog = within(screen.getByRole('dialog'));
  await user.click(dialog.getByRole('combobox', { name: 'sessão' }));
  await user.click(await screen.findByRole('option', { name: /^nova.*começa sem contexto anterior$/ }));
  await user.click(dialog.getByRole('combobox', { name: 'agente especializado' }));
  expect(screen.getByRole('option', { name: /^nenhum.*o agente sem especialização$/ })).toBeInTheDocument();
  expect(screen.getByText('mostra os agentes instalados para claude')).toHaveClass('text-muted-foreground', 'text-xs');
});
