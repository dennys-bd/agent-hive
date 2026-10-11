import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/App';
import { setLanguage, t } from '@/i18n';
import type { Stage, SettingsInfo, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// App owns the selection; mocking its network hooks lets the test drive `state` directly without a real
// EventSource/fetch, and isolates the regression (App must clear a stale selection) from the network plumbing.
let currentState: State | undefined;

// A mutable box read by the mocked hook below (#294): tests that need `info.configured` false, or a save that
// resolves onSaved's `reload()`, swap it in before rendering. vi.hoisted keeps it reachable from the hoisted vi.mock.
const setupInfoBox = vi.hoisted(() => ({
  info: { configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }] } as SettingsInfo,
}));

vi.mock('@/hooks/use-hive-state', () => ({
  useHiveState: () => ({ state: currentState, connected: true, tick: 0 }),
}));
vi.mock('@/hooks/use-settings-info', () => ({
  useSettingsInfo: () => ({
    info: setupInfoBox.info,
    error: undefined,
    reload: vi.fn(async () => setupInfoBox.info),
  }),
}));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] })); // #258: this file's fetch mocks are not shaped like TaskFile[]

const defaultSetupInfo: SettingsInfo = { configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }] };
// A config complete enough for validateSettings to pass with no edits (#294): no source, one stage, one workspace.
const savableSetupInfo: SettingsInfo = {
  ...defaultSetupInfo,
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000 }], sources: [], transitions: [], stages: [{ name: 'fila', from: {} }], commands: [] },
    logLevel: 'info', claudeArgs: [], budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS,
  },
};

