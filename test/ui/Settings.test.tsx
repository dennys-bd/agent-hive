import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppSection } from '@/components/settings/AppSection';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t, tPlural } from '@/i18n';
import type { SettingsSection } from '@/lib/settings-sections';
import { draftFrom } from '@/lib/settings-form';
import { fmt } from '@/lib/usage';
import type { FilterOptions, SettingsInfo, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));
// fluxo now opens on sources (#514): a board's fields live on its detail page, reached through its row's editar →.
const openSource = async (user: UserEvent, name: string): Promise<void> => {
  await open(user, 'flow');
  await user.click(screen.getByRole('button', { name: t('settings.sources.editSource', { source: name }) }));
};


const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' }], transitions: [], stages: [{ name: 'fila', from: { board: ['Ready'] } }], commands: [] },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true }, budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
};

// The fields a limits-tab test does not care about (#512): spread and override boards / usage / rateLimits.
const BASE_STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 0, workers: [], stages: [], tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [], syncs: {},
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const FILTER_OPTIONS: FilterOptions = { assignees: ['@me', 'ana'], labels: ['blocked', 'hive'], milestones: ['v1'], repositories: ['acme/app'], projectFields: [{ name: 'Priority', options: ['P0', 'P1'] }] };

// The default handler: a few tests below call fetchMock.mockImplementation(...) for their own scenario, so beforeEach restores this one
// on every test, otherwise a later test would silently inherit whichever custom implementation ran last (#245 found this the hard way).
const defaultFetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
  if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
  if (url.startsWith('/settings/filter-options')) return jsonResponse(FILTER_OPTIONS);
  return jsonResponse({});
};
const fetchMock = vi.fn(defaultFetch);

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); fetchMock.mockImplementation(defaultFetch); });
afterEach(() => vi.unstubAllGlobals());

test('picking a different project loads columns for the newly picked project, not the one left behind', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await openSource(user, 'board');

  // the mount effect loads the current project's (1) columns; wait for it to settle before the assertion below.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  fetchMock.mockClear();

  // a pointer click on this trigger can find the Select already dismissed in jsdom once openSource's own click ran first.
  screen.getByLabelText(t('settings.project')).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: '#2 Two' }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/settings/source-columns?type=github&owner=acme&number=2&auth=cli'));
});

test('Settings › General has no terminal select: nothing to choose, every run is a pty of the Hive (#378)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'app');
  expect(screen.queryByLabelText('Terminal')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Terminal' })).not.toBeInTheDocument();
});

// #524: the stages help paragraph is gone; its content now lives as short hints on the fields it described, in both languages.
test('the stages hints replace the removed help paragraph, in Portuguese and in English (#524)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'flow');
  expect(screen.getByText(t('settings.stages.maxWorkers.hint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.stages.prompt.hint'))).toBeInTheDocument();
  expect(screen.queryByText(/^o task avança quando o comando termina/)).not.toBeInTheDocument();
  unmount();
  setLanguage('en');
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'flow');
  expect(screen.getByText(t('settings.stages.maxWorkers.hint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.stages.prompt.hint'))).toBeInTheDocument();
  expect(screen.queryByText(/^the task advances when the command ends/)).not.toBeInTheDocument();
});

