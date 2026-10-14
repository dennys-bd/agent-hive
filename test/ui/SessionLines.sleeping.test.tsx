import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ActivitiesPanel } from '@/components/ActivitiesPanel';
import { LocalSessionLines } from '@/components/SessionLines';
import { RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import type { Session } from '../../src/types';
import { taskPairOf, type WithWork } from '../fixtures/work';

// A sleeping session (#614): one the task keeps and no run holds
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const session: Session = { id: S, startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '' };
const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive', worktree: '/w/1' };
const records = [{ id: 'a-I1', taskIds: ['I1'], sessions: [session] }]; // #629: the task's session is its record's
const activity: TaskActivity = { kind: 'task', ...taskPairOf('I1', {}, records[0]), task, runs: [], sessions: [{ session, status: 'empty' }], status: 'empty', worker: false, records };
// The open route answers the run it started (#249); the sidebar's own reads (branches, worktree states) get an empty list
const answer = (url: string): unknown => (url.endsWith('/open') ? { ok: true, ptyId: 'W9' } : []);
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(answer(url)), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('a sleeping task line reads dormindo; a click continues it through the task\'s open route and attaches the answered run in its activity (#614)', async () => {
  const user = userEvent.setup();
  const openRun = vi.fn();
  render(
    <RunOpenerContext.Provider value={openRun}>
      <ActivitiesPanel activities={[activity]} workspaces={['hive']} stages={[]} workers={[]} onSelect={vi.fn()} onOpenRun={vi.fn()} nav={{ newActivity: vi.fn() }} />
    </RunOpenerContext.Provider>,
  );
  const line = screen.getByRole('button', { name: /^claude/ });
  expect(line).toHaveTextContent(/^claudea1b2c3d4dormindo$/);
  expect(line).not.toHaveAttribute('aria-current');
  await user.click(line);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/a-I1/sessions/${S}/open`, expect.objectContaining({ method: 'POST' })));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 'W9', task: 'I1', kind: 'session' })));
});

test('a stopped local line reads dormindo too (#614)', () => {
  render(<LocalSessionLines workspace="hive" sessions={[{ ...session, stages: [] }]} workers={[]} runs={[]} onOpenRun={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^claude/ })).toHaveTextContent(/^claudea1b2c3d4dormindo$/);
});
