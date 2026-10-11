import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import type { SettingsSection } from '@/lib/settings-sections';
import { WINDOW_CHROME } from '@/lib/window-chrome';
import type { SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';


const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null }], sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] } }], transitions: [], stages: [{ name: 'fila', from: { board: ['Ready'] } }], commands: [] },
    epics: 'ignore', logLevel: 'info', claudeArgs: [], budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS,
  },
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
  if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
  if (url === '/worktrees') return jsonResponse([]);
  return jsonResponse({});
});

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const settled = () => waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/source-columns?type=github&owner=acme&number=1&auth=cli'));
const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));
const h1 = () => screen.getByRole('heading', { level: 1 });

test('the nav\'s order, the current item and the pinned maintenance item (#510)', async () => {
  const { unmount } = render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  const nav = screen.getByRole('navigation', { name: t('settings.nav') });
  const buttons = within(nav).getAllByRole('button');
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['workspaces', 'fluxo', 'execução', 'regras', 'app', 'editor', 'atalhos', 'manutenção']);
  expect(within(nav).getByRole('button', { name: 'fluxo' })).toHaveAccessibleDescription(t('settings.section.flow.hint'));
  expect(within(nav).getByRole('button', { name: 'execução' })).toHaveAccessibleDescription('agente, branches, excluir atividade'); // #516
  expect(within(nav).getByRole('button', { name: 'workspaces' })).toHaveAttribute('aria-current', 'page');
  expect(h1()).toHaveTextContent('workspaces');
  expect(screen.getByText(t('settings.section.workspaces.description'))).toBeInTheDocument();
  expect(buttons.at(-1)).toBe(within(nav).getByRole('button', { name: 'manutenção' }));
  unmount();

  render(<Settings info={{ ...info, configured: false }} onSaved={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'manutenção' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: t('settings.back') })).not.toBeInTheDocument();
});

test('every setting reachable before is in its section, and only there (#510)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();

  await open(user, 'workspaces');
  expect(screen.getByLabelText(`${t('settings.workspaces.name')} 1`)).toBeInTheDocument();
  expect(screen.getByLabelText(`${t('settings.workspaces.setup')} 1`)).toBeInTheDocument();
  expect(screen.getByLabelText(`${t('settings.workspaces.setup')}: ${t('settings.workspaces.stepTimeout')} 1`)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.commands.add') })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: t('settings.workspaceEnv', { workspace: 'hive' }) })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'hive' })).toBeInTheDocument();

  await open(user, 'flow');
  expect(screen.getByLabelText(t('settings.prefix'))).toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.epics'))).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.connections.signIn') })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.sources.add') })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: t('settings.sources') })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: t('settings.connections') })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 2, name: 'Comb' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: t('settings.stages') })).toBeInTheDocument();

  await open(user, 'execution');
  expect(screen.getByLabelText(t('settings.branch'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.baseBranch'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.approvalMinutes'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.shutdownIdle'))).toBeInTheDocument();
  for (const key of ['session', 'transcripts', 'nonAutoTasks'] as const) {
    expect(screen.getByRole('switch', { name: t(`settings.deleteActivity.${key}`) })).toBeInTheDocument();
  }

  await open(user, 'rules');
  expect(screen.getByLabelText(t('settings.budgetHour'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.budgetDay'))).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: t('settings.showGithubQuota') })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '+ regra' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: t('settings.group.budget') })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: t('settings.group.github') })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: t('settings.group.rules') })).toHaveTextContent('regras de uso'); // #526
  expect(screen.getByText(t('settings.group.rules.hint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.section.rules.description'))).toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.consoleLines'))).not.toBeInTheDocument();

  await open(user, 'app');
  expect(screen.getByLabelText(t('settings.language'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.theme'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.terminalFont'))).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: t('settings.trustedDomains.add') })).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.consoleLines'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.onClose'))).toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.branch'))).not.toBeInTheDocument();

  await open(user, 'shortcuts');
  expect(screen.getByText(t('shortcuts.toggleRight'))).toBeInTheDocument();

  fetchMock.mockClear();
  await open(user, 'maintenance');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/worktrees'));
  expect(screen.queryByRole('button', { name: t('settings.save') })).not.toBeInTheDocument();
});

