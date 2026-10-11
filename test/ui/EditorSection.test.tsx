import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t } from '@/i18n';
import type { EditorConfig, EditorInstalls, InstallState, SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SERVER_IDS, SHUTDOWN_IDLE_DEFAULT, SYNTAX_IDS } from '../../src/types';
import { jsonResponse } from '../fakes';

// Settings › editor (#780): the format on save card over the one editor config, and what a save sends
const SAVED: EditorConfig = { ...EDITOR_DEFAULTS, languages: { python: { formatters: { ruff: { enabled: false, args: [], workspaces: 'all' } } } } };
const editorInfo = (editor: EditorConfig = SAVED): SettingsInfo => ({
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', sources: [], transitions: [], stages: [{ name: 'fila', from: {} }], commands: [], workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null }, { name: 'web', path: '/web', env: {}, fork: null }] },
    logLevel: 'info', claudeArgs: [], budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS,
    editor,
  },
});
const ABSENT: InstallState = { state: 'absent' };
const INSTALLS = {
  servers: { ...Object.fromEntries(SERVER_IDS.map((id) => [id, ABSENT])), pyright: { state: 'installed', version: '1.2.3' }, gopls: { state: 'requires', tool: 'go' } },
  syntaxes: Object.fromEntries(SYNTAX_IDS.map((id) => [id, ABSENT])),
} as EditorInstalls;
const STATES = [{ id: 'ruff', found: ['hive'] }, { id: 'black', found: [] }];
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url === '/settings/editor/installs') return jsonResponse(INSTALLS);
  if (url === '/settings/formatters') return jsonResponse(STATES);
  return jsonResponse({});
});

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const openEditor = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  const nav = within(screen.getByRole('navigation', { name: t('settings.nav') }));
  await user.click(nav.getByRole('button', { name: t('settings.section.editor') }));
};

test('the format on save switch reads the saved config, and the saved body carries the editor config with it turned off (#780)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={editorInfo()} onSaved={onSaved} />);
  await openEditor(user);
  const toggle = screen.getByRole('switch', { name: 'formatar ao salvar' });
  expect(toggle).toBeChecked();
  expect(screen.getByText(t('settings.format.onSaveHint'))).toBeInTheDocument();
  await user.click(toggle);
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings') ?? [];
  const body = JSON.parse(String(init?.body)) as { editor: EditorConfig; workspaces: object[] };
  expect(body.editor).toEqual({ ...SAVED, formatOnSave: { enabled: false, workspaces: 'all' } });
  expect(body.workspaces.every((w) => !('format' in w))).toBe(true);
});

test('a saved scope naming a workspace the form removed stops the save on editor, naming it (#780)', async () => {
  const user = userEvent.setup();
  render(<Settings info={editorInfo({ ...EDITOR_DEFAULTS, formatOnSave: { enabled: true, workspaces: ['ghost'] } })} onSaved={vi.fn()} />);
  await openEditor(user);
  await user.click(screen.getByRole('switch', { name: 'formatar ao salvar' }));
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  expect(await screen.findByText('formatar ao salvar: o workspace ghost não está mais em workspaces')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
});

test('the card renders in English and in Portuguese (#780)', async () => {
  for (const [language, label] of [['en', 'format on save'], ['pt', 'formatar ao salvar']] as const) {
    setLanguage(language);
    const user = userEvent.setup();
    const { unmount } = render(<Settings info={editorInfo()} onSaved={vi.fn()} />);
    await openEditor(user);
    expect(screen.getByRole('switch', { name: label })).toBeInTheDocument();
    unmount();
  }
});
test('format on save\'s chips set its workspaces; a list goes into the body (#780)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={editorInfo()} onSaved={onSaved} />);
  await openEditor(user);
  await user.click(screen.getByRole('button', { name: 'workspaces de formatar ao salvar' }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'web' }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings') ?? [];
  expect((JSON.parse(String(init?.body)) as { editor: EditorConfig }).editor.formatOnSave).toEqual({ enabled: true, workspaces: ['hive'] });
});

const firstLines = (list: ReturnType<typeof within>): (string | null | undefined)[] => list.getAllByRole('option').map((o: HTMLElement) => o.firstChild?.firstChild?.textContent);

test('the list filters by name, extension and server, accents aside; the toggle narrows to installed and attention; a row summarises and flags (#780)', async () => {
  const user = userEvent.setup();
  render(<Settings info={editorInfo()} onSaved={vi.fn()} />);
  await openEditor(user);
  const list = within(screen.getByRole('listbox', { name: 'linguagens' }));
  expect(await list.findByText('pyright · ruff')).toBeInTheDocument();
  expect(within(list.getByRole('option', { name: /^Go/ })).getByText('requer go')).toBeInTheDocument();
  const filter = screen.getByRole('searchbox', { name: 'filtrar linguagens' });
  await user.type(filter, '.rs');
  expect(firstLines(list)).toEqual(['Rust']);
  await user.clear(filter);
  await user.type(filter, 'PYRÍGHT');
  expect(firstLines(list)).toEqual(['Python']);
  await user.clear(filter);
  await user.click(screen.getByRole('radio', { name: 'atenção · 1' }));
  expect(firstLines(list)).toEqual(['Go']);
  await user.click(screen.getByRole('radio', { name: 'instaladas' }));
  expect(firstLines(list)).toContain('Python');
  expect(firstLines(list)).not.toContain('Go');
});

test('a language\'s detail: syntax, server with its chips and install actions, formatters in try order with their detection (#780)', async () => {
  const user = userEvent.setup();
  render(<Settings info={editorInfo()} onSaved={vi.fn()} />);
  await openEditor(user);
  await user.click(screen.getByRole('option', { name: /^Python/ }));
  const detail = within(screen.getByRole('region', { name: 'Python' }));
  expect(detail.getByText('vscode.python')).toBeInTheDocument();
  expect(await detail.findByText('instalado · v1.2.3')).toBeInTheDocument();
  // ruff is a formatter and a checker of Python (#782): the formatters' card comes first, the checkers' after
  expect(detail.getAllByRole('group').map((g) => g.getAttribute('aria-label')).slice(0, 2)).toEqual(['ruff', 'black']);
  expect(await within(detail.getAllByRole('group', { name: 'ruff' })[0]).findByText('encontrado em hive')).toHaveClass('text-working');
  expect(within(detail.getByRole('group', { name: 'black' })).getByText('não encontrado')).toBeInTheDocument();
  await user.click(detail.getByRole('button', { name: 'remover' }));
  expect(fetchMock).toHaveBeenCalledWith('/settings/editor/installs/server/pyright', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'remove' }) }));
  await user.click(detail.getByRole('button', { name: '+ formatador personalizado' }));
  expect(detail.getAllByRole('group').map((g) => g.getAttribute('aria-label')).slice(0, 3)).toEqual(['formatador personalizado 1', 'ruff', 'black']);
  expect(detail.getByLabelText('extensões do formatador personalizado 1')).toHaveValue('.py, .pyi');
});

