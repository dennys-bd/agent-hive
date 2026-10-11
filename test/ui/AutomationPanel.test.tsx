import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AutomationPanel } from '@/components/AutomationPanel';
import type { SourcesNav } from '@/components/FlowSources';
import { setLanguage } from '@/i18n';
import type { SourceConfig, Task, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork } from '../fixtures/work';

const task = (id: string, board?: string): Task => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', source: board }, stage: 'dev', boardColumn: 'Ready', auto: true,
});
const state = (workers: Worker[], tasks: Task[] = []): State => withPointedWork({
  signal: 'yellow', signals: SIGNALS_DEFAULTS, maxConcurrent: 5, workers, stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }], tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const taskProps = { defaults: { workspace: 'hive', auto: true }, rules: [] };
const roadmap: SourceConfig = { name: 'roadmap', type: 'github', owner: 'acme', number: 7, filter: [], taskProps, qualifyId: false, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
const notes: SourceConfig = { name: 'notes', type: 'github', owner: 'acme', number: 8, filter: [], taskProps, qualifyId: false, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
const TASKS = [task('1', 'roadmap'), task('2', 'roadmap'), task('3', 'notes'), task('4')];
const STATE = state([{ id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' }], TASKS);
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string) => json(String(url).startsWith('/settings/projects') ? [{ number: 7, title: 'Roadmap', url: 'https://github.com/orgs/acme/projects/7' }] : { ok: true }));
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Automação' });
const follows = (a: Node, b: Node): boolean => a.compareDocumentPosition(b) === Node.DOCUMENT_POSITION_FOLLOWING;

function renderPanel(nav: Partial<SourcesNav> = {}, source?: string) {
  const onSource = vi.fn();
  render(<AutomationPanel state={STATE} sources={{ sources: [roadmap, notes], auth: 'cli', ...nav }} source={source} onSource={onSource} />);
  return onSource;
}

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the flow sidebar reads top to bottom: the signal with what its row holds back, the workers, a separator, then the sources, todas first with every task (redesign 09, #727)', () => {
  renderPanel();
  const signal = within(panel()).getByRole('radiogroup', { name: 'sinal' });
  const cap = within(panel()).getByLabelText('máx.');
  const separator = within(panel()).getByRole('separator');
  const all = within(panel()).getByRole('button', { name: /^todas/ });
  expect(within(panel()).getByText('sem tarefas novas')).toBeInTheDocument();
  expect(within(panel()).getByText('workers 1/5')).toBeInTheDocument();
  expect(within(panel()).queryByRole('switch', { name: 'auto' })).not.toBeInTheDocument();
  expect([follows(signal, cap), follows(cap, separator), follows(separator, all)]).toEqual([true, true, true]);
  expect(all).toHaveTextContent('todasAlt+04'); // the pick key before the count (#500)
  expect(all).toHaveAttribute('aria-pressed', 'true');
  const rows = within(panel()).getAllByRole('button', { name: /^(roadmap|notes)/ });
  expect(rows.map((row) => row.textContent)).toEqual(['roadmapAlt+22github project', 'notesAlt+31github project']); // hive holds Alt+1 (#665)
});

test('a source row picks that source, todas picks none; the picked row is the pressed one (redesign 09)', async () => {
  const user = userEvent.setup();
  const onSource = renderPanel({}, 'notes');
  expect(within(panel()).getByRole('button', { name: /^notes/ })).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(panel()).getByText('roadmap'));
  await user.click(within(panel()).getByRole('button', { name: /^todas/ }));
  expect(onSource.mock.calls).toEqual([['roadmap'], [undefined]]);
});

test('filtrar opens a field that narrows the sources by name (redesign 09)', async () => {
  const user = userEvent.setup();
  renderPanel();
  await user.click(within(panel()).getByRole('button', { name: 'filtrar' }));
  await user.type(within(panel()).getByLabelText('filtrar sources'), 'ROAD');
  expect(within(panel()).queryByText('notes')).not.toBeInTheDocument();
  expect(within(panel()).getByText('roadmap')).toBeInTheDocument();
});

test('the ⋯ menu: configurar opens its settings, mostrar só esta picks it, atualizar polls, abrir no github opens the project; the row itself is not picked (redesign 09)', async () => {
  const user = userEvent.setup();
  const onConfigure = vi.fn();
  const open = vi.fn();
  vi.stubGlobal('open', open);
  const onSource = renderPanel({ onConfigure });
  const menu = async (name: string, item: string): Promise<void> => {
    within(panel()).getByRole('button', { name: `ações de ${name}` }).focus(); // Radix's menu opens on a key under jsdom, not on a click
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('menuitem', { name: item }));
  };
  await menu('roadmap', 'configurar source');
  expect(onConfigure).toHaveBeenCalledWith('roadmap');
  expect(onSource).not.toHaveBeenCalled();
  await menu('roadmap', 'mostrar só esta');
  expect(onSource).toHaveBeenCalledWith('roadmap');
  await menu('roadmap', 'atualizar agora');
  expect(fetchMock).toHaveBeenCalledWith('/sources/refresh', expect.objectContaining({ method: 'POST' }));
  await menu('roadmap', 'abrir no github');
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://github.com/orgs/acme/projects/7', '_blank', 'noreferrer'));
  expect(fetchMock).toHaveBeenCalledWith('/settings/projects?owner=acme&auth=cli');
});

const hiveRow = (): HTMLElement => within(panel()).getByRole('button', { name: /^hive/ });

test('the hive row sits right after todas and before the sources: the tasks with no source, its key, tarefas do hive, no ⋯; picked, it is the pressed row (#665)', () => {
  renderPanel({}, 'hive');
  const all = within(panel()).getByRole('button', { name: /^todas/ });
  expect([follows(all, hiveRow()), follows(hiveRow(), within(panel()).getByText('roadmap'))]).toEqual([true, true]);
  expect(hiveRow()).toHaveTextContent('hiveAlt+11tarefas do hive'); // task 4 is the only one with no source
  expect(hiveRow()).toHaveAttribute('aria-pressed', 'true');
  expect(all).toHaveAttribute('aria-pressed', 'false');
  expect(within(panel()).queryByRole('button', { name: 'ações de hive' })).not.toBeInTheDocument();
});

test('the hive row shows with no source configured and no task, and its click picks hive (#665)', async () => {
  const user = userEvent.setup();
  const onSource = vi.fn();
  render(<AutomationPanel state={state([], [])} sources={{ sources: [], auth: 'cli' }} onSource={onSource} />);
  expect(hiveRow()).toHaveTextContent('hiveAlt+10tarefas do hive');
  await user.click(hiveRow());
  expect(onSource.mock.calls).toEqual([['hive']]);
});