test('the footer counts the unsaved changes by section, and an edit survives a section switch (#510)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();

  expect(screen.getByRole('button', { name: t('settings.save') })).toBeDisabled();
  expect(screen.getByRole('button', { name: t('settings.cancel') })).toBeDisabled();
  expect(screen.queryByText(/não salva/)).not.toBeInTheDocument();

  await open(user, 'execution');
  await user.type(screen.getByLabelText(t('settings.branch')), 'x');
  expect(screen.getByText(t('settings.unsaved.one', { sections: 'execução' }))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.save') })).toBeEnabled();
  expect(screen.getByRole('button', { name: t('settings.cancel') })).toBeEnabled();

  await open(user, 'app');
  await user.click(screen.getByLabelText(t('settings.onClose')));
  await user.click(screen.getByRole('option', { name: t('settings.onClose.quit') }));
  expect(screen.getByText(t('settings.unsaved.other', { n: 2, sections: 'execução, app' }))).toBeInTheDocument();

  await open(user, 'execution');
  expect(screen.getByLabelText(t('settings.branch'))).toHaveValue('x');
});

test('cancelar asks, then reverts every section and stays on the page (#510)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();

  await open(user, 'execution');
  await user.type(screen.getByLabelText(t('settings.branch')), 'x');
  await user.click(screen.getByRole('button', { name: t('settings.cancel') }));
  const confirm = screen.getByRole('alertdialog');
  expect(within(confirm).getByText(t('settings.discard.message'))).toBeInTheDocument();

  await user.click(within(confirm).getByRole('button', { name: t('settings.discard.confirm') }));

  expect(screen.getByLabelText(t('settings.branch'))).toHaveValue('');
  expect(screen.getByRole('button', { name: t('settings.save') })).toBeDisabled();
  expect(screen.getByRole('button', { name: t('settings.cancel') })).toBeDisabled();
  expect(h1()).toHaveTextContent('execução');
});

test('← source and Esc leave at once without changes and ask with them (#294, #510)', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={onCancel} />);
  await settled();

  await user.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledTimes(1);
  onCancel.mockClear();

  await open(user, 'execution');
  await user.type(screen.getByLabelText(t('settings.branch')), 'x');
  await user.keyboard('{Escape}');
  const firstConfirm = screen.getByRole('alertdialog');
  await user.click(within(firstConfirm).getByRole('button', { name: t('settings.cancel') }));
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole('navigation')).toBeInTheDocument();

  await user.keyboard('{Escape}');
  const secondConfirm = screen.getByRole('alertdialog');
  await user.click(within(secondConfirm).getByRole('button', { name: t('settings.discard.confirm') }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  onCancel.mockClear();

  await user.type(screen.getByLabelText(t('settings.branch')), 'x');
  await user.click(screen.getByRole('button', { name: t('settings.back') }));
  expect(onCancel).not.toHaveBeenCalled();
  const confirm = screen.getByRole('alertdialog');
  await user.click(within(confirm).getByRole('button', { name: t('settings.discard.confirm') }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  onCancel.mockClear();

  await open(user, 'app');
  await user.click(screen.getByLabelText(t('settings.theme')));
  await screen.findByRole('option', { name: t('settings.theme.dark') });
  await user.keyboard('{Escape}');
  expect(onCancel).not.toHaveBeenCalled();
});

test('the search filters the nav, ignoring accents (#510)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  const nav = screen.getByRole('navigation', { name: t('settings.nav') });

  await user.type(screen.getByRole('searchbox', { name: t('settings.search') }), 'execucao');
  expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['execução']);
  expect(h1()).toHaveTextContent('workspaces');

  await user.clear(screen.getByRole('searchbox', { name: t('settings.search') }));
  await user.type(screen.getByRole('searchbox', { name: t('settings.search') }), 'zzz');
  expect(screen.getByText(t('settings.search.none'))).toBeInTheDocument();

  await user.clear(screen.getByRole('searchbox', { name: t('settings.search') }));
  expect(within(nav).getAllByRole('button')).toHaveLength(8);
});