test('regras de uso: + regra adds a row, its medida picks the measure, a ruler appears per measure in use, × removes, and the save sends each rule on its source (#526)', async () => {
  const user = userEvent.setup();
  // Opened from the keyboard, like RulesEditor.test.tsx: a plain click on a second Radix Select in the same test can close itself on the trigger's click focus.
  const openSelect = async (trigger: HTMLElement) => { trigger.focus(); await user.keyboard('{Enter}'); };
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'rules');

  expect(screen.queryByText('medido em')).not.toBeInTheDocument();
  expect(screen.queryAllByTestId('rule-row')).toHaveLength(0);
  expect(screen.queryByRole('group', { name: t('settings.rules.measure.session') })).not.toBeInTheDocument();
  expect(screen.queryByText(t('settings.rules.caption'))).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '+ regra' }));
  const [sessionRow] = screen.getAllByTestId('rule-row');
  await user.type(within(sessionRow).getByLabelText('a partir de'), '60');
  await openSelect(within(sessionRow).getByLabelText('consequência'));
  await user.click(await screen.findByRole('option', { name: 'mudar o sinal para' }));
  await openSelect(within(sessionRow).getByLabelText('valor'));
  await user.click(await screen.findByRole('option', { name: 'yellow' }));

  const ruler = screen.getByRole('group', { name: t('settings.rules.measure.session') });
  expect(within(ruler).getByText(t('settings.rules.signal', { signal: 'yellow' }))).toBeInTheDocument();
  expect(ruler.querySelector('[data-signal="yellow"]')).toHaveStyle({ left: '60%' });
  expect(screen.getByText(t('settings.rules.caption'))).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '+ regra' }));
  const weekRow = screen.getAllByTestId('rule-row')[1];
  await openSelect(within(weekRow).getByLabelText('medida'));
  await user.click(await screen.findByRole('option', { name: t('settings.rules.measure.week') }));
  await user.type(within(weekRow).getByLabelText('a partir de'), '70');
  await openSelect(within(weekRow).getByLabelText('consequência'));
  await user.click(await screen.findByRole('option', { name: 'limitar workers a' }));
  await user.type(within(weekRow).getByLabelText('valor'), '2');
  expect(screen.getByRole('group', { name: t('settings.rules.measure.week') })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '+ regra' }));
  const thirdRow = screen.getAllByTestId('rule-row')[2];
  await user.click(within(thirdRow).getByRole('button', { name: 'remover regra' }));
  expect(screen.getAllByTestId('rule-row')).toHaveLength(2);

  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).usageRules).toEqual([{ source: 'session', percent: 60, signal: 'yellow' }, { source: 'week', percent: 70, maxWorkers: 2 }]);
});

test('while the save is pending, the save button reads "saving…" and is disabled, and so is cancel; onSaved runs once it resolves (#59)', async () => {
  const user = userEvent.setup();
  let resolveSetup: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { resolveSetup = resolve; });
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/settings') return pending;
    if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }]);
    if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
    return jsonResponse({});
  });
  const onSaved = vi.fn(async () => {});
  render(<Settings info={info} onSaved={onSaved} onCancel={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'execution');
  await user.type(screen.getByLabelText(t('settings.baseBranch')), 'x'); // a save is disabled with no change (#510)

  await user.click(screen.getByRole('button', { name: t('settings.save') }));

  const savingButton = await screen.findByRole('button', { name: t('settings.saving') });
  expect(savingButton).toBeDisabled();
  expect(screen.getByRole('button', { name: t('settings.cancel') })).toBeDisabled();
  expect(onSaved).not.toHaveBeenCalled();

  resolveSetup(jsonResponse({ ok: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ok: true }));
  expect(screen.getByRole('button', { name: t('settings.save') })).not.toBeDisabled();
});

test('the GitHub API card shows the freshest reading as points left, a bar of what is left, and the hint; the header switch lives there (#512)', async () => {
  const user = userEvent.setup();
  const state: State = {
    ...BASE_STATE,
    syncs: {
      board: { quota: { limit: 5_000, remaining: 4_320, resetsAt: '2026-09-17T15:00:00.000Z', at: '2026-09-17T12:00:00.000Z' } },
      old: { quota: { limit: 5_000, remaining: 100, resetsAt: '2026-09-17T15:00:00.000Z', at: '2026-09-17T10:00:00.000Z' } },
    },
  };
  render(<Settings info={info} state={state} onSaved={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));

  expect(screen.queryByText(/^GitHub \d/)).not.toBeInTheDocument();

  await open(user, 'rules');

  expect(screen.getByText('4.320 de 5.000 pontos restantes')).toBeInTheDocument();
  expect(screen.getByText(/^reseta em /)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: t('limits.github.bar') })).toHaveAttribute('aria-valuenow', '86');
  expect(screen.getByText(t('limits.github.hint'))).toBeInTheDocument();
  expect(screen.queryByText(t('limits.github.paused'))).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'mostrar a quota no header' })).toBeInTheDocument();
  expect(screen.queryByText(/^old /)).not.toBeInTheDocument();
});