beforeEach(() => { setLanguage('pt'); currentState = undefined; setupInfoBox.info = defaultSetupInfo; });
afterEach(() => vi.unstubAllGlobals());

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (id: string, workerId?: string): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}` },
  stage: 'dev', boardColumn: 'Ready', auto: true, workerId,
});
const worker = (taskId?: string): Worker => ({ id: 's1', status: taskId ? 'working' : 'empty', ...(taskId ? { activityId: activityIdOf(taskId) } : {}) });
const state = (tasks: WithWork[], s: Worker): State => withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [s], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });

// window.hive as the preload exposes it (#192): the returned function delivers what main's window:select carries, inside act
function stubBridge(): (selection: unknown) => void {
  let listener: (selection: unknown) => void = () => {};
  vi.stubGlobal('hive', { chooseFolder: vi.fn(), focusDetached: vi.fn(async () => false), onDock: vi.fn(), onCloseKey: vi.fn(), settingsChanged: vi.fn(async () => {}), onSelect: (callback: (selection: unknown) => void) => { listener = callback; } });
  return (selection) => { act(() => listener(selection)); };
}

// A task with no worker shows its content bare (#209): no tab bar of its own inside the task, and no tabpanel left without a tab. Scoped to
// the aside itself (#342): the dock group around it always shows its own tablist, one tab per docked panel, even alone.
const expectTaskAlone = (): void => {
  const aside = screen.getByRole('complementary');
  expect(within(aside).queryByRole('tablist')).not.toBeInTheDocument();
  expect(within(aside).queryByRole('tabpanel')).not.toBeInTheDocument();
  expect(aside).toHaveTextContent('etapa dev');
};

test('a board task opens its panel, which stays open while the task is in the Hive; the task leaves → it closes, and a new task in the same worker does not reopen it (#283)', async () => {
  const user = userEvent.setup();
  currentState = state([task('1', 's1')], worker('I1'));
  const { rerender } = render(<App />);
  await user.click(screen.getByRole('radio', { name: /fluxo/ })); // the window opens on Atividades (#746)
  await user.click(within(screen.getByRole('main')).getByText('#1 Task 1'));
  expectTaskAlone();
  currentState = state([task('1')], worker()); // the run ended; the task stays in its stage
  rerender(<App />);
  expectTaskAlone();
  currentState = state([], worker());
  rerender(<App />);
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  currentState = state([task('2', 's1')], worker('I2'));
  rerender(<App />);
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

test('the dashboard wrapper fills the viewport height and main takes the remaining space', () => {
  currentState = state([], worker());
  render(<App />);
  fireEvent.click(screen.getByRole('radio', { name: /fluxo/ }));
  const main = screen.getByRole('main');
  expect(main.className).toEqual(expect.stringContaining('min-h-0'));
  expect(main.className).toEqual(expect.stringContaining('flex-1'));
  expect(main.closest('.h-screen')).not.toBeNull(); // main sits inside the terminal split (#251), itself inside the h-screen wrapper
});

test('the max workers control lives in the Automação tab, in neither the header nor the footer, which holds the signal strip (#146, #456)', () => {
  currentState = state([], worker());
  render(<App />);
  const header = document.querySelector('header')!;
  const footer = screen.getByRole('contentinfo');
  expect(within(screen.getByRole('region', { name: 'Automação' })).getByLabelText('máx.')).toBeInTheDocument();
  expect(within(header).queryByLabelText('máx.')).not.toBeInTheDocument();
  expect(within(footer).queryByLabelText('máx.')).not.toBeInTheDocument();
  expect(within(footer).getByRole('status')).toBeInTheDocument();
});

test('a click on a stopped task opens the panel on the details panel with no Worker tab; its iniciar button only starts it', async () => {
  const user = userEvent.setup();
  // one body for both calls: the bases GET (#131) says the worktree exists, so the Start dialog asks no base; the start POST reads ok
  const body = JSON.stringify({ ok: true, hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
  currentState = state([task('1')], worker());
  render(<App />);
  await user.click(screen.getByRole('radio', { name: /fluxo/ })); // the window opens on Atividades (#746)
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  const run = screen.getByRole('button', { name: /executar etapas/ });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  await user.click(screen.getByText('#1 Task 1'));
  expect(screen.getByRole('complementary')).toBeInTheDocument();
  expectTaskAlone();
});

test('a worker line of the menu bar (#192): a request that arrives before the state waits for it, then opens that task\'s panel (#283)', () => {
  const select = stubBridge();
  const { rerender } = render(<App />);
  select({ taskId: 'I1' });
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();

  currentState = state([task('1', 's1')], worker('I1'));
  rerender(<App />);
  expect(screen.getByRole('complementary')).toBeInTheDocument();
  expectTaskAlone();
});

test('a menu request for a task the loaded state does not hold is dropped, and does not open when the task shows up later; a malformed one is ignored (#192)', () => {
  const select = stubBridge();
  currentState = state([], worker());
  const { rerender } = render(<App />);
  select({ taskId: 'I1' });
  select({ taskId: 7 }); // not a task line: the id is not a string
  currentState = state([task('1', 's1')], worker('I1'));
  rerender(<App />);
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

test('a menu request received on the settings form leaves it for the dashboard and opens that task\'s panel (#192, #283)', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
  const select = stubBridge();
  currentState = state([task('1', 's1')], worker('I1'));
  render(<App />);
  select({ view: 'settings' });
  expect(screen.getByText('configuração')).toBeInTheDocument();

  select({ taskId: 'I1' });
  expect(screen.queryByText('configuração')).not.toBeInTheDocument();
  expectTaskAlone();
});

test('the menu bar\'s Settings… switches the dashboard to the settings form (#195)', () => {
  const select = stubBridge();
  currentState = state([], worker());
  render(<App />);
  expect(screen.queryByText('configuração')).not.toBeInTheDocument();

  select({ view: 'settings' });
  expect(screen.getByText('configuração')).toBeInTheDocument();
});

test('a Settings… request while the form is already open leaves its edits alone (#195)', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
  const select = stubBridge();
  currentState = state([], worker());
  render(<App />);
  select({ view: 'settings' });
  await user.click(screen.getByRole('button', { name: t('settings.section.app') }));
  await user.type(screen.getByLabelText(t('settings.terminalFont')), 'x'); // the edit that must survive the Settings… request

  select({ view: 'settings' });
  expect(screen.getByText('configuração')).toBeInTheDocument();
  expect((screen.getByLabelText(t('settings.terminalFont')) as HTMLInputElement).value.endsWith('x')).toBe(true);
});

test('a malformed Settings… payload is ignored (#195)', () => {
  const select = stubBridge();
  currentState = state([], worker());
  render(<App />);
  select({ view: 'not-settings' });
  select({});
  select(null);
  expect(screen.queryByText('configuração')).not.toBeInTheDocument();
});

test('Settings opens as a page over the dashboard, which stays mounted and inert (#294, #510)', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
  currentState = state([], worker());
  const select = stubBridge();
  render(<App />);

  select({ view: 'settings' }); // Settings opens from the menus or its shortcut (#499)

  expect(screen.getByRole('navigation', { name: t('settings.nav') })).toBeInTheDocument();
  // The dashboard stays mounted (#510): its header's view switch, found with hidden: true since inert hides it from the a11y tree, is still in the DOM.
  expect(screen.getByRole('radio', { name: new RegExp(t('header.flow')), hidden: true }).closest('[inert]')).not.toBeNull();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the shortcut map\'s link closes it and opens Settings on atalhos; over the Settings page the key does nothing (#639)', async () => {
  const user = userEvent.setup();
  setupInfoBox.info = savableSetupInfo;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
  stubBridge();
  currentState = state([], worker());
  render(<App />);
  const mapKey = (): boolean => fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true }); // off macOS (#639)
  mapKey();
  await user.click(within(screen.getByRole('dialog', { name: 'atalhos' })).getByRole('button', { name: 'editar em configurações › atalhos' }));
  expect(screen.queryByRole('dialog', { name: 'atalhos' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('atalhos');
  mapKey();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a save closes the settings page (#294)', async () => {
  const user = userEvent.setup();
  setupInfoBox.info = savableSetupInfo;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/settings') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  currentState = state([], worker());
  const select = stubBridge();
  render(<App />);
  select({ view: 'settings' }); // Settings opens from the menus or its shortcut (#499)
  await user.click(screen.getByRole('button', { name: t('settings.section.app') }));
  await user.type(screen.getByLabelText(t('settings.terminalFont')), 'x'); // a save is disabled with no change (#510)

  await user.click(screen.getByRole('button', { name: t('settings.save') }));

  await waitFor(() => expect(screen.queryByText('configuração')).not.toBeInTheDocument());
});

test('an unconfigured info renders the full-page setup, with no dashboard mounted (#294)', () => {
  setupInfoBox.info = { ...defaultSetupInfo, configured: false };
  currentState = undefined;
  render(<App />);

  expect(screen.getByText(t('settings.title'))).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: t('settings.nav') })).toBeInTheDocument();
  // no Dashboard mounted behind the first-run form (#294): Settings' own `<main>` is not the Dashboard's
  expect(screen.queryByRole('radio', { name: new RegExp(t('header.flow')) })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