test('a server\'s chips and a formatter\'s switch and args go into the body as the editor config, a formatter back on its default left out (#780)', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<Settings info={editorInfo()} onSaved={onSaved} />);
  await openEditor(user);
  await user.click(screen.getByRole('option', { name: /^Python/ }));
  const detail = within(screen.getByRole('region', { name: 'Python' }));
  await user.click(detail.getByRole('button', { name: 'workspaces de pyright' }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'todos os workspaces' }));
  await user.keyboard('{Escape}');
  expect(await detail.findByText('desligado em todos')).toBeInTheDocument();
  await user.click(detail.getAllByRole('switch', { name: 'usar ruff' })[0]); // the formatter's (the checker's follows it); SAVED has it off: back on its default
  await user.type(detail.getByLabelText('argumentos extras de black'), '-l{Enter}99');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/settings') ?? [];
  expect((JSON.parse(String(init?.body)) as { editor: EditorConfig }).editor.languages.python).toEqual({
    server: { workspaces: [] },
    formatters: { black: { enabled: true, args: ['-l', '99'], workspaces: 'all' } },
  });
});

test('a pick in the Settings search opens editor on that language (#780)', async () => {
  const user = userEvent.setup();
  render(<Settings info={editorInfo()} onSaved={vi.fn()} />);
  await user.type(screen.getByRole('searchbox', { name: t('settings.search') }), 'pyright');
  await user.click(within(screen.getByRole('group', { name: 'linguagens encontradas' })).getByRole('button', { name: /pyright/ }));
  expect(screen.getByRole('region', { name: 'Python' })).toBeInTheDocument();
});

test('the editor bar\'s instalar opens Settings on editor with that language selected, the list filter clear (#780)', async () => {
  render(<Settings info={editorInfo()} view={{ section: 'editor', language: 'go' }} onSaved={vi.fn()} />);
  expect(screen.getByRole('region', { name: 'Go' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^Go/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('searchbox', { name: 'filtrar linguagens' })).toHaveValue('');
});

test('a pick in the search while a filter hides the language clears the filter and selects it (#780)', async () => {
  const user = userEvent.setup();
  render(<Settings info={editorInfo()} onSaved={vi.fn()} />);
  await openEditor(user);
  await user.type(screen.getByRole('searchbox', { name: 'filtrar linguagens' }), '.rs');
  await user.type(screen.getByRole('searchbox', { name: t('settings.search') }), 'pyright');
  await user.click(within(screen.getByRole('group', { name: 'linguagens encontradas' })).getByRole('button', { name: /pyright/ }));
  expect(screen.getByRole('searchbox', { name: 'filtrar linguagens' })).toHaveValue('');
  expect(screen.getByRole('option', { name: /^Python/ })).toHaveAttribute('aria-selected', 'true');
});