test('the ruler and the row read the measure\'s current usage, and the budget card shows per hour, per day and now (#526)', async () => {
  const user = userEvent.setup();
  const state: State = {
    ...BASE_STATE,
    usage: [{ at: new Date().toISOString(), tokens: 100 }],
    rateLimits: { claude: { at: new Date().toISOString(), windows: { five_hour: { usedPercent: 11, resetsAt: '2099-01-01T00:00:00.000Z' } } } },
  };
  render(<Settings info={info} state={state} onSaved={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'rules');

  await user.click(screen.getByRole('button', { name: '+ regra' }));
  expect(within(screen.getByRole('group', { name: t('settings.rules.measure.session') })).getByText('agora 11%')).toBeInTheDocument();
  expect(within(screen.getByTestId('rule-row')).getByText('11%')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '+ regra' }));
  const weekRow = screen.getAllByTestId('rule-row')[1];
  weekRow.querySelector<HTMLElement>('[aria-label="medida"]')!.focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: t('settings.rules.measure.week') }));
  expect(within(screen.getByRole('group', { name: t('settings.rules.measure.week') })).getByText('nada medido ainda')).toBeInTheDocument();
  expect(within(weekRow).getAllByText('—').at(-1)).toHaveClass('text-xs'); // the agora cell; the empty consequence select shows — too

  expect(screen.getByLabelText('por hora')).toHaveAttribute('placeholder', 'sem limite');
  expect(screen.getByText(t('usage.raw', { hour: fmt(100), day: fmt(100) }))).toBeInTheDocument();
});

const authResponse = (status: unknown) => jsonResponse(status);

test('entrar com GitHub switches to api mode: nothing is listed until a token exists, connect starts the device flow and shows the code, and usar gh CLI brings back entrar com GitHub (#524)', async () => {
  const user = userEvent.setup();
  let auth: unknown = { connected: false };
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/settings/github/auth') return authResponse(auth);
    if (url === '/settings/github/login') { auth = { connected: false, pending: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' } }; return jsonResponse({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 }); }
    if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }]);
    if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
    return jsonResponse({});
  });
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'flow');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));

  await user.click(screen.getByRole('button', { name: t('settings.connections.signIn') }));

  expect(await screen.findByText(`${t('settings.auth.disconnected')} · ${t('settings.connections.usedBy', { sources: 'board' })}`)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: t('settings.auth.connect') }));

  expect(fetchMock).toHaveBeenCalledWith('/settings/github/login', expect.objectContaining({ method: 'POST' }));
  expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
  expect(screen.getByText(/github\.com\/login\/device/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: t('settings.sources.editSource', { source: 'board' }) }));
  expect(screen.getByLabelText(t('settings.project'))).toBeDisabled();
  expect(screen.getByRole('button', { name: t('settings.load') })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: t('settings.sources') }));
  await user.click(screen.getByRole('button', { name: t('settings.connections.useCli') }));
  expect(screen.getByRole('button', { name: t('settings.connections.signIn') })).toBeInTheDocument();
});

test('a connected account shows as @login with a reconnect button, and the transport rides on the projects and columns urls', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/settings/github/auth') return authResponse({ connected: true, login: 'ana' });
    if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }]);
    if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
    return jsonResponse({});
  });
  render(<Settings info={{ ...info, config: { ...info.config!, auth: { github: 'api' } } }} onSaved={vi.fn()} />);
  await open(user, 'flow');

  expect(await screen.findByText('conectado como @ana · usado por board')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.auth.reconnect') })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: t('settings.sources.editSource', { source: 'board' }) }));
  expect(screen.getByLabelText(t('settings.project'))).not.toBeDisabled();

  await user.click(screen.getByRole('button', { name: t('settings.load') }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/projects?owner=acme&auth=api'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=api'));
});

test('the general tab carries the branch field, seeded from the saved config, with the placeholder list under it', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'execution');
  expect(screen.getByLabelText(t('settings.branch'))).toHaveValue('');
  expect(screen.getByText('{slug}')).toBeInTheDocument();
  unmount();

  render(<Settings info={{ ...info, config: { ...info.config!, branch: 'feat/{id}-{title}' } }} onSaved={vi.fn()} />);
  await open(user, 'execution');
  expect(screen.getByLabelText(t('settings.branch'))).toHaveValue('feat/{id}-{title}');
});

test('saving a template that two tasks would share shows the error on the general tab and sends nothing', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'execution');
  await user.type(screen.getByLabelText(t('settings.branch')), 'feat/{title}');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.branch.unique'))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  expect(onSaved).not.toHaveBeenCalled();
});

test('the base branch field shows the saved value and the edited one reaches POST /settings, trimmed (#119)', async () => {
  const user = userEvent.setup();
  render(<Settings info={{ ...info, config: { ...info.config!, baseBranch: 'develop' } }} onSaved={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));

  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.baseBranch'));
  expect(field).toHaveValue('develop');
  expect(field).toHaveAttribute('placeholder', t('settings.baseBranch.auto'));
  await user.clear(field);
  await user.type(field, ' release ');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/settings', expect.objectContaining({ method: 'POST' })));
  const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)) as { baseBranch: string; defaultAgent: string };
  expect(body.baseBranch).toBe('release');
  expect(body.defaultAgent).toBe('claude'); // always sent (#516)
});

