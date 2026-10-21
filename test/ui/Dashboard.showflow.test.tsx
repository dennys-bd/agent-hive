import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import type { SourcesNav } from '@/components/FlowSources';
import { forgetProjects } from '@/hooks/use-project';
import { resetRepositories } from '@/hooks/use-repositories';
import { setLanguage } from '@/i18n';
import type { RepoSummary, SourceConfig, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

// "ver no fluxo" (#229): the task of roadmap must show in the flow whatever the center held before
const source = (name: string): SourceConfig => ({ name, qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' });
const NAV: SourcesNav = { sources: [source('roadmap'), source('other')], auth: 'cli' };
const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 2, openIssues: 3, closedIssues: 1, canPush: true, issuesEnabled: true, lastActivity: '2026-10-05T09:00:00Z', syncedAt: '2026-10-05T09:00:00Z' };
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] },
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const TASK: WithWork = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: 'https://github.com/acme/site/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const WORKER: Worker = { id: 's1', status: 'working', activityId: activityIdOf('roadmap:PVTI_12'), runId: 'W1', sessionId: 'abcdef123456', startedAt: '2026-10-05T09:00:00.000Z' };
const working: State = withPointedWork({ ...state, workers: [WORKER], tasks: [TASK] });

const jsonRes = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const PRS = { counts: { open: 0, merged: 0, closed: 0 }, truncated: false, canPush: true, syncedAt: '2026-10-05T09:00:00Z', rows: [] };
const ANSWERS: Record<string, unknown> = { '/repositories': [SITE], '/repositories/acme/site/pulls?state=open': PRS };
const answer = async (input: RequestInfo | URL): Promise<Response> => jsonRes(Object.hasOwn(ANSWERS, String(input)) ? ANSWERS[String(input)] : { ok: true });

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  resetRepositories();
  forgetProjects();
  vi.stubGlobal('fetch', vi.fn(answer));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); });

function Home() {
  const [selected, setSelected] = useState<Selection | undefined>();
  return <Dashboard state={working} locale="pt-BR" tick={0} sources={NAV} selected={selected} onSelect={setSelected} />;
}

const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); }; // the window opens on Atividades (#746)
const showActivities = (): void => { fireEvent.click(screen.getByRole('button', { name: 'atividades' })); };
const automation = () => within(screen.getByRole('region', { name: 'Automação' }));
const bar = () => within(document.querySelector<HTMLElement>('[data-header-column="center"]')!); // the flow's bar, in the window header (#295)
const right = (): HTMLElement => document.querySelector<HTMLElement>('[data-dock="right"]')!;

// Picks the task's activity and presses the details' "ver no fluxo"
async function seeInFlow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  showActivities();
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#12 Pager breaks').closest('button') as HTMLElement);
  fireEvent.keyDown(document.body, { key: 'E', code: 'KeyE', ctrlKey: true, altKey: true, shiftKey: true }); // toggleSideTab off macOS: opens Detalhes (#585)
  await user.click(within(right()).getByRole('button', { name: 'ver no fluxo' }));
}

test('from a repository page, see in flow lands on the task\'s source flow with the task selected and no back button', async () => {
  const user = userEvent.setup();
  render(<Home />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await bar().findByRole('tab', { name: 'issues 3' }); // the repository is shown
  await seeInFlow(user);
  expect(bar().queryByRole('tab', { name: 'issues 3' })).not.toBeInTheDocument(); // the repository is gone
  expect(screen.getByRole('heading', { name: '#12 Pager breaks' })).toBeInTheDocument();
  expect(bar().queryByTitle(/^voltar( · |$)/)).not.toBeInTheDocument(); // the back button's title (#911)
});

test('with another source picked, see in flow moves the pick to the task\'s source', async () => {
  const user = userEvent.setup();
  render(<Home />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^other/ }));
  await bar().findByText(/other/);
  await seeInFlow(user);
  expect(await bar().findByRole('tab', { name: 'GitHub Project' })).toBeInTheDocument();
  expect(automation().getByRole('button', { name: /^roadmap/ })).toHaveAttribute('aria-pressed', 'true');
  expect(automation().getByRole('button', { name: /^other/ })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('heading', { name: '#12 Pager breaks' })).toBeInTheDocument();
});
