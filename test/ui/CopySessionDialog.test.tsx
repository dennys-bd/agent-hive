import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CopySessionDialog } from '@/components/CopySessionDialog';
import { RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { CopySummary, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const task = (itemId: string, id: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId, id, title: `task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, workspace: 'hive', created: true, worktree: `/w/${id}`, ...extra,
});
const ONE = task('local:1', 'HIVE-1');
// #629: ONE's session is its record's
const ONE_RECORD = { id: 'a-local:1', taskIds: ['local:1'], sessions: [{ id: S, startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '', name: 'revisão', tokens: 22400 }] };
const TWO = task('local:2', 'HIVE-2');
const state: State = movedWork({ // #629: each task's live activity, a-<itemId>, a copy's target
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [], tasks: [ONE, TWO], sourceOrder: [], localCount: 0, activities: [], activityRecords: [ONE_RECORD], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
let summary: CopySummary = { from: { path: '/w/HIVE-1', branch: 'hive/HIVE-1' }, to: { path: '/repo', branch: 'main' }, messages: 142, tokens: 22400, uncommitted: 5 };
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, ptyId: 'W9' } };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST' ? reply(answer.body, answer.status) : reply(summary)));
const posts = (): [string, unknown][] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);
const FROM = { activityId: 'a-local:1', sessionId: S }; // #629: the session's record

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the dialog names the destination and the source, prefills the name selected, reads the summary for its target, warns about the uncommitted changes and copies with the notice on, ⌘↵ (#587, 6a)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<CopySessionDialog state={state} from={FROM} to={{ activityId: 'local:hive' }} onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'Copiar sessão para local' })).toBeInTheDocument();
  expect(screen.getByText('de claude a1b2c3d4 · HIVE-1')).toBeInTheDocument();
  const name = screen.getByRole('textbox', { name: 'nome da sessão' }) as HTMLInputElement;
  expect(name).toHaveValue('revisão em local');
  expect(name).toHaveFocus();
  expect([name.selectionStart, name.selectionEnd]).toEqual([0, 'revisão em local'.length]);
  expect(screen.getByText('a sessão nova tem o mesmo histórico. a original continua em HIVE-1.')).toBeInTheDocument();
  expect(await screen.findByText('142 mensagens · 22.4k tokens')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`/activities/a-local%3A1/sessions/${S}/copy?toActivity=local%3Ahive`);
  expect(screen.getByText('/w/HIVE-1 · hive/HIVE-1')).toBeInTheDocument();
  expect(screen.getByText('/repo · main')).toBeInTheDocument();
  expect(screen.getByText('o código não vai junto. a sessão nova vê o que existe em main, e as 5 alterações não commitadas de HIVE-1 ficam lá.')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'avisar o agente da troca de diretório' })).toBeChecked();
  await user.clear(name);
  await user.type(name, 'no main');
  await user.keyboard('{Control>}{Enter}{/Control}'); // confirm, Ctrl+Enter off macOS (#585)
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([[`/activities/a-local%3A1/sessions/${S}/copy`, { to: { activityId: 'local:hive' }, name: 'no main', notice: true }]]);
});

test('with nothing uncommitted the warning ends at the branch; the switch off sends notice false; a copy into the activity the center shows opens as its tab (#587)', async () => {
  summary = { ...summary, uncommitted: 0, to: { path: '/w/HIVE-2', branch: null } };
  const user = userEvent.setup();
  const openRun = vi.fn();
  render(
    <RunOpenerContext.Provider value={openRun}>
      <CopySessionDialog state={state} from={FROM} to={{ activityId: 'a-local:2' }} shown="local:2" onClose={vi.fn()} />
    </RunOpenerContext.Provider>,
  );
  expect(screen.getByRole('dialog', { name: 'Copiar sessão para HIVE-2 task HIVE-2' })).toBeInTheDocument();
  expect(await screen.findByText('o código não vai junto. a sessão nova vê o que existe em sem branch.')).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'avisar o agente da troca de diretório' }));
  await user.click(screen.getByRole('button', { name: /copiar sessão/ }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'W9', kind: 'session', task: 'local:2', title: 'HIVE-2 task HIVE-2' }));
  expect(posts()[0][1]).toEqual({ to: { activityId: 'a-local:2' }, name: 'revisão em HIVE-2', notice: false });
});

test('a refused copy shows the server\'s words and keeps the dialog open (#587)', async () => {
  answer = { status: 409, body: { error: 'O histórico desta sessão não existe mais' } };
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<CopySessionDialog state={state} from={FROM} to={{ activityId: 'local:hive' }} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: /copiar sessão/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('O histórico desta sessão não existe mais');
  expect(onClose).not.toHaveBeenCalled();
});
