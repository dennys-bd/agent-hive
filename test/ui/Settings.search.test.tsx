import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { SectionContent, settingsEntries } from '@/components/settings/SectionContent';
import { setLanguage, t } from '@/i18n';
import { draftFrom, type SettingsDraft } from '@/lib/settings-form';
import { type SettingEntry, settingAnchor, textIn } from '@/lib/settings-search';
import { SETTINGS_SECTIONS, type SettingsView } from '@/lib/settings-sections';
import type { SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: { remote: 'upstream', pr: 'fork', sync: 'local' }, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [{ name: 'board', qualifyId: true, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' }], transitions: [], stages: [{ name: 'fila', from: { board: ['Ready'] } }, { name: 'review', from: {}, prompt: '/x' }], commands: [] },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true }, budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
  if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
  if (url === '/worktrees') return jsonResponse([]);
  if (url === '/settings/editor/installs') return jsonResponse({ servers: {}, syntaxes: {} });
  if (url === '/settings/formatters' || url.includes('/checkers')) return jsonResponse([]);
  return jsonResponse({});
});

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

function Page({ draft, view }: { draft: SettingsDraft; view: SettingsView }) {
  const flow = {
    options: {}, githubProjects: {}, filterOptions: {}, stage: view.stage === undefined ? undefined : { id: view.stage, n: 1 },
    onConnectGithub: vi.fn(), onLoadProjects: vi.fn(), onLoadColumns: vi.fn(), onOpenSource: vi.fn(), onAddSource: vi.fn(), onOpenRules: vi.fn(),
  };
  return (
    <SectionContent
      section={view.section} draft={draft} info={info} language={view.language} source={draft.sources.find((s) => s.id === view.source)}
      flow={flow} onLanguage={vi.fn()} onChange={vi.fn()} onCapSaved={vi.fn()}
    />
  );
}

const byView = (entries: readonly SettingEntry[]): Map<string, SettingEntry[]> =>
  entries.reduce((map, e) => map.set(JSON.stringify(e.view), [...(map.get(JSON.stringify(e.view)) ?? []), e]), new Map<string, SettingEntry[]>());

test('every entry lands on an element once its view is open: a workspace, a source, a stage and a language included (#689)', () => {
  const draft = draftFrom(info);
  const entries = settingsEntries(draft, SETTINGS_SECTIONS);
  expect(new Set(entries.map((e) => e.view.section))).toEqual(new Set(SETTINGS_SECTIONS));
  for (const key of ['source', 'stage', 'language'] as const) expect(entries.some((e) => e.view[key] !== undefined), key).toBe(true);
  for (const [view, list] of byView(entries)) {
    const { unmount } = render(<Page draft={draft} view={JSON.parse(view) as SettingsView} />);
    for (const entry of list) expect(document.getElementById(entry.anchor), `${view}: ${textIn(entry.label, 'en')}`).not.toBeNull();
    unmount();
  }
}, 30_000); // renders every view of the index: slow under the parallel gate

const search = () => screen.getByRole('combobox', { name: t('settings.search') });
const pickFirst = async (user: UserEvent, query: string) => { await user.type(search(), query); await user.keyboard('{Enter}'); };

test('a pick opens its view, scrolls it smoothly, focuses its control without a second scroll and outlines it for 2s (#689)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  onTestFinished(() => { vi.useRealTimers(); });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const scrolled = vi.spyOn(Element.prototype, 'scrollTo');
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await pickFirst(user, 'tema');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('app');
  await vi.advanceTimersByTimeAsync(20); // the landing frame
  expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  const block = document.getElementById(settingAnchor('settings.theme'));
  expect(screen.getByLabelText(t('settings.theme'))).toHaveFocus();
  expect(block).toHaveClass('setting-highlight');
  await vi.advanceTimersByTimeAsync(2000);
  expect(block).not.toHaveClass('setting-highlight');
  await pickFirst(user, 'formatar ao salvar');
  await vi.advanceTimersByTimeAsync(20);
  expect(screen.getByRole('switch', { name: 'formatar ao salvar' })).toHaveFocus(); // the control before its label
});

test('a source\'s and a stage\'s entries open that context (#689)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await pickFirst(user, 'board');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('board');
  await pickFirst(user, 'review');
  await waitFor(() => expect(screen.getByLabelText(t('settings.stages.name'))).toHaveValue('review'));
});

test('⌘F focuses the search and selects its text; Esc twice never leaves Settings (#689)', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={onCancel} />);
  await user.type(search(), 'tema');
  await user.click(screen.getByRole('heading', { level: 1 }));
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true }); // jsdom is not macOS
  expect(search()).toHaveFocus();
  expect([(search() as HTMLInputElement).selectionStart, (search() as HTMLInputElement).selectionEnd]).toEqual([0, 4]);
  await user.keyboard('{Escape}{Escape}');
  expect(search()).not.toHaveFocus();
  expect(onCancel).not.toHaveBeenCalled();
});

test('what the nav search found before is still found, now as settings (#510, #689)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  for (const query of ['idioma', 'notificações', 'aprovação', 'prefixo', 'conexões', 'medida', 'ícones de arquivo', 'laterais por visão', 'formatar', 'sintaxe', 'em cada workspace', 'no menu', 'sinal', 'órfãs', 'pyright', 'ambiente', 'agente padrão', 'comandos']) {
    await user.clear(search());
    await user.type(search(), query);
    expect(screen.queryAllByRole('option').length, query).toBeGreaterThan(0);
  }
}, 30_000);
