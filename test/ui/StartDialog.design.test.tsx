import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StartDialog } from '@/components/StartDialog';
import { setLanguage } from '@/i18n';
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
