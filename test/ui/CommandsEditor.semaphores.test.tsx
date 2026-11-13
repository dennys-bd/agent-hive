import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import type { SettingsSection } from '@/lib/settings-sections';
import type { Command, CommandSemaphore, SettingsInfo, Workspace } from '../../src/types';
import { WORKSPACE_PRESET_COLORS as PRESETS } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const BASE: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: {
      prefix: 'HIVE', hiveSource: true, createIn: 'hive', sources: [], flows: [{ name: 'main', stages: [{ name: 'fila', from: {} }], transitions: [] }], commands: [],
      workspaces: [{ name: 'hive', path: '/repo', env: { NODE_ENV: 'development' }, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: '#a1b2c3' }, { name: 'web', path: '/web', env: { PORT: '8' }, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: PRESETS[1] }],
    },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true }, budget: {}, usageRules: [], commandSemaphores: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
};

// Settings › workspaces › commands' semaphore picker (#804), through the whole form: the pick, the draft, the hint and the save body
const workspace = (name: string, color: string): Workspace => ({ name, path: `/${name}`, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color });
const SEMAPHORES: CommandSemaphore[] = [{ name: 'memory', limit: 2, reservation: '2m' }, { name: 'banco', limit: 1, reservation: '5m' }];
const TESTES: Command = { name: 'testes', impls: [{ workspace: 'core-api', command: 'pytest' }, { workspace: null, command: 'pnpm run tests' }], menu: true, env: {} };
const withSemaphores = (names: (string | undefined)[]): Command => ({ ...TESTES, impls: TESTES.impls.map((line, i) => (names[i] === undefined ? line : { ...line, semaphore: names[i] })) });
const infoWith = (commandSemaphores: CommandSemaphore[], commands: Command[] = [TESTES]): SettingsInfo => ({
  ...BASE,
  config: { ...BASE.config!, commandSemaphores, comb: { ...BASE.config!.comb, commands, workspaces: [workspace('core-api', PRESETS[0]), workspace('agent-hive', PRESETS[1])] } },
});

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));
const posted = (): { commands: Command[]; commandSemaphores: CommandSemaphore[] } => {
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  return JSON.parse(String(init?.body)) as { commands: Command[]; commandSemaphores: CommandSemaphore[] };
};
const save = async (user: UserEvent, onSaved: ReturnType<typeof vi.fn>) => {
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
};
const row = () => within(screen.getByRole('group', { name: t('settings.commands.row', { n: 1 }) }));
const picker = (where: string, semaphore = 'nenhum') => row().getByRole('combobox', { name: `revezamento de testes em ${where}: ${semaphore}` });
const choose = async (user: UserEvent, trigger: HTMLElement, option: string) => {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: option }));
};
const options = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);

test('picking memory on testes\' core-api line sets that line only, the hint names it, and the save sends semaphore: "memory" there (#804 decisions 2, 6)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={infoWith(SEMAPHORES)} onSaved={onSaved} />);
  await open(user, 'workspaces');
  expect(screen.getByText('comando em cada workspace · revezamento')).toBeInTheDocument();
  await choose(user, picker('core-api'), 'memory');
  expect(picker('core-api', 'memory')).toBeInTheDocument();
  expect(picker('os demais workspaces')).toBeInTheDocument();
  expect(row().getByText('memory em core-api')).toBeInTheDocument();
  await save(user, onSaved);
  expect(posted().commands).toEqual([withSemaphores(['memory', undefined])]);
  expect(posted().commands[0].impls[1]).not.toHaveProperty('semaphore');
});

test('the trigger reads its semaphore in title, aria-label and colour; none removes the key from the save (#804 decisions 2, 5)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={infoWith(SEMAPHORES, [withSemaphores(['memory', 'memory'])])} onSaved={onSaved} />);
  await open(user, 'workspaces');
  expect(row().getByText('memory nas 2 linhas')).toBeInTheDocument();
  const on = picker('core-api', 'memory');
  expect(on).toHaveAttribute('aria-expanded', 'false');
  expect(on).toHaveAttribute('title', 'revezamento: memory');
  expect(on).toHaveClass('text-foreground');
  await choose(user, on, 'nenhum');
  const off = picker('core-api');
  expect(off).toHaveAttribute('title', 'sem revezamento');
  expect(off).toHaveClass('text-muted-foreground');
  expect(row().getByText('memory em os demais workspaces')).toBeInTheDocument();
  await save(user, onSaved);
  expect(posted().commands[0].impls[0]).not.toHaveProperty('semaphore');
  expect(posted().commands[0].impls[1]).toEqual({ workspace: null, command: 'pnpm run tests', semaphore: 'memory' });
});

test('the picker is a combobox the keyboard opens and picks with (#804 decision 1)', async () => {
  const user = userEvent.setup();
  render(<Settings info={infoWith(SEMAPHORES)} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const trigger = picker('core-api');
  act(() => trigger.focus());
  await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(screen.getByRole('option', { name: 'nenhum' })).toHaveFocus());
  await user.keyboard('{ArrowDown}{Enter}');
  expect(picker('core-api', 'memory')).toHaveAttribute('aria-expanded', 'false');
});

test('a semaphore added in the rules card and not saved is an option, as "novo revezamento" until named, and saves under its name (#804 decision 3)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={infoWith(SEMAPHORES)} onSaved={onSaved} />);
  await open(user, 'rules');
  await user.click(screen.getByRole('button', { name: '+ revezamento' }));
  await open(user, 'workspaces');
  await user.click(picker('core-api'));
  expect(options()).toEqual(['nenhum', 'memory', 'banco', 'novo revezamento']);
  expect(screen.getByText('a linha espera a vez com as outras do mesmo revezamento')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await open(user, 'rules');
  await user.type(screen.getAllByLabelText('nome do revezamento')[2], 'ports');
  await open(user, 'workspaces');
  await choose(user, picker('core-api'), 'ports');
  await save(user, onSaved);
  expect(posted().commandSemaphores.map((s) => s.name)).toEqual(['memory', 'banco', 'ports']);
  expect(posted().commands[0].impls[0]).toEqual({ workspace: 'core-api', command: 'pytest', semaphore: 'ports' });
});

test('with no semaphore the muted button still opens, on none and the empty note (#804 decision 4)', async () => {
  const user = userEvent.setup();
  render(<Settings info={infoWith([])} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const inRow = row(); // the open menu hides the rest of the page from role queries
  const trigger = picker('core-api');
  expect(trigger).toHaveClass('text-muted-foreground');
  await user.click(trigger);
  expect(options()).toEqual(['nenhum']);
  expect(screen.getByText('nenhum revezamento ainda · crie um em regras › revezamentos')).toBeInTheDocument();
  expect(screen.queryByText('a linha espera a vez com as outras do mesmo revezamento')).not.toBeInTheDocument();
  expect(inRow.queryByText(/nas \d linhas/)).not.toBeInTheDocument();
});

test('the card foot explains the hourglass and its link opens Settings › rules (#804 decision 9)', async () => {
  const user = userEvent.setup();
  render(<Settings info={infoWith(SEMAPHORES)} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const card = within(screen.getByRole('region', { name: t('settings.group.commands') }));
  expect(card.getByText(t('settings.commands.note'))).toBeInTheDocument();
  expect(card.getByText(t('settings.commands.semaphore.foot'), { exact: false })).toBeInTheDocument();
  await user.click(card.getByRole('button', { name: 'regras › revezamentos' }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('settings.section.rules'));
});
