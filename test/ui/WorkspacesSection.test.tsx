import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import type { SettingsSection } from '@/lib/settings-sections';
import type { MemoryView, SettingsInfo } from '../../src/types';
import { WORKSPACE_PRESET_COLORS as PRESETS } from '../../src/types';
import { jsonResponse } from '../fakes';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));

// Settings › workspaces (#348, #511), through the whole form: each workspace's card with its env, the Comb's command table, its draft, its
// validation and the body POST /settings gets. No board, so nothing but the save reaches fetch.
const DEV = { name: 'dev', impls: [{ workspace: 'hive', command: 'pnpm dev' }], menu: true, env: {} };
const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: {
      prefix: 'HIVE', hiveSource: true, createIn: 'hive', sources: [], transitions: [], stages: [{ name: 'fila', from: {} }], commands: [DEV],
      workspaces: [{ name: 'hive', path: '/repo', env: { NODE_ENV: 'development' }, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: '#a1b2c3' }, { name: 'web', path: '/web', env: { PORT: '8' }, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: PRESETS[1] }],
    },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
};

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

interface Body { workspaces: Record<string, unknown>[]; commands: unknown[] }
const posted = (): Body => {
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  return JSON.parse(String(init?.body)) as Body;
};
const row = (n: number) => within(screen.getByRole('group', { name: t('settings.commands.row', { n }) }));
const save = async (user: UserEvent, onSaved: ReturnType<typeof vi.fn>) => {
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
};

test('a workspace env editor adds a row with + and removes one with ×; its group is named after the workspace (#348, #511)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const env = within(screen.getByRole('group', { name: t('settings.workspaceEnv', { workspace: 'hive' }) }));
  expect(env.getByLabelText('nome da variável 1')).toHaveValue('NODE_ENV');
  await user.click(env.getByRole('button', { name: '+ variável' }));
  await user.type(env.getByLabelText('nome da variável 2'), 'API_BASE');
  const remove = env.getByRole('button', { name: 'remover variável 1' });
  expect([remove.textContent, remove.querySelector('svg') !== null]).toEqual(['', true]);
  await user.click(remove);
  expect(env.getByLabelText('nome da variável 1')).toHaveValue('API_BASE');
  expect(env.queryByLabelText('nome da variável 2')).not.toBeInTheDocument();
});

test('the workspace env is sent with the workspace, a blank row dropped and the value as typed; a name export cannot take stops the save on workspaces (#348, #511)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const env = within(screen.getByRole('group', { name: t('settings.workspaceEnv', { workspace: 'hive' }) }));
  await user.click(env.getByRole('button', { name: '+ variável' }));
  await user.type(env.getByLabelText('nome da variável 2'), 'API-BASE');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.workspaceEnv', { workspace: 'hive' }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.clear(env.getByLabelText('nome da variável 2'));
  await user.type(env.getByLabelText('nome da variável 2'), 'API_BASE');
  await user.type(env.getByLabelText('valor da variável 2'), ' /api ');
  await user.click(env.getByRole('button', { name: '+ variável' })); // left blank: dropped on save
  await save(user, onSaved);
  expect(posted().workspaces[0]).toEqual({ name: 'hive', path: '/repo', env: { NODE_ENV: 'development', API_BASE: ' /api ' }, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: '#a1b2c3' });
});

test('commands table (#755): the column headers, a line per workspace with its own select, where the command is missing, and the note', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const card = within(screen.getByRole('region', { name: t('settings.group.commands') }));
  expect(card.getByRole('heading', { level: 2, name: t('settings.group.commands') })).toBeInTheDocument();
  for (const col of ['name', 'impls', 'timeout', 'env', 'menu'] as const) expect(card.getByText(t(`settings.commands.col.${col}`))).toBeInTheDocument();
  expect(row(1).getByLabelText(t('settings.commands.name', { n: 1 }))).toHaveValue('dev');
  expect(row(1).getByRole('combobox', { name: t('settings.commands.implWorkspace', { n: 1, workspace: 'hive' }) })).toHaveTextContent('hive');
  expect(row(1).getByLabelText(t('settings.commands.command', { n: 1, workspace: 'hive' }))).toHaveValue('pnpm dev');
  expect(row(1).getByText(t('settings.commands.missing', { list: 'web' }))).toBeInTheDocument();
  expect(card.getByText(t('settings.commands.note'))).toBeInTheDocument();
});