test('the local source edits the prefix; removing the only source hides the GitHub fields and every stage\'s source fields, and the save sends the prefix, no source and no auth', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await open(user, 'flow');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  const prefix = screen.getByLabelText(t('settings.prefix'));
  expect(prefix).toHaveValue('HIVE');
  await user.clear(prefix);
  await user.type(prefix, 'T2');
  await user.click(screen.getByRole('button', { name: t('settings.sources.editSource', { source: 'board' }) }));
  const removeButton = screen.getByRole('button', { name: t('settings.sources.remove') });
  await user.click(removeButton);
  expect(screen.getAllByText(t('settings.sources.none'))).toHaveLength(2); // the sources card and the stage's ao começar (#266)
  expect(screen.queryByRole('heading', { level: 2, name: t('settings.connections') })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.owner'))).not.toBeInTheDocument();
  expect(screen.queryByRole('table', { name: t('settings.stages.onStart') })).not.toBeInTheDocument(); // no source, no on-start actions to set (#134, #266)
  expect(screen.getByLabelText(t('settings.stages.name'))).toHaveValue('fila');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  const body = JSON.parse(String(init?.body));
  expect([body.prefix, body.sources, 'auth' in body, body.stages]).toEqual(['T2', [], false, [{ name: 'fila', from: {} }]]);
});

test('the stage fields follow the sources list: a source added through the dialog gets its own row in sai and its own entry columns, filled by its own load (#180, #514, #515)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
    if (url.startsWith('/settings/source-columns?type=github&owner=%40me&number=2')) return jsonResponse(['todo', 'done']);
    if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
    return jsonResponse({});
  });
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'flow');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await user.click(screen.getByRole('combobox', { name: t('settings.stages.from') }));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('board · Ready');
  await user.keyboard('{Escape}');

  await user.click(screen.getByRole('button', { name: t('settings.sources.add') }));
  const dialog = within(screen.getByRole('dialog', { name: t('newSource.title') }));
  await user.click(dialog.getByRole('button', { name: t('settings.load') }));
  await user.click(dialog.getByLabelText(t('settings.project')));
  await user.click(await screen.findByRole('option', { name: '#2 Two' }));
  await user.clear(dialog.getByLabelText(t('newSource.name')));
  await user.type(dialog.getByLabelText(t('newSource.name')), 'notes');
  await user.click(dialog.getByRole('button', { name: t('newSource.add') }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=%40me&number=2&auth=cli'));
  await user.click(screen.getByRole('button', { name: t('settings.sources') }));

  const onStart = within(screen.getByRole('table', { name: t('settings.stages.onStart') }));
  expect(onStart.getByText('notes')).toBeInTheDocument();
  onStart.getByRole('button', { name: t('settings.stages.exit.addTo', { source: 'notes', when: t('settings.stages.exit.start') }) }).focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: 'mover para todo' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'mover para Ready' })).not.toBeInTheDocument();
});

