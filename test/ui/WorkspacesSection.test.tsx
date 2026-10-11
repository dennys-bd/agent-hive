import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { formatCount, setLanguage, t } from '@/i18n';
import type { SettingsSection } from '@/lib/settings-sections';
import type { SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

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
      workspaces: [{ name: 'hive', path: '/repo', env: { NODE_ENV: 'development' }, fork: null, memoryCap: 4000 }, { name: 'web', path: '/web', env: { PORT: '8' }, fork: null, memoryCap: 4000 }],
    },
    logLevel: 'info', claudeArgs: [], budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS,
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
  expect(posted().workspaces[0]).toEqual({ name: 'hive', path: '/repo', env: { NODE_ENV: 'development', API_BASE: ' /api ' }, fork: null, memoryCap: 4000 });
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

test('a workspace\'s conventions card shows its saved conventions; a bad slice size stops the save with the parser\'s message, a good one is posted, a blank row dropped (#692)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const [hive, web] = info.config!.comb.workspaces;
  const config = { ...info.config!, comb: { ...info.config!.comb, workspaces: [{ ...hive, conventions: { specsDir: 'docs/specs', sliceSize: { min: 300, max: 550 } } }, web] } };
  render(<Settings info={{ ...info, config }} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const card = within(screen.getByRole('group', { name: t('settings.workspaceConventions', { workspace: 'hive' }) }));
  expect(card.getByLabelText(t('settings.conventions.value', { n: 1 }))).toHaveValue('docs/specs');
  const min = card.getByLabelText(t('settings.conventions.min', { n: 2 }));
  await user.clear(min);
  await user.type(min, '600');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.conventions.sliceSize', { workspace: 'hive' }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.clear(min);
  await user.type(min, '300');
  await user.click(card.getByRole('button', { name: t('settings.conventions.add') })); // a docsRepo row left blank
  await save(user, onSaved);
  expect(posted().workspaces.map((w) => w.conventions)).toEqual([{ specsDir: 'docs/specs', sliceSize: { min: 300, max: 550 } }, undefined]);
});

test('each workspace card edits its memory total limit with what a full memory costs per run under it; out of range it marks itself and stops the save on workspaces; the value is posted as a number (#73)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'workspaces');
  const hive = within(screen.getByRole('region', { name: 'hive' }));
  const cap = hive.getByRole('spinbutton', { name: `${t('settings.memory.cap')} 1` });
  expect(cap).toHaveValue(4000);
  expect(hive.getByText(t('settings.memory.capEstimate', { n: formatCount(1100) }))).toBeInTheDocument();
  await user.clear(cap);
  await user.type(cap, '20001');
  expect(cap).toHaveAttribute('aria-invalid', 'true');
  expect(hive.getByText(t('settings.memory.capRange'))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.memoryCap', { workspace: 'hive' }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.clear(cap);
  await user.type(cap, '8000');
  expect(cap).toHaveAttribute('aria-invalid', 'false');
  expect(hive.getByText(t('settings.memory.capEstimate', { n: formatCount(2100) }))).toBeInTheDocument();
  await save(user, onSaved);
  expect(posted().workspaces.map((w) => w.memoryCap)).toEqual([8000, 4000]);
});