test('+ workspace adds a line for the first workspace without one and leaves when none is left; that line can become the other workspaces; the save posts own lines by name, the other workspaces last, and the timeout (#755)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  await user.click(row(1).getByRole('button', { name: t('settings.commands.addImplFor', { name: 'dev' }) }));
  expect(row(1).queryByRole('button', { name: t('settings.commands.addImplFor', { name: 'dev' }) })).not.toBeInTheDocument();
  expect(row(1).queryByText(t('settings.commands.missing', { list: 'web' }))).not.toBeInTheDocument();
  await user.type(row(1).getByLabelText(t('settings.commands.command', { n: 1, workspace: 'web' })), 'vite');
  fireEvent.click(row(1).getByRole('combobox', { name: t('settings.commands.implWorkspace', { n: 1, workspace: 'web' }) }));
  fireEvent.click(await screen.findByRole('option', { name: t('settings.commands.others') }));
  expect(row(1).getByLabelText(t('settings.commands.command', { n: 1, workspace: t('settings.commands.others') }))).toHaveValue('vite');
  expect(row(1).getByRole('button', { name: t('settings.commands.addImplFor', { name: 'dev' }) })).toBeInTheDocument();
  await user.type(row(1).getByLabelText(t('settings.commands.timeout', { n: 1 })), '10m');
  await save(user, onSaved);
  expect(posted().commands).toEqual([{ ...DEV, impls: [{ workspace: 'hive', command: 'pnpm dev' }, { workspace: null, command: 'vite' }], timeout: '10m' }]);
  expect(posted().workspaces.every((p) => !('commands' in p))).toBe(true);
});

