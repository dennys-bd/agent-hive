import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { setLanguage, t, tPlural } from '@/i18n';
import type { Flow, SettingsBody, SettingsInfo, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const baseInfo: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' }], flows: [{ name: 'main', stages: [{ name: 'fila', from: { board: ['Ready'] } }], transitions: [] }], commands: [] },
    logLevel: 'info', agentArgs: { claude: [], codex: [] }, agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true }, budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
  },
};

const BASE_STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 0, workers: [], flows: [], stages: [], tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [], syncs: {},
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// The default handler: a few tests below call fetchMock.mockImplementation(...) for their own scenario, so beforeEach restores this one
// on every test, otherwise a later test would silently inherit whichever custom implementation ran last (#245 found this the hard way).
const defaultFetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.startsWith('/settings/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
  if (url.startsWith('/settings/source-columns')) return jsonResponse(['Ready', 'In progress']);
  return jsonResponse({});
};
const fetchMock = vi.fn(defaultFetch);

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); fetchMock.mockImplementation(defaultFetch); });
afterEach(() => vi.unstubAllGlobals());

const infoWith = (flows: Flow[]): SettingsInfo => {
  // #670: the source's entry must name a flow this file's flows have, or the form refuses the save
  const config = baseInfo.config!;
  return { ...baseInfo, config: { ...config, comb: { ...config.comb, flows, sources: config.comb.sources.map((b) => ({ ...b, switchAt: 'spec', taskProps: { ...b.taskProps, defaults: { ...b.taskProps.defaults, entry: { flow: flows[0].name } } } })) } } };
};

const FLOWS: Flow[] = [
  { name: 'feature', stages: [{ name: 'spec', from: { board: ['Ready'] } }, { name: 'build', from: {} }], transitions: [{ from: 'spec', to: 'build', when: 'done' }, { from: 'build', to: 'end', when: 'done' }] },
  { name: 'bug', stages: [{ name: 'triage', from: { board: ['Bug'] } }], transitions: [{ from: 'triage', to: 'end', when: 'done' }] },
];
// #691: feature's build leaves for bug's fix
const CROSSED: Flow[] = [
  { ...FLOWS[0], transitions: [FLOWS[0].transitions[0], { from: 'build', to: 'fix', when: 'done' }] },
  { name: 'bug', stages: [...FLOWS[1].stages, { name: 'fix', from: {} }], transitions: [{ from: 'triage', to: 'fix', when: 'done' }, { from: 'fix', to: 'end', when: 'done' }] },
];
const triaged: Task = { item: { itemId: 'board:I1', id: '1', title: 'T', body: '', url: '', source: 'board' }, stage: 'triage', boardColumn: 'Bug', auto: true };