test('a problem on save opens its section with the message (#510)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();

  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.shutdownIdle'));
  await user.clear(field);
  await user.type(field, '0');
  await open(user, 'app');
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));

  expect(h1()).toHaveTextContent('execução');
  expect(await screen.findByRole('alert')).toHaveTextContent(t('settings.error.shutdownIdle'));
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
});

test('the first run saves an untouched prefilled draft (#294, #510)', async () => {
  const user = userEvent.setup();
  render(<Settings info={{ ...info, configured: false }} onSaved={vi.fn()} />);
  await settled();

  expect(screen.getByRole('button', { name: t('settings.save') })).toBeEnabled();
  expect(screen.queryByRole('button', { name: t('settings.back') })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

test('the header clears the macOS window buttons and drags the window, the back button still takes clicks (#583)', async () => {
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  const back = screen.getByRole('button', { name: t('settings.back') });
  expect(back.closest('header')?.className).toContain(WINDOW_CHROME);
  expect(back.className).toContain('[-webkit-app-region:no-drag]');
});

test('a save the client refuses shows its message in the footer, not under the section heading (#739)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.shutdownIdle'));
  await user.clear(field);
  await user.type(field, '0');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(t('settings.error.shutdownIdle'));
  expect(alert.closest('footer')).not.toBeNull();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

test('a rejected POST /settings shows the server message in the footer, and the next save clears it (#739)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.shutdownIdle'));
  await user.clear(field);
  await user.type(field, '45');
  let release = (): void => {};
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'workspace path is gone' }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('workspace path is gone');
  expect(alert.closest('footer')).not.toBeNull();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fetchMock.mockImplementationOnce(async () => { await gate; return jsonResponse({}); });
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  release();
});

test('a save error leaves the footer once the draft it was about changes or is reverted (#739)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.shutdownIdle'));
  await user.clear(field);
  await user.type(field, '0');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await screen.findByRole('alert');
  await user.type(field, '5');
  expect(screen.queryByRole('alert')).toBeNull();

  await user.clear(field);
  await user.type(field, '0');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: t('settings.cancel') }));
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t('settings.discard.confirm') }));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a save whose stage has approval and a terminou exit is refused on the client: fluxo opens, the footer names the transition and its editor opens, again after a click elsewhere (#918)', async () => {
  const user = userEvent.setup();
  const comb = { ...info.config!.comb, stages: [{ name: 'fila', from: { board: ['Ready'] }, prompt: '/x', approval: true as const }], transitions: [{ from: 'fila', to: 'end', when: 'done' as const }] };
  render(<Settings info={{ ...info, config: { ...info.config!, comb } }} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await settled();
  await open(user, 'execution');
  const field = screen.getByLabelText(t('settings.shutdownIdle'));
  await user.clear(field);
  await user.type(field, '45'); // a save is disabled with no change (#510)
  fetchMock.mockClear();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));

  const name = 'fila → fim · terminou';
  expect(h1()).toHaveTextContent(t('settings.section.flow'));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(t('settings.transitions.error.useApproved', { name, stage: 'fila' }));
  expect(alert.closest('footer')).not.toBeNull();
  expect(screen.getByRole('region', { name })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());

  await user.click(screen.getByRole('button', { name: /^fila/ })); // the stage's node: a selection, not an edit
  expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(screen.getByRole('region', { name })).toBeInTheDocument();
});