test('the workspaces list opens the general tab with the saved rows, or one named after the proposed folder; add adds a row, the only row cannot be removed, a duplicate name stops the save on that tab, and every row is sent (#179)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Settings info={{ ...info, configured: false, config: undefined, proposedWorkspace: '/work/app' }} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  expect(screen.getByLabelText(`${t('settings.workspaces.name')} 1`)).toHaveValue('app');
  expect(screen.getByLabelText(`${t('settings.workspaces.path')} 1`)).toHaveValue('/work/app');
  unmount();

  render(<Settings info={info} onSaved={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'workspaces');
  expect(screen.getByLabelText(`${t('settings.workspaces.name')} 1`)).toHaveValue('hive');
  expect(screen.getByRole('button', { name: t('settings.workspaces.remove', { n: 1 }) })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.add') }));
  await user.type(screen.getByLabelText(`${t('settings.workspaces.name')} 2`), 'hive');
  await user.type(screen.getByLabelText(`${t('settings.workspaces.path')} 2`), '/site');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.workspaceDuplicate', { name: 'hive' }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.clear(screen.getByLabelText(`${t('settings.workspaces.name')} 2`));
  await user.type(screen.getByLabelText(`${t('settings.workspaces.name')} 2`), 'site');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/settings', expect.objectContaining({ method: 'POST' })));
  const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)) as { workspaces: unknown };
  expect(body.workspaces).toEqual([{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 70)' }]);
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.remove', { n: 1 }) }));
  expect(screen.getByLabelText(`${t('settings.workspaces.name')} 1`)).toHaveValue('site');
});

test('each workspace row has its worktree setup and timeout per step: the saved ones load, an edit is sent as typed, an empty field sends no key (#299, #511)', async () => {
  const user = userEvent.setup();
  const withSetup = { ...info, config: { ...info.config!, comb: { ...info.config!.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree' as const, color: 'oklch(0.72 0.12 25)', setup: 'COPY .env', setupTimeout: '10m' }] } } };
  render(<Settings info={withSetup} onSaved={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'workspaces');
  const script = screen.getByLabelText(`${t('settings.workspaces.setup')} 1`);
  const timeout = screen.getByLabelText(`${t('settings.workspaces.setup')}: ${t('settings.workspaces.stepTimeout')} 1`);
  expect(script).toHaveValue('COPY .env');
  expect(timeout).toHaveValue('10m');
  expect(screen.getByText(t('settings.workspaces.setupHelp'))).toBeInTheDocument();
  expect(screen.getAllByText(t('settings.workspaces.setupTimeoutHint'))).toHaveLength(2);
  await user.type(script, '{Enter}RUN pnpm install');
  await user.clear(timeout);
  await user.type(timeout, '7m');
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.add') }));
  await user.type(screen.getByLabelText(`${t('settings.workspaces.name')} 2`), 'site');
  await user.type(screen.getByLabelText(`${t('settings.workspaces.path')} 2`), '/site');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/settings', expect.objectContaining({ method: 'POST' })));
  const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)) as { workspaces: unknown };
  expect(body.workspaces).toEqual([{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup: 'COPY .env\nRUN pnpm install', setupTimeout: '7m' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 70)' }]);
});

test('Settings › workspaces lists the saved commands, their env folded behind a count; a new row with no name, then a variable name export cannot take, stops the save on workspaces; the commands are sent parsed (#300, #348, #511)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const front = { name: 'Run Frontend', impls: [{ workspace: 'hive', command: 'pnpm run dev -- --port $PORT' }], menu: true, env: { PORT: '5173' } };
  const saved = { ...info, config: { ...info.config!, comb: { ...info.config!.comb, commands: [front] } } };
  render(<Settings info={saved} onSaved={onSaved} />);
  await open(user, 'workspaces');
  expect(screen.getByLabelText('nome do comando 1')).toHaveValue('Run Frontend');
  await user.click(screen.getByRole('button', { name: /1 variável/ }));
  const firstEnv = within(screen.getByRole('group', { name: t('settings.commands.env', { name: 'Run Frontend' }) }));
  expect(firstEnv.getByLabelText('nome da variável 1')).toHaveValue('PORT');
  expect(firstEnv.getByLabelText('valor da variável 1')).toHaveValue('5173');
  await user.click(screen.getByRole('button', { name: '+ comando' }));
  await open(user, 'execution');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.commandName', { n: 2 }))).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('workspaces');
  await user.type(screen.getByLabelText('nome do comando 2'), 'Run API');
  await user.type(screen.getByLabelText(t('settings.commands.command', { n: 2, workspace: t('settings.commands.all') })), 'pnpm api');
  await user.click(within(screen.getByRole('group', { name: 'comando 2' })).getByRole('button', { name: '+ variável' }));
  const secondEnv = within(screen.getByRole('group', { name: t('settings.commands.env', { name: 'Run API' }) }));
  await user.type(secondEnv.getByLabelText('nome da variável 1'), 'API PORT');
  await user.type(secondEnv.getByLabelText('valor da variável 1'), '5174');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.commandEnv', { n: 2 }))).toBeInTheDocument();
  await user.clear(secondEnv.getByLabelText('nome da variável 1'));
  await user.type(secondEnv.getByLabelText('nome da variável 1'), 'API_PORT');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  const body = JSON.parse(String(init?.body)) as { workspaces: unknown; commands: unknown };
  expect(body.workspaces).toEqual([{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }]);
  expect(body.commands).toEqual([front, { name: 'Run API', impls: [{ workspace: null, command: 'pnpm api' }], menu: true, env: { API_PORT: '5174' } }]);

});

test('Choose… shows only inside the viewer, one per row, and fills that row\'s folder (and an empty name after it); a cancelled pick leaves it as it was', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  expect(screen.queryByRole('button', { name: t('settings.workspaces.choose') })).not.toBeInTheDocument();
  unmount();

  const chooseFolder = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('/picked/repo');
  vi.stubGlobal('hive', { chooseFolder });
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'workspaces');
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.choose') }));
  await waitFor(() => expect(chooseFolder).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText(`${t('settings.workspaces.path')} 1`)).toHaveValue('/repo');
  await user.click(screen.getByRole('button', { name: t('settings.workspaces.add') }));
  await user.click(screen.getAllByRole('button', { name: t('settings.workspaces.choose') })[1]);
  await waitFor(() => expect(screen.getByLabelText(`${t('settings.workspaces.path')} 2`)).toHaveValue('/picked/repo'));
  expect(screen.getByLabelText(`${t('settings.workspaces.name')} 2`)).toHaveValue('repo');
});

test('Settings › a source\'s default workspace is one of the workspaces or none, and is sent in taskProps.defaults (#179, #688)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const two = { ...info, config: { ...info.config!, comb: { ...info.config!.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree' as const, color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree' as const, color: 'oklch(0.72 0.12 25)' }] } } };
  render(<Settings info={two} onSaved={onSaved} />);
  await openSource(user, 'board');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  // Opened from the keyboard, like the rules editor's consequence select above: a pointer click on this trigger can find the
  // Select already dismissed in jsdom once an earlier test in this file has opened and closed one elsewhere.
  within(screen.getByTestId('task-defaults')).getByLabelText(t('settings.taskProps.prop.workspace')).focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([t('settings.taskProps.noWorkspace'), 'hive', 'site']);
  await user.click(screen.getByRole('option', { name: 'site' }));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).sources[0]).toEqual({ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'site', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' });
});

test('Settings › + regra adds a rule that sets workspace, sends the rules in order, and a rule without a value stops the save naming its source and its row (#293, #688)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const two = { ...info, config: { ...info.config!, comb: { ...info.config!.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree' as const, color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree' as const, color: 'oklch(0.72 0.12 25)' }] } } };
  render(<Settings info={two} onSaved={onSaved} />);
  await openSource(user, 'board');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await user.click(screen.getByRole('button', { name: t('settings.workspaceRules.add') }));
  const [rule] = screen.getAllByTestId('task-rule');
  await user.type(within(rule).getByLabelText(t('settings.workspaceRules.field')), 'title');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  // #514: a save problem opens its section's list page, naming the source; fixing the rule means opening it again.
  expect(await screen.findByText(t('settings.error.workspaceRuleBlank', { source: 'board', n: 1 }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.click(screen.getByRole('button', { name: t('settings.sources.editSource', { source: 'board' }) }));
  const [reopened] = screen.getAllByTestId('task-rule');
  await user.type(within(reopened).getByLabelText(t('settings.workspaceRules.value')), 'site');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).sources[0].taskProps).toEqual({ defaults: { workspace: 'hive', auto: true }, rules: [{ field: 'title', op: 'icontains', value: 'site', set: { workspace: 'hive' } }] });
});

test('the worktrees tab shows only once the Hive is configured, and loads GET /worktrees when it opens (#181)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/worktrees') return jsonResponse([]);
    if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }]);
    if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
    return jsonResponse({});
  });
  const { unmount } = render(<Settings info={{ ...info, configured: false }} onSaved={vi.fn()} />);
  expect(screen.queryByRole('button', { name: t('settings.section.maintenance') })).not.toBeInTheDocument();
  unmount();
  render(<Settings info={info} onSaved={vi.fn()} />);
  expect(fetchMock).not.toHaveBeenCalledWith('/worktrees');
  await open(user, 'maintenance');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/worktrees'));
  expect(await screen.findByText(t('worktrees.none'))).toBeInTheDocument();
});

