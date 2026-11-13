import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { searchEntries as rulesEntries } from '@/components/settings/RulesTab';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import { searchSettings, settingAnchor } from '@/lib/settings-search';
import type { SettingsSection } from '@/lib/settings-sections';
import type { Command, CommandSemaphore, Language, SettingsBody, SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' }], flows: [{ name: 'main', stages: [{ name: 'fila', from: { board: ['Ready'] } }], transitions: [] }], commands: [] },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true }, budget: {}, usageRules: [], commandSemaphores: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
};

const base = info.config!;
const withSemaphores = (commandSemaphores: CommandSemaphore[], commands: Command[] = []): SettingsInfo => ({ ...info, config: { ...base, commandSemaphores, comb: { ...base.comb, commands } } });
const TESTES: Command = { name: 'testes', impls: [{ workspace: 'hive', command: 'pnpm test', semaphore: 'memory' }], menu: true, env: {} };

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }]);
  if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
  return jsonResponse({});
});
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));
const savedBody = (): SettingsBody => {
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  return JSON.parse(String(init?.body)) as SettingsBody;
};
const save = async (user: UserEvent, onSaved: ReturnType<typeof vi.fn>) => {
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
};

test('adding memory with limit 2 and reservation 2m puts it in the save body; a saved semaphore shows as its row (#803)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const { unmount } = render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'rules');
  await user.click(screen.getByRole('button', { name: '+ revezamento' }));
  await user.keyboard('memory'); // the new row's name has the focus
  const limit = screen.getByLabelText('memory: ao mesmo tempo');
  await user.clear(limit);
  await user.type(limit, '2');
  const reservation = screen.getByLabelText('memory: reserva da vez');
  await user.clear(reservation);
  await user.type(reservation, '2m');
  await save(user, onSaved);
  expect(savedBody().commandSemaphores).toEqual([{ name: 'memory', limit: 2, reservation: '2m' }]);
  unmount();
  render(<Settings info={withSemaphores([{ name: 'memory', limit: 2, reservation: '2m' }])} onSaved={vi.fn()} />);
  await open(user, 'rules');
  expect(screen.getByDisplayValue('memory')).toBeInTheDocument();
  expect(screen.getByLabelText('memory: ao mesmo tempo')).toHaveValue(2);
});

test('a refused row stops the save before the round trip, names its row in the section\'s alert and marks its field (#803 decision 5)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'rules');
  await user.click(screen.getByRole('button', { name: '+ revezamento' }));
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.semaphoreName', { n: 1 }))).toBeInTheDocument();
  expect(screen.getByLabelText('nome do revezamento')).toHaveAttribute('aria-invalid', 'true');
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  expect(onSaved).not.toHaveBeenCalled();
});

test('renaming a semaphore renames it on the line that names it, in the same save (#803 decision 3)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={withSemaphores([{ name: 'memory', limit: 1, reservation: '2m' }], [TESTES])} onSaved={onSaved} />);
  await open(user, 'rules');
  expect(screen.getByText('testes em hive')).toBeInTheDocument();
  const name = screen.getByDisplayValue('memory');
  await user.clear(name);
  await user.type(name, 'heavy');
  await save(user, onSaved);
  expect(savedBody().commandSemaphores).toEqual([{ name: 'heavy', limit: 1, reservation: '2m' }]);
  expect(savedBody().commands![0].impls).toEqual([{ workspace: 'hive', command: 'pnpm test', semaphore: 'heavy' }]);
});

test('removing a semaphore clears it from the line that names it, in the same save (#803 decision 4)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={withSemaphores([{ name: 'memory', limit: 1, reservation: '2m' }], [TESTES])} onSaved={onSaved} />);
  await open(user, 'rules');
  await user.click(screen.getByRole('button', { name: 'remover memory' }));
  await save(user, onSaved);
  expect(savedBody().commandSemaphores).toEqual([]);
  expect(savedBody().commands![0].impls).toEqual([{ workspace: 'hive', command: 'pnpm test' }]);
});

test('the foot\'s workspaces › comandos opens Settings › workspaces (#803)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'rules');
  await user.click(screen.getByRole('button', { name: 'workspaces › comandos' }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('settings.section.workspaces'));
});

test('the Settings search finds the card by revezamentos and by its English name, and lands on its title (#803 decision 10)', () => {
  const labels = (query: string, language: Language): string[] => searchSettings(query, rulesEntries(), language).map((m) => m.label);
  expect(labels('revezamentos', 'pt')[0]).toBe('revezamentos');
  expect(labels('Command Semaphores', 'pt')[0]).toBe('revezamentos');
  expect(labels('semaphores', 'en')[0]).toBe('Command Semaphores');
  expect(rulesEntries().find((e) => e.label === 'settings.semaphores.title')?.anchor).toBe(settingAnchor('settings.semaphores.title'));
});
