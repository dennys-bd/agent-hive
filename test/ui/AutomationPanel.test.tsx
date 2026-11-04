import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AutomationPanel } from '@/components/AutomationPanel';
import type { SourcesNav } from '@/components/FlowSources';
import { FIRST_CENTER, type TasksCenter } from '@/hooks/use-tasks-center';
import { DISPLAY_DEFAULTS } from '@/lib/flow-view';
import { setLanguage } from '@/i18n';
import type { SourceConfig, Task, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

const task = (id: string, board?: string): Task => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', source: board }, stage: 'dev', boardColumn: 'Ready', auto: true,
});
const state = (workers: Worker[], tasks: Task[] = []): State => withPointedWork({
  signal: 'yellow', signals: SIGNALS_DEFAULTS, maxConcurrent: 5, workers, ...flowed([{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }], []), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const taskProps = { defaults: { workspace: 'hive', auto: true }, rules: [] };
const roadmap: SourceConfig = { name: 'roadmap', type: 'github', owner: 'acme', number: 7, filter: [], taskProps, qualifyId: false, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
const notes: SourceConfig = { name: 'notes', type: 'github', owner: 'acme', number: 8, filter: [], taskProps, qualifyId: false, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
const TASKS = [task('1', 'roadmap'), task('2', 'roadmap'), task('3', 'notes'), task('4')];
const STATE = state([{ id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' }], TASKS);
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string) => json(String(url).startsWith('/settings/projects') ? [{ number: 7, title: 'Roadmap', url: 'https://github.com/orgs/acme/projects/7' }] : String(url) === '/repositories' ? [] : { ok: true }));
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Tarefas' });
const follows = (a: Node, b: Node): boolean => a.compareDocumentPosition(b) === Node.DOCUMENT_POSITION_FOLLOWING;

function renderPanel(nav: Partial<SourcesNav> = {}, center: TasksCenter = FIRST_CENTER) {
  const show = vi.fn();
  const display = { options: DISPLAY_DEFAULTS, set: vi.fn() };
  render(<AutomationPanel state={STATE} sources={{ sources: [roadmap, notes], auth: 'cli', ...nav }} nav={{ center, show }} display={display} />);
  return { show, display };
}

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the Tarefas panel is the tasks sidebar: automação holds the signal, with what its row holds back, and the workers, then tarefas, sources and repositórios (#572, redesign 09, #727)', () => {
  renderPanel();
  const signal = within(panel()).getByRole('radiogroup', { name: 'sinal' });
  const cap = within(panel()).getByLabelText('máx.');
  const tasksTitle = within(panel()).getByRole('button', { name: 'seção tarefas' });
  expect(within(panel()).getByText('tarefas novas só de árvore iniciada')).toBeInTheDocument();
  expect(within(panel()).getByText('workers 1/5')).toBeInTheDocument();
  expect([follows(within(panel()).getByRole('button', { name: 'seção automação' }), signal), follows(signal, cap), follows(cap, tasksTitle)]).toEqual([true, true, true]);
  const rows = within(panel()).getAllByRole('button', { name: /^(roadmap|notes)/ });
  expect(rows.map((row) => row.textContent)).toEqual(['roadmap2acme · github project', 'notes1acme · github project']);
});

test('a source row opens its table; the shown source\'s row is the pressed one (#572, redesign 09)', async () => {
  const user = userEvent.setup();
  const { show } = renderPanel({}, { kind: 'source', source: 'notes' });
  expect(within(panel()).getByRole('button', { name: /^notes/ })).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(panel()).getByText('roadmap'));
  expect(show.mock.calls).toEqual([[{ kind: 'source', source: 'roadmap' }]]);
});
test('the ⋯ menu: configurar opens its settings, mostrar só esta picks it, atualizar polls, abrir no github opens the project; the row itself is not picked (redesign 09)', async () => {
  const user = userEvent.setup();
  const onConfigure = vi.fn();
  const open = vi.fn();
  vi.stubGlobal('open', open);
  const { show, display } = renderPanel({ onConfigure });
  const menu = async (name: string, item: string): Promise<void> => {
    within(panel()).getByRole('button', { name: `ações de ${name}` }).focus(); // Radix's menu opens on a key under jsdom, not on a click
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('menuitem', { name: item }));
  };
  await menu('roadmap', 'configurar source');
  expect(onConfigure).toHaveBeenCalledWith('roadmap');
  expect(show).not.toHaveBeenCalled();
  await menu('roadmap', 'mostrar só esta');
  expect(display.set).toHaveBeenCalledWith({ sourcesOff: ['hive', 'notes'] });
  expect(show).not.toHaveBeenCalled();
  await menu('roadmap', 'atualizar agora');
  expect(fetchMock).toHaveBeenCalledWith('/sources/refresh', expect.objectContaining({ method: 'POST' }));
  await menu('roadmap', 'abrir no github');
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://github.com/orgs/acme/projects/7', '_blank', 'noreferrer'));
  expect(fetchMock).toHaveBeenCalledWith('/settings/projects?owner=acme&auth=cli');
});

const hiveRow = (): HTMLElement => within(panel()).getByRole('button', { name: /^hive/ });

test('the hive row comes first in sources, before the configured ones: its count on one line, no ⋯; shown, it is the pressed row (#665, #572)', () => {
  renderPanel({}, { kind: 'source', source: 'hive' });
  expect(follows(hiveRow(), within(panel()).getByText('roadmap'))).toBe(true);
  expect(hiveRow()).toHaveTextContent(/^hive1$/); // task 4 is the only one with no source
  expect(hiveRow()).toHaveAttribute('aria-pressed', 'true');
  expect(within(panel()).queryByRole('button', { name: 'ações de hive' })).not.toBeInTheDocument();
});

test('the hive row shows with no source configured and no task, and its click opens the hive source (#665, #572)', async () => {
  const user = userEvent.setup();
  const show = vi.fn();
  render(<AutomationPanel state={state([], [])} sources={{ sources: [], auth: 'cli' }} nav={{ center: FIRST_CENTER, show }} display={{ options: DISPLAY_DEFAULTS, set: vi.fn() }} />);
  expect(hiveRow()).toHaveTextContent(/^hive0$/);
  await user.click(hiveRow());
  expect(show.mock.calls).toEqual([[{ kind: 'source', source: 'hive' }]]);
});