test('the general tab: the close select offers menu bar and quit, and the save sends onClose; the viewer is told after the save, before onSaved (#513)', async () => {
  const user = userEvent.setup();
  const order: string[] = [];
  const settingsChanged = vi.fn(async () => { order.push('viewer'); });
  vi.stubGlobal('hive', { chooseFolder: vi.fn(), settingsChanged });
  const onSaved = vi.fn(async () => { order.push('saved'); });
  render(<Settings info={info} onSaved={onSaved} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'app');
  const select = screen.getByLabelText(t('settings.onClose'));
  await user.click(select);
  await user.click(screen.getByRole('option', { name: t('settings.onClose.quit') }));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  const body = JSON.parse(String(init?.body));
  expect(body.onClose).toEqual('quit');
  expect('menuBar' in body).toBe(false);
  expect(order).toEqual(['viewer', 'saved']);
});

test('the general tab: what deleting an activity forgets besides its worktree, branch and terminals (#236, #573); the transcripts need the sessions, so they are greyed and turned off with them; the scope reaches POST /settings', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'execution');
  const sw = (key: 'session' | 'transcripts') => screen.getByRole('switch', { name: t(`settings.deleteActivity.${key}`) });
  expect(sw('session')).not.toBeChecked();
  expect(sw('transcripts')).toBeDisabled();
  await user.click(sw('session'));
  expect(sw('transcripts')).toBeEnabled();
  await user.click(sw('transcripts'));
  await user.click(sw('session'));
  expect(sw('transcripts')).not.toBeChecked();
  await user.click(sw('session'));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).deleteActivity).toEqual({ session: true, transcripts: false, nonAutoTasks: false });
});

