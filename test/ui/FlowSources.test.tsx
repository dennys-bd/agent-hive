import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import { newSourceDraft } from '@/lib/flow-sources';
import type { SettingsSection } from '@/lib/settings-sections';
import type { SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));
const openSource = async (user: UserEvent, name: string): Promise<void> => {
  await open(user, 'flow');
  await user.click(screen.getByRole('button', { name: t('settings.sources.editSource', { source: name }) }));
};


const CORE_RULES = [
  { field: 'labels', op: 'icontains' as const, value: 'api', set: { workspace: 'hive' } },
  { field: 'title', op: 'icontains' as const, value: 'bug', set: { workspace: 'hive' } },
];

const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: {
      prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }],
      sources: [
        { name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' },
        { name: 'core', qualifyId: false, type: 'github', owner: 'acme', number: 2, filter: [{ field: 'assignee', op: 'any', values: ['@me'] }], taskProps: { defaults: { auto: true }, rules: CORE_RULES }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' },
      ],
      transitions: [],
      stages: [{ name: 'fila', from: { board: ['Ready'], core: ['Ready'] } }], commands: [],
    },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS,
  },
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const defaultFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
  if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
  return jsonResponse({});
};
const fetchMock = vi.fn(defaultFetch);

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); fetchMock.mockImplementation(defaultFetch); });
afterEach(() => vi.unstubAllGlobals());

const settled = () => waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));

test('sources lists one row per source with its badge and summary (#514)', async () => {
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await open(userEvent.setup(), 'flow');
  await settled();

  expect(screen.getByRole('heading', { level: 2, name: t('settings.sources') })).toBeInTheDocument();
  expect(screen.getByText(t('settings.sources.hint'))).toBeInTheDocument();

  const rows = screen.getAllByTestId('source-row');
  expect(rows).toHaveLength(2);
  await waitFor(() => expect(within(rows[0]).getByText(/#1 One/)).toBeInTheDocument());
  expect(within(rows[0]).getByText('board')).toBeInTheDocument();
  expect(within(rows[0]).getByText('GitHub Project')).toBeInTheDocument();
  expect(within(rows[0]).getByText(`#1 One · ${t('settings.sources.noFilter')} · ${t('settings.sources.prop.fixed', { prop: 'workspace', value: 'hive' })} · ${t('settings.sources.prop.fixed', { prop: 'auto', value: t('settings.taskProps.yes') })}`)).toBeInTheDocument();
  await waitFor(() => expect(within(rows[1]).getByText(/#2 Two/)).toBeInTheDocument());
  expect(within(rows[1]).getByText(new RegExp(`^#2 Two · filtro: .+ · ${t('settings.sources.prop.other', { prop: 'workspace', n: 2 })} · ${t('settings.sources.prop.fixed', { prop: 'auto', value: t('settings.taskProps.yes') })}$`))).toBeInTheDocument();

  const edit = within(rows[0]).getByText(t('settings.sources.edit'));
  expect(edit).toHaveAccessibleName(t('settings.sources.editSource', { source: 'board' }));

  const order = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(order.indexOf(t('settings.sources'))).toBeLessThan(order.indexOf(t('settings.connections')));
  expect(order.indexOf(t('settings.connections'))).toBeLessThan(order.indexOf(t('settings.stages')));

  // #513/#524: the group hint sits beside its h2, as a sibling span, not stacked under it.
  const sourcesHeading = screen.getByRole('heading', { level: 2, name: t('settings.sources') });
  const sourcesHint = screen.getByText(t('settings.sources.hint'));
  expect(sourcesHint.tagName).toBe('SPAN');
  expect(sourcesHint.parentElement).toBe(sourcesHeading.parentElement);
});

test('sources starts with the local row: Hive badge, the prefix field, its ids and sempre ativa (#524)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await open(user, 'flow');
  await settled();

  const prefix = screen.getByLabelText(t('settings.prefix'));
  expect(prefix).toHaveValue('HIVE');
  const local = screen.getByTestId('local-row');
  expect(within(local).getByText(t('settings.sources.type.local'))).toBeInTheDocument();
  expect(within(local).getByText(t('settings.sources.local.ids', { prefix: 'HIVE' }))).toBeInTheDocument();
  expect(within(local).getByRole('switch', { name: t('settings.sources.local.switch') })).toBeChecked();

  await user.clear(prefix);
  await user.type(prefix, 'HV');
  expect(within(local).getByText(t('settings.sources.local.ids', { prefix: 'HV' }))).toBeInTheDocument();

  expect(screen.getAllByTestId('source-row')).toHaveLength(2);
  expect(screen.getByRole('button', { name: '+ source' })).toBeInTheDocument();
});

test('conexões lists GitHub through the gh CLI, used by the github sources, and + conexão is disabled (#524)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await open(user, 'flow');
  await settled();

  expect(screen.getByRole('heading', { level: 2, name: t('settings.connections') })).toBeInTheDocument();
  expect(screen.getByText(t('settings.connections.hint'))).toBeInTheDocument();

  const row = screen.getByTestId('connection-row');
  expect(within(row).getByText(t('settings.auth.cli'))).toBeInTheDocument();
  // one grid row, as in the mock: name, badge + one status line, the action on the right
  expect(row.children).toHaveLength(3);
  expect(within(row).getByText(`${t('settings.connections.detected')} · ${t('settings.connections.usedBy', { sources: 'board, core' })}`)).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: t('settings.connections.signIn') })).toBeEnabled();

  expect(screen.getByRole('button', { name: t('settings.connections.add') })).toBeDisabled();
  expect(screen.queryByLabelText(t('settings.epics'))).not.toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: t('settings.auth.api') })).not.toBeInTheDocument();
});

