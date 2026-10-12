import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { continueLocalRun, openLocalRun } from '@/components/local-runs';
import { SessionLine } from '@/components/SessionLines';
import { SleepNotice } from '@/components/SleepNotice';
import { setLanguage } from '@/i18n';
import { liveRuns } from '../../src/task-runs';
import type { AgentId, Task } from '../../src/types';
import { activityIdOf, taskPairOf } from '../fixtures/work';

// #925: no second agent ships until 3.1 adds codex, so this file adds one. AGENTS gains its facts (agentName reads them, so it is rebuilt
// over the mocked map), AGENT_IDS lists it. Its id is a cast: no production id is added
const { OTHER } = vi.hoisted(() => ({ OTHER: 'othercli' }));
vi.mock('../../src/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agents')>();
  const AGENTS = { ...actual.AGENTS, [OTHER]: { ...actual.AGENTS.claude, label: 'Othercli', command: OTHER, planLimits: false } };
  return { ...actual, AGENTS, agentName: (agent: string): string => AGENTS[agent as keyof typeof AGENTS].label.toLowerCase() };
});
vi.mock('../../src/types', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/types')>()), AGENT_IDS: ['claude', OTHER] }));

const AGENT = OTHER as AgentId;
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
beforeEach(() => setLanguage('pt'));

test('a session line names its session\'s agent and no Claude; an agent without an icon reads by its name alone (#925)', () => {
  render(<SessionLine agent={AGENT} label="a1b2c3d4" status="working" isShown={false} onOpen={vi.fn()} />);
  const line = screen.getByRole('button', { name: /^othercli/ });
  expect(line.textContent).not.toMatch(/claude/i);
  expect(line.querySelector('svg')).toBeNull();
});

test('a run tab is labelled with the agent its worker runs, not Claude (#925)', () => {
  const { activity, record } = taskPairOf('I1', {}, { sessions: [{ id: S, startedAt: '', stages: [], lastUsedAt: '', agent: AGENT }] });
  const worker = { id: 'w', status: 'working' as const, runId: 'W1', activityId: activityIdOf('I1'), sessionId: S, freeSession: true as const, agent: AGENT };
  const [run] = liveRuns(task, { workers: [worker], terminals: [], activities: [activity], activityRecords: [record] });
  expect(run).toMatchObject({ label: 'Othercli · a1b2c3d4', agent: OTHER });
});

test('a sleep notice names the agent of the session that slept (#925)', () => {
  render(<SleepNotice sessions={[{ agent: AGENT, session: 'a1b2c3d4' }]} where="#1 Task 1" hasTab={false} onClose={vi.fn()} />);
  expect(document.body.textContent).toMatch(/othercli a1b2c3d4/);
  expect(document.body.textContent).not.toMatch(/claude/i);
});

test('a new local session posts its agent as the kind; a continued one posts none: its session decides (#925)', async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  openLocalRun('hive', AGENT);
  continueLocalRun('hive', S);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const kinds = fetchMock.mock.calls.map(([url, init]) => [String(url), (JSON.parse(String(init?.body)) as { kind?: string }).kind]);
  expect(kinds).toEqual([['/activities/local%3Ahive/sessions', OTHER], [`/activities/local%3Ahive/sessions/${S}/open`, undefined]]);
  vi.unstubAllGlobals();
});
