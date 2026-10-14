import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { LocalSessionLines, TaskSessionLine } from '@/components/SessionLines';
import { setLanguage } from '@/i18n';
import type { ActivitySession, TaskActivity } from '@/lib/activities';
import type { Session } from '../../src/types';
import { taskPairOf, type WithWork } from '../fixtures/work';

// #308: a run that has no session id yet (a Codex before its first prompt) shows from its start, marked iniciando
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const starting: ActivitySession = { run: { ptyId: 'P1', label: 'Codex', kind: 'session', agent: 'codex' }, status: 'working' };
beforeEach(() => setLanguage('pt'));

test('a local run with no id yet reads iniciando, and its click opens its run (#308)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<LocalSessionLines workspace="hive" sessions={[]} workers={[]} runs={[starting]} onOpenRun={onOpen} />);
  const line = screen.getByRole('button', { name: /^codex/ });
  expect(line).toHaveTextContent(/iniciando/);
  await user.click(line);
  expect(onOpen).toHaveBeenCalledWith('P1');
});

test('a local run whose id is kept shows once, as its kept session (#308)', () => {
  const kept: Session = { id: S, startedAt: '', stages: [], agent: 'codex', lastUsedAt: '' };
  const run: ActivitySession = { ...starting, run: { ...starting.run, session: 'a1b2c3d4' }, sessionId: S };
  render(<LocalSessionLines workspace="hive" sessions={[kept]} workers={[]} runs={[run]} onOpenRun={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByText('iniciando')).toBeNull();
});

test('no live run and no kept session: nothing listed (#308)', () => {
  render(<LocalSessionLines workspace="hive" sessions={[]} workers={[]} runs={[]} onOpenRun={vi.fn()} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('a task run not kept yet reads iniciando too (#308)', () => {
  const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive', worktree: '/w/1' };
  const records = [{ id: 'a-I1', taskIds: ['I1'], sessions: [] }];
  const activity: TaskActivity = { kind: 'task', ...taskPairOf('I1', {}, records[0]), task, runs: [starting.run], sessions: [{ run: starting.run, status: 'working' }], status: 'working', worker: false, records };
  render(<TaskSessionLine activity={activity} entry={{ run: starting.run, status: 'working' }} onOpenRun={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^codex/ })).toHaveTextContent(/iniciando/);
});