test('command variables (#511, #755): + variável opens the panel with one row, the note says which workspace value it replaces where the command runs, the toggle counts and folds it', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  await user.click(row(1).getByRole('button', { name: t('settings.commands.addImplFor', { name: 'dev' }) }));
  await user.click(row(1).getByRole('button', { name: t('settings.env.add') }));
  const env = within(screen.getByRole('group', { name: t('settings.commands.env', { name: 'dev' }) }));
  await user.type(env.getByLabelText('nome da variável 1'), 'PORT');
  await user.type(env.getByLabelText('valor da variável 1'), '9');
  expect(env.getByText(t('settings.commands.overrides', { value: '8', workspace: 'web' }))).toBeInTheDocument();
  const toggle = row(1).getByRole('button', { name: /1 variável/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await user.click(toggle);
  expect(screen.queryByRole('group', { name: t('settings.commands.env', { name: 'dev' }) })).not.toBeInTheDocument();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('no menu (#755): a switch per command, on as saved; off reads só etapas under it and is saved', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const toggle = row(1).getByRole('switch', { name: t('settings.commands.menu', { name: 'dev' }) });
  expect(toggle).toBeChecked();
  expect(row(1).queryByText(t('settings.commands.stagesOnly'))).not.toBeInTheDocument();
  await user.click(toggle);
  expect(row(1).getByText(t('settings.commands.stagesOnly'))).toBeInTheDocument();
  await save(user, onSaved);
  expect(posted().commands).toEqual([{ ...DEV, menu: false }]);
});

test('a new command runs in all workspaces, renaming a workspace carries its lines, and a command left with no line stops the save naming it (#755)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  await user.click(screen.getByRole('button', { name: t('settings.commands.add') }));
  const all = t('settings.commands.all');
  expect(row(2).getByRole('combobox', { name: t('settings.commands.implWorkspace', { n: 2, workspace: all }) })).toHaveTextContent(all);
  await user.type(row(2).getByLabelText(t('settings.commands.name', { n: 2 })), 'lint');
  await user.type(row(2).getByLabelText(t('settings.commands.command', { n: 2, workspace: all })), 'pnpm lint');
  const name = screen.getByLabelText(`${t('settings.workspaces.name')} 1`);
  await user.clear(name);
  await user.type(name, 'core');
  expect(row(1).getByRole('combobox', { name: t('settings.commands.implWorkspace', { n: 1, workspace: 'core' }) })).toHaveTextContent('core');
  await user.click(row(1).getByRole('button', { name: t('settings.commands.removeImpl', { name: 'dev', workspace: 'core' }) }));
  expect(row(1).getByText(t('settings.commands.missing', { list: 'core, web' }))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.commandImpls', { name: 'dev' }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.click(row(1).getByRole('button', { name: t('settings.commands.addImplFor', { name: 'dev' }) }));
  await user.type(row(1).getByLabelText(t('settings.commands.command', { n: 1, workspace: 'core' })), 'pnpm dev');
  await save(user, onSaved);
  expect(posted().commands).toEqual([{ ...DEV, impls: [{ workspace: 'core', command: 'pnpm dev' }] }, { name: 'lint', impls: [{ workspace: null, command: 'pnpm lint' }], menu: true, env: {} }]);
});

test('a bad timeout stops the save on workspaces with its message (#511)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'flow');
  await open(user, 'workspaces');
  await user.type(row(1).getByLabelText(t('settings.commands.timeout', { n: 1 })), '10');
  await open(user, 'flow');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.commandTimeout', { n: 1 }))).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('settings.section.workspaces'));
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
});

test('each workspace is a card with name, folder, setup + timeout per step, the teardown + its timeout, the COPY / RUN / LOAD / DEL badges and its environment (#511, #654)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  expect(screen.getByRole('region', { name: 'web' })).toBeInTheDocument();
  const hive = within(screen.getByRole('region', { name: 'hive' }));
  for (const key of ['settings.workspaces.name', 'settings.workspaces.path', 'settings.workspaces.setup'] as const) expect(hive.getByLabelText(`${t(key)} 1`)).toBeInTheDocument();
  expect(hive.getByRole('textbox', { name: `${t('settings.workspaces.setup')}: ${t('settings.workspaces.stepTimeout')} 1` })).toBeInTheDocument();
  expect(hive.getAllByText(t('settings.workspaces.setupTimeoutHint'))).toHaveLength(2); // the setup's and the teardown's (#654)
  for (const step of ['copy', 'run', 'load', 'del'] as const) expect(hive.getAllByText(t(`settings.workspaces.step.${step}`))).toHaveLength(2);
  const env = within(hive.getByRole('group', { name: t('settings.workspaceEnv', { workspace: 'hive' }) }));
  expect(env.getByRole('button', { name: t('settings.env.add') })).toBeInTheDocument();
  const remove = hive.getByRole('button', { name: t('settings.workspaces.remove', { n: 1 }) });
  expect(remove).toBeEnabled();
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.add') }));
  expect(screen.getByLabelText(`${t('settings.workspaces.name')} 3`)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.remove', { n: 3 }) }));
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.remove', { n: 2 }) }));
  expect(screen.getByRole('button', { name: t('settings.workspaces.remove', { n: 1 }) })).toBeDisabled();
});

test('+ workspace sits on the heading row, before the first workspace card', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const add = screen.getByRole('button', { name: t('settings.workspaces.add') });
  const heading = screen.getByRole('heading', { level: 1, name: t('settings.section.workspaces') });
  expect(heading.closest('header')).toContainElement(add);
  expect(add.compareDocumentPosition(screen.getByRole('region', { name: 'hive' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('the commands card explains itself beside its title', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const title = screen.getByRole('heading', { level: 2, name: t('settings.group.commands') });
  expect(title.parentElement).toHaveTextContent(t('settings.commands.hint'));
  expect(t('settings.commands.hint')).toMatch(/^atalhos para o que você repete em uma tarefa/);
});

test('a workspace card has the teardown and its timeout below the setup; both are saved when filled and left out when empty (#654)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const hive = within(screen.getByRole('region', { name: 'hive' }));
  const setup = hive.getByLabelText(`${t('settings.workspaces.setup')} 1`);
  const teardown = hive.getByLabelText(`${t('settings.workspaces.teardown')} 1`);
  expect(setup.compareDocumentPosition(teardown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(teardown).toHaveAttribute('placeholder', 'RUN docker compose down');
  expect(hive.getByText(t('settings.workspaces.teardownHelp'))).toBeInTheDocument();
  await user.type(teardown, 'RUN docker compose down');
  await user.type(hive.getByRole('textbox', { name: `${t('settings.workspaces.teardown')}: ${t('settings.workspaces.stepTimeout')} 1` }), '2m');
  await save(user, onSaved);
  const [hiveRow, webRow] = posted().workspaces;
  expect(hiveRow).toMatchObject({ teardown: 'RUN docker compose down', teardownTimeout: '2m' });
  expect(webRow).not.toHaveProperty('teardown');
  expect(webRow).not.toHaveProperty('teardownTimeout');
});

test('a workspace card has no conventions group, and a save posts no conventions key (#318)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const hive = within(screen.getByRole('region', { name: 'hive' }));
  expect(hive.queryByRole('heading', { name: 'convenções' })).not.toBeInTheDocument();
  await user.type(hive.getByLabelText(`${t('settings.workspaces.teardown')} 1`), 'RUN docker compose down'); // a change, so the save is enabled
  await save(user, onSaved);
  expect(posted().workspaces.some((w) => 'conventions' in w)).toBe(false);
});

test('the card has no total limit field: a cap the memory dialog saves reaches the draft and its baseline, so the footer shows no change and a later save posts it (#115)', async () => {
  let cap = 4000;
  const fetchCap = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/workspaces/hive/memory/cap') {
      cap = (JSON.parse(String(init?.body)) as { cap: number }).cap;
      return jsonResponse({ ok: true });
    }
    if (url === '/workspaces/hive/memory') return jsonResponse({ entries: [], used: 0, cap, textMax: 300 } satisfies MemoryView);
    if (url === '/workspaces/hive/memory/stats') return jsonResponse({ runs: 0, cited: 0 });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchCap); // afterEach unstubs it
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const hive = within(screen.getByRole('region', { name: 'hive' }));
  expect(await hive.findByText('0 de 4.000 caracteres')).toBeInTheDocument();
  expect(hive.queryByRole('spinbutton', { name: /limite total/ })).not.toBeInTheDocument();
  await user.click(hive.getByRole('button', { name: t('settings.memory.open') }));
  const dialog = within(await screen.findByRole('dialog'));
  const field = dialog.getByRole('spinbutton', { name: t('settings.memory.totalLimit') });
  await user.clear(field);
  await user.type(field, '6000');
  await user.click(dialog.getByRole('button', { name: t('settings.memory.save') }));
  expect(await dialog.findByText('0 de 6.000 caracteres')).toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: t('settings.memory.close') }));
  expect(await hive.findByText('0 de 6.000 caracteres')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.cancel') })).toBeDisabled(); // no unsaved change: the baseline has it too
  const env = within(hive.getByRole('group', { name: t('settings.workspaceEnv', { workspace: 'hive' }) }));
  await user.click(env.getByRole('button', { name: t('settings.env.add') }));
  await user.type(env.getByLabelText('nome da variável 2'), 'API_BASE');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchCap.mock.calls.find(([url]) => url === '/settings')!;
  expect((JSON.parse(String(init?.body)) as Body).workspaces.map((w) => w.memoryCap)).toEqual([6000, 4000]);
});

const card = (name: string) => within(screen.getByRole('region', { name }));
const colorOptions = () => within(screen.getByRole('listbox', { name: t('settings.workspaces.colors') })).getAllByRole('option');
const selectedColor = () => colorOptions().findIndex((o) => o.getAttribute('aria-selected') === 'true');

test('a workspace card opens on its colour: the field first in its top row, the saved custom colour on the swatch and selected (#78)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  const swatch = card('hive').getByRole('button', { name: t('settings.workspaces.colorLabel') });
  expect(card('hive').getByText(t('settings.workspaces.color'))).toBeInTheDocument();
  expect(swatch.querySelector('span')).toHaveStyle({ backgroundColor: '#a1b2c3' });
  await user.click(swatch);
  expect(selectedColor()).toBe(7);
  await user.keyboard('{Escape}');
  await user.click(card('web').getByRole('button', { name: t('settings.workspaces.colorLabel') }));
  expect(selectedColor()).toBe(1);
});