test('the GitHub row ends on a quota em regras link that opens regras (#524)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await open(user, 'flow');
  await settled();

  await user.click(within(screen.getByTestId('connection-row')).getByRole('button', { name: 'quota em regras' }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('settings.section.rules'));
});

test('editar opens the detail with a breadcrumb; the edit survives going back and switching sections (#514)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();

  await openSource(user, 'core');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('core');
  const nav = screen.getByRole('navigation', { name: t('settings.source.crumb') });
  expect(within(nav).getByRole('button', { name: t('settings.section.flow') })).toBeInTheDocument();
  expect(within(nav).getByRole('button', { name: t('settings.sources') })).toBeInTheDocument();
  expect(within(nav).getByText('core')).toBeInTheDocument();
  const settingsNav = screen.getByRole('navigation', { name: t('settings.nav') });
  expect(within(settingsNav).getByRole('button', { name: 'fluxo' })).toHaveAttribute('aria-current', 'page');

  await user.type(screen.getByLabelText(t('settings.sources.name')), 'x');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('corex');

  await user.click(within(nav).getByRole('button', { name: t('settings.sources') }));
  expect(screen.getByRole('button', { name: t('settings.sources.editSource', { source: 'corex' }) })).toBeInTheDocument(); // the sources list; sai names it too (#515)
  expect(screen.getByText(t('settings.unsaved.one', { sections: 'fluxo' }))).toBeInTheDocument();

  await open(user, 'app');
  await open(user, 'flow');
  expect(screen.getByRole('button', { name: t('settings.sources.editSource', { source: 'corex' }) })).toBeInTheDocument(); // the sources list; sai names it too (#515)
});

test('+ source adds through the dialog and opens the new source, unsaved (#514)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await open(user, 'flow');
  await settled();

  await user.click(screen.getByRole('button', { name: t('settings.sources.add') }));
  const dialog = within(screen.getByRole('dialog', { name: t('newSource.title') }));
  await user.click(dialog.getByRole('button', { name: t('settings.load') }));
  await user.click(dialog.getByLabelText(t('settings.project')));
  await user.click(await screen.findByRole('option', { name: '#2 Two' }));
  await user.clear(dialog.getByLabelText(t('newSource.name')));
  await user.type(dialog.getByLabelText(t('newSource.name')), 'notes');
  await user.click(dialog.getByRole('button', { name: t('newSource.add') }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('notes');
  expect(screen.getByLabelText(t('settings.project'))).toHaveTextContent('#2 Two');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=%40me&number=2&auth=cli'));
  expect(screen.getByText(t('settings.unsaved.one', { sections: 'fluxo' }))).toBeInTheDocument();

  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('settings.error.sourceSilent', { source: 'notes' }));
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
});

test('remover source on the detail drops it and returns to the list (#514)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();

  await openSource(user, 'core');
  await user.click(screen.getByRole('button', { name: t('settings.sources.remove') }));

  expect(screen.getAllByTestId('source-row')).toHaveLength(1);
  expect(screen.getByText(t('settings.unsaved.one', { sections: 'fluxo' }))).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: t('settings.cancel') }));
  await user.click(screen.getByRole('button', { name: t('settings.discard.confirm') }));

  expect(screen.getAllByTestId('source-row')).toHaveLength(2);
});

test('opened with newSource (from the header), the page starts on that source (#514)', async () => {
  const newSource = { source: newSourceDraft({ owner: 'acme', number: '2', name: 'extra', workspace: 'hive' }), projects: [{ number: 2, title: 'Two', url: '' }] };
  render(<Settings info={info} newSource={newSource} onSaved={vi.fn()} onCancel={vi.fn()} />);

  const nav = screen.getByRole('navigation', { name: t('settings.nav') });
  expect(within(nav).getByRole('button', { name: 'fluxo' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('extra');
  expect(screen.getByText(t('settings.unsaved.one', { sections: 'fluxo' }))).toBeInTheDocument();
});
