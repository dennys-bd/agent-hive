import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SessionLine } from '@/components/SessionLines';
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