const tab = (name: string) => screen.getByRole('radio', { name });
const chip = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}`) });
const posted = (): SettingsBody | undefined => {
  const call = fetchMock.mock.calls.find(([url]) => url === '/settings');
  return call && (JSON.parse(String(call[1]?.body)) as SettingsBody);
};
async function openFlow(user: UserEvent, flows = FLOWS, state?: State): Promise<void> {
  render(<Settings info={infoWith(flows)} state={state} onSaved={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: t('settings.section.flow') }));
}
const save = (user: UserEvent) => user.click(screen.getByRole('button', { name: t('settings.save') }));

test('one tab per flow; a tab scopes the chart to its own stages, and para lists its own flow first, then the other flow\'s stages by name (#565, #691)', async () => {
  const user = userEvent.setup();
  await openFlow(user);
  expect(tab('feature')).toHaveAttribute('aria-checked', 'true');
  expect([chip('spec'), chip('triage')].map((c) => c !== null)).toEqual([true, false]);
  await user.click(tab('bug'));
  expect([chip('spec'), chip('triage')].map((c) => c !== null)).toEqual([false, true]);
  await user.click(within(screen.getByRole('list', { name: 'saídas' })).getByRole('button', { name: new RegExp(`→ ${t('flow.end')}`) }));
  screen.getByRole('combobox', { name: 'para' }).focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['triage', 'feature · spec', 'feature · build', t('flow.end')]);
});

test('feature draws build\'s crossing pill and the legend\'s other-flow line; bug draws the incoming pill on fix (#691)', async () => {
  const user = userEvent.setup();
  await openFlow(user, CROSSED);
  expect(screen.getByRole('button', { name: t('settings.transitions.outgoing', { route: 'build → bug · fix' }) })).toBeInTheDocument();
  expect(screen.getByText(`${t('settings.transitions.legend')} · ${t('settings.transitions.legend.flows')}`)).toBeInTheDocument();
  await user.click(tab('bug'));
  expect(screen.getByRole('img', { name: t('settings.transitions.incoming', { from: 'feature · build', when: t('settings.transitions.when.done'), flow: 'feature' }) })).toBeInTheDocument();
});

test('+ fluxo › name › criar opens the new flow\'s tab with one empty stage selected (#565)', async () => {
  const user = userEvent.setup();
  await openFlow(user);
  await user.click(screen.getByRole('button', { name: t('settings.flows.add') }));
  await user.type(screen.getByLabelText(t('settings.flows.newName')), 'hotfix');
  await user.click(screen.getByRole('button', { name: t('settings.flows.create') }));
  expect(tab('hotfix')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByLabelText(t('settings.stages.name'))).toHaveValue('');
  expect(chip('spec')).toBeNull();
  expect(screen.queryByLabelText(t('settings.flows.newName'))).not.toBeInTheDocument();
});

test('the newFlow view opens fluxo with the + fluxo form shown and its field focused (#565)', () => {
  render(<Settings info={infoWith(FLOWS)} view={{ section: 'flow', newFlow: true }} onSaved={vi.fn()} />);
  expect(screen.getByLabelText(t('settings.flows.newName'))).toHaveFocus();
});

test('a flow name another flow has is refused inline, in + fluxo and in the rename field, and blocks the save (#565)', async () => {
  const user = userEvent.setup();
  await openFlow(user);
  const duplicate = t('settings.flows.error.duplicate', { name: 'bug' });
  await user.click(screen.getByRole('button', { name: t('settings.flows.add') }));
  await user.type(screen.getByLabelText(t('settings.flows.newName')), 'bug');
  expect(screen.getByText(duplicate)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.flows.create') })).toBeDisabled();
  // the footer's revert button carries the same word, so the form's own is looked up inside the form
  await user.click(within(screen.getByLabelText(t('settings.flows.newName')).parentElement!).getByRole('button', { name: t('settings.flows.cancel') }));
  const rename = screen.getByLabelText(t('settings.flows.name'));
  await user.clear(rename);
  await user.type(rename, 'bug');
  expect(screen.getByText(duplicate)).toBeInTheDocument();
  await save(user);
  await waitFor(() => expect(screen.getAllByText(duplicate)).toHaveLength(2)); // inline and the footer's
  expect(posted()).toBeUndefined();
});

test('a stage name another flow holds shows that flow inline and blocks the save (#565)', async () => {
  const user = userEvent.setup();
  await openFlow(user);
  await user.click(tab('bug'));
  const name = screen.getByLabelText(t('settings.stages.name'));
  await user.clear(name);
  await user.type(name, 'spec');
  const clash = t('settings.stages.error.otherFlow', { flow: 'feature' });
  expect(screen.getByText(clash)).toBeInTheDocument();
  await save(user);
  await waitFor(() => expect(screen.getAllByText(clash)).toHaveLength(2));
  expect(posted()).toBeUndefined();
});

test('excluir fluxo over a flow with tasks shows the count and keeps the flow; over an empty one it removes it and opens the first tab (#565)', async () => {
  const user = userEvent.setup();
  await openFlow(user, FLOWS, { ...BASE_STATE, tasks: [triaged] });
  await user.click(tab('bug'));
  await user.click(screen.getByRole('button', { name: t('settings.flows.remove') }));
  expect(screen.getByText(tPlural('settings.flows.holdsTasks', 1, { n: 1 }))).toBeInTheDocument();
  expect(tab('bug')).toBeInTheDocument();
});

test('excluir fluxo removes an empty flow and opens the first tab; the last flow\'s button is disabled with its hint (#565)', async () => {
  const user = userEvent.setup();
  await openFlow(user);
  await user.click(tab('bug'));
  await user.click(screen.getByRole('button', { name: t('settings.flows.remove') }));
  expect(screen.queryByRole('radio', { name: 'bug' })).not.toBeInTheDocument();
  expect(tab('feature')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('button', { name: t('settings.flows.remove') })).toBeDisabled();
  expect(screen.getByText(t('settings.flows.lastFlow'))).toBeInTheDocument();
});

test('the save sends flows: a renamed flow under its new name, every stage and transition in its own flow, no flat pair (#565)', async () => {
  const user = userEvent.setup();
  await openFlow(user);
  await user.click(tab('bug'));
  const rename = screen.getByLabelText(t('settings.flows.name'));
  await user.clear(rename);
  await user.type(rename, 'hotfix');
  await save(user);
  await waitFor(() => expect(posted()).toBeDefined());
  const body = posted()!;
  expect('stages' in body || 'transitions' in body).toBe(false);
  expect(body.flows).toEqual([FLOWS[0], { ...FLOWS[1], name: 'hotfix' }]);
});

test('picking a stage of another flow in the search opens its flow\'s tab with it selected (#565)', async () => {
  const user = userEvent.setup();
  render(<Settings info={infoWith(FLOWS)} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await user.type(screen.getByRole('combobox', { name: t('settings.search') }), 'triage');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(tab('bug')).toHaveAttribute('aria-checked', 'true'));
  expect(screen.getByLabelText(t('settings.stages.name'))).toHaveValue('triage');
});
