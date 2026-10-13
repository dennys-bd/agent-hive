import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SectionContent, settingsEntries } from '@/components/settings/SectionContent';
import { setLanguage } from '@/i18n';
import { draftFrom, type SettingsDraft } from '@/lib/settings-form';
import { type SettingEntry, textIn } from '@/lib/settings-search';
import { SETTINGS_SECTIONS, type SettingsView } from '@/lib/settings-sections';
import type { SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: { remote: 'upstream', pr: 'fork', sync: 'local' }, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }], sources: [{ name: 'board', qualifyId: true, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' }], transitions: [], stages: [{ name: 'fila', from: { board: ['Ready'] } }, { name: 'review', from: {}, prompt: '/x' }], commands: [] },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS,
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