test('+ workspace gives the new card the first preset no other row uses (#78)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.add') }));
  await user.click(card(t('settings.workspaces.card', { n: 3 })).getByRole('button', { name: t('settings.workspaces.colorLabel') }));
  expect(selectedColor()).toBe(0); // hive's is custom, web's is PRESETS[1]
});

test('a picked colour is part of the draft and the save sends it (#78)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  await user.click(card('hive').getByRole('button', { name: t('settings.workspaces.colorLabel') }));
  await user.click(colorOptions()[3]);
  await save(user, onSaved);
  expect(posted().workspaces.map((w) => w.color)).toEqual([PRESETS[3], PRESETS[1]]);
});

test('the workspace card\'s PRs de benchmark select shows the saved value and sends the one picked (#477)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const card = within(screen.getByRole('region', { name: 'hive' }));
  const select = card.getByRole('combobox', { name: 'PRs de benchmark' });
  expect(select).toHaveTextContent('numa worktree temporária');
  await user.click(select);
  await user.click(screen.getByRole('option', { name: 'no checkout do workspace' }));
  expect(select).toHaveTextContent('no checkout do workspace');
  await save(user, onSaved);
  expect(posted().workspaces.map((w) => w.benchmarkPrIn)).toEqual(['checkout', 'worktree']);
});