test('the general tab: the shutdown window (#233) shows the saved minutes, a value outside 1..1440 is refused on save, and the minutes reach POST /settings as a number', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.shutdownIdle'));
  expect(field).toHaveValue(SHUTDOWN_IDLE_DEFAULT);
  await user.clear(field);
  await user.type(field, '0');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.shutdownIdle'))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.clear(field);
  await user.type(field, '45');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).shutdownIdleMinutes).toBe(45);
});

test('the general tab: the approval window (#268) shows the saved minutes, a value outside 1..120 is refused on save, and the minutes reach POST /settings as a number', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.approvalMinutes'));
  expect(field).toHaveValue(APPROVAL_MINUTES_DEFAULT);
  await user.clear(field);
  await user.type(field, '121');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText(t('settings.error.approvalMinutes'))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.clear(field);
  await user.type(field, '30');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).approvalMinutes).toBe(30);
});

test('the theme select (#296) comes right after the language, shows the saved theme, offers Sistema, Claro, Escuro and sends the choice to POST /settings', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={{ ...info, config: { ...info.config!, theme: 'light' } }} onSaved={onSaved} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
  await open(user, 'app');
  const select = screen.getByLabelText(t('settings.theme'));
  expect(screen.getByLabelText(t('settings.language')).compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(select).toHaveTextContent('Claro');
  await user.click(select);
  await screen.findByRole('option', { name: 'Escuro' });
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Sistema', 'Claro', 'Escuro']);
  await user.click(screen.getByRole('option', { name: 'Escuro' }));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).theme).toBe('dark');
});

test('the task filter (#245): a source starts with no rule; + filtro adds one at a time, its criterion, operator and values come from the loaded options or are typed, a rule is removed, and the save sends the rules', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={info} onSaved={onSaved} />);
  await openSource(user, 'board');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/filter-options?owner=acme&number=1&auth=cli'));
  expect(screen.queryAllByTestId('filter-rule')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: t('settings.filter.add') }));
  await user.click(screen.getByRole('button', { name: t('settings.filter.add') }));
  const [first, second] = screen.getAllByTestId('filter-rule');
  // The Radix Selects are opened from the keyboard, as the default-workspace test below explains
  within(first).getByLabelText(t('settings.filter.field')).focus();
  await user.keyboard('{Enter}');
  // findAllByRole resolves on the first match, which the plain criteria alone already are; retry until the loaded Priority field joins them.
  await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    t('settings.filter.field.assignee'), t('settings.filter.field.label'), t('settings.filter.field.milestone'), t('settings.filter.field.repository'), 'Priority', t('settings.filter.field.blocked'),
  ]));
  await user.click(screen.getByRole('option', { name: t('settings.filter.field.label') }));
  within(first).getByLabelText(t('settings.filter.op')).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: t('settings.filter.op.none') }));
  await user.click(within(first).getByLabelText(t('settings.filter.values')));
  await user.click(await screen.findByRole('option', { name: 'blocked' }));
  await user.type(screen.getByPlaceholderText(t('settings.filter.typed')), 'wontfix');
  await user.click(screen.getByRole('option', { name: t('settings.filter.addValue', { value: 'wontfix' }) }));
  await user.keyboard('{Escape}');
  await user.click(within(second).getByRole('button', { name: t('settings.filter.remove') }));
  expect(screen.getAllByTestId('filter-rule')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings')!;
  expect(JSON.parse(String(init?.body)).sources[0].filter).toEqual([{ field: 'label', op: 'none', values: ['blocked', 'wontfix'] }]);
});

