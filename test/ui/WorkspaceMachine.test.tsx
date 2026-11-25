import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import type { MachineStatus, SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

// Settings › workspaces › machine (#933): the field GET /machines gates, its saved lock and the chosen distro's problem lines.
const ws = (name: string, machine: string) => ({ name, path: `/${name}`, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree' as const, machine, color: '#a1b2c3' });
const infoWith = (workspaces: ReturnType<typeof ws>[]): SettingsInfo => ({
  configured: true, home: '/home', language: 'en', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', sources: [], flows: [{ name: 'main', stages: [{ name: 'queue', from: {} }], transitions: [] }], commands: [], workspaces },
    logLevel: 'info', agentArgs: { claude: [], codex: [], copilot: [] }, agentModels: { claude: null, codex: null, copilot: null }, agentEnabled: { claude: true, codex: true, copilot: false }, budget: {}, usageRules: [], commandSemaphores: [], accounts: {},
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], gitlabHosts: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
});

const LOCAL: MachineStatus = { id: 'local', status: 'ready' };
const readyDistro = (extra: Partial<MachineStatus> = {}): MachineStatus => ({ id: 'wsl:Ubuntu', status: 'ready', agents: [{ agent: 'claude', available: true, loggedIn: true }], gh: true, ...extra });
let machines: unknown = { machines: [LOCAL] };
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  const body = url === '/machines' ? machines : url.endsWith('/holdings') ? { activities: [], worktrees: [], branches: [], tasks: [], running: false } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
});

beforeEach(() => { setLanguage('en'); machines = { machines: [LOCAL] }; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const openWorkspaces = (user: UserEvent) => user.click(screen.getByRole('button', { name: t('settings.section.workspaces') }));
const field = () => screen.queryByRole('combobox', { name: t('settings.workspaces.machine') });
const postedMachines = () => {
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  return (JSON.parse(String(init?.body)) as { workspaces: { machine: string }[] }).workspaces.map((w) => w.machine);
};

test('with only the local machine listed, or a failed read, the card has no machine field', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Settings info={infoWith([ws('hive', 'local')])} onSaved={vi.fn()} />);
  await openWorkspaces(user);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/machines'));
  expect(field()).not.toBeInTheDocument();
  unmount();
  machines = {}; // malformed answer
  render(<Settings info={infoWith([ws('hive', 'local')])} onSaved={vi.fn()} />);
  await openWorkspaces(user);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/machines')).toHaveLength(2));
  expect(field()).not.toBeInTheDocument();
});

test('with a distro listed the select appears on a new workspace and saves the chosen distro', async () => {
  machines = { machines: [LOCAL, readyDistro()] };
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={infoWith([ws('hive', 'local')])} onSaved={onSaved} />);
  await openWorkspaces(user);
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.add') }));
  const selects = await screen.findAllByRole('combobox', { name: t('settings.workspaces.machine') });
  expect(selects[0]).toBeDisabled(); // saved
  await user.click(selects[1]!);
  await user.click(await screen.findByRole('option', { name: 'Ubuntu' }));
  await user.type(screen.getByLabelText(`${t('settings.workspaces.name')} 2`), 'web');
  await user.type(screen.getByLabelText(`${t('settings.workspaces.path')} 2`), '/web');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(postedMachines()).toEqual(['local', 'wsl:Ubuntu']);
});

test('a saved workspace of a distro the list lacks keeps it selected as not found and saves it unchanged', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={infoWith([ws('hive', 'wsl:Gone')])} onSaved={onSaved} />);
  await openWorkspaces(user);
  const select = await screen.findByRole('combobox', { name: t('settings.workspaces.machine') });
  expect(select).toHaveTextContent('Gone (not found)');
  expect(select).toBeDisabled();
  expect(screen.getByText(t('settings.workspaces.machineLocked'))).toBeInTheDocument();
  await user.type(screen.getByLabelText(`${t('settings.workspaces.path')} 1`), '2'); // a change, so the save is enabled
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(postedMachines()).toEqual(['wsl:Gone']);
});

test.each([
  ['en', { status: 'node_missing' }, 'Node 24 or later is missing: install it inside Ubuntu'],
  ['pt', { status: 'node_missing' }, 'falta o Node 24 ou mais novo: instale-o dentro de Ubuntu'],
  ['en', { status: 'stopped' }, 'Ubuntu is stopped: run wsl -d Ubuntu on Windows'],
  ['en', { status: 'node_old' }, 'Node is older than 24: update it inside Ubuntu'],
  ['en', { status: 'helper_failed' }, 'Ubuntu cannot be reached (helper_failed)'],
  ['en', { agents: [{ agent: 'claude', available: false }] }, 'claude is not installed: install it inside Ubuntu'],
  ['en', { agents: [{ agent: 'claude', available: true, loggedIn: false }] }, 'agent claude is not logged in on Ubuntu: run claude inside the distro and log in'],
  ['en', { gh: false }, 'gh is missing or not logged in: install it and run gh auth login inside Ubuntu'],
] as const)('a distro line in %s for %j', async (lang, extra, line) => {
  machines = { machines: [LOCAL, readyDistro(extra as Partial<MachineStatus>)] };
  setLanguage(lang);
  render(<Settings info={infoWith([ws('hive', 'wsl:Ubuntu')])} onSaved={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: t('settings.section.workspaces') }));
  expect(await screen.findByRole('status')).toHaveTextContent(line);
});

test('a ready distro with nothing missing shows no line, and neither does the local machine', async () => {
  machines = { machines: [LOCAL, readyDistro()] };
  render(<Settings info={infoWith([ws('hive', 'wsl:Ubuntu')])} onSaved={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: t('settings.section.workspaces') }));
  await screen.findByRole('combobox', { name: t('settings.workspaces.machine') });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