test('the terminal font field (#376) comes right after the theme select, shows the draft\'s font with its placeholder and hint, and typing hands it to onChange', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<AppSection draft={{ ...draftFrom(info), terminalFont: 'Meslo' }} onChange={onChange} />);
  const field = screen.getByLabelText(t('settings.terminalFont'));
  expect(screen.getByLabelText(t('settings.theme')).compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(field).toHaveValue('Meslo');
  expect(field).toHaveAttribute('placeholder', 'ex.: MesloLGS NF');
  expect(screen.getByText(t('settings.terminalFont.hint'))).toBeInTheDocument();
  await user.type(field, ' NF');
  expect(onChange).toHaveBeenLastCalledWith({ terminalFont: 'Meslo NF' });
});

test('the app section has the console lines per channel field with its bounds and hint, showing the draft\'s value; a change hands it to onChange (#353)', () => {
  const onChange = vi.fn();
  render(<AppSection draft={{ ...draftFrom(info), consoleLines: '8000' }} onChange={onChange} />);
  const field = screen.getByLabelText(t('settings.consoleLines'));
  expect(field).toHaveValue(8000);
  expect([field.getAttribute('min'), field.getAttribute('max')]).toEqual(['100', '100000']);
  expect(screen.getByText(t('settings.consoleLines.hint'))).toBeInTheDocument();
  fireEvent.change(field, { target: { value: '9000' } });
  expect(onChange).toHaveBeenLastCalledWith({ consoleLines: '9000' });
});

test('the link under the default agent takes the settings to the Flow section (#527)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} />);
  await open(user, 'execution');
  await user.click(within(screen.getByRole('main')).getByRole('button', { name: t('settings.section.flow') }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('settings.section.flow'));
});

test('a save that deletes a stage holding tasks asks first, naming how many go where; confirming sends the save (#861)', async () => {
  const user = userEvent.setup();
  const two: SettingsInfo = { ...info, config: { ...info.config!, comb: { ...info.config!.comb, stages: [{ name: 'fila', from: { board: ['Ready'] } }, { name: 'dev', from: { board: ['Doing'] } }] } } };
  const queued: Task = { item: { itemId: 'board:I1', id: '1', title: 'T', body: '', url: '', source: 'board' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  render(<Settings info={two} state={{ ...BASE_STATE, tasks: [queued] }} onSaved={vi.fn()} />);
  await open(user, 'flow');
  await user.click(screen.getByRole('button', { name: t('settings.stages.remove') }));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent(tPlural('settings.stages.deleteMoves.move', 1, { n: 1, stage: 'dev' }));
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
  await user.click(within(dialog).getByRole('button', { name: t('settings.stages.deleteMoves.confirm') }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ method: 'POST' })));
});

test('execução shows the saved Claude arguments one per line, and the save sends agentArgs with one argument per non-blank line, as typed (#924)', async () => {
  const user = userEvent.setup();
  render(<Settings info={{ ...info, config: { ...info.config!, agentArgs: { claude: ['--permission-mode', 'auto'], codex: [] } } }} onSaved={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));

  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.agentArgs', { agent: 'claude' }));
  expect(field).toHaveValue('--permission-mode\nauto');
  await user.clear(field);
  await user.type(field, '--model{Enter}{Enter}opus 4{Enter}  ');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/settings', expect.objectContaining({ method: 'POST' })));
  const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)) as { agentArgs: Record<string, string[]> };
  expect(body.agentArgs).toEqual({ claude: ['--model', 'opus 4'], codex: [] });
});

test('fluxo\'s stage model field shows the agent\'s default from the draft (#482)', async () => {
  const user = userEvent.setup();
  const config = { ...info.config!, agentModels: { claude: 'opus', codex: null }, comb: { ...info.config!.comb, stages: [{ name: 'fila', from: { board: ['Ready'] }, prompt: '/x' }] } };
  render(<Settings info={{ ...info, config }} onSaved={vi.fn()} />);
  await open(user, 'flow');
  expect(screen.getByRole('combobox', { name: t('newSession.model') })).toHaveTextContent('padrão · opus');
  // the execução half (editing the model there redraws fluxo before the save) lands with the agentes card, Task 7
});
