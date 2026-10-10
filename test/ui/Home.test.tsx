import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Home, type HomeNav } from '@/components/Home';
import { setLanguage } from '@/i18n';
import type { ActivityRecord, Task, Worker } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// A fixed local midday: an hour earlier stays on the same day, so the row always reads há 1 h (#555).
const MIDDAY = new Date(2026, 0, 15, 12, 0, 0);
const task = (id: string): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: `/w/${id}`,
});
// Each task's session last used at `at`, in its record (#629)
const records = (at: string, ...ids: string[]): ActivityRecord[] =>
  ids.map((id) => ({ id: `a-I${id}`, taskIds: [`I${id}`], sessions: [{ id: `5e6b7939-${id}`, startedAt: at, stages: ['dev'], lastUsedAt: at }] }));
const waiting: Worker = { id: 's1', activityId: activityIdOf('I1'), status: 'waiting', sessionId: '5e6b7939-aaaa' };
const approval: Worker = { id: 's2', activityId: activityIdOf('I2'), status: 'approval', sessionId: 'f9f0456a-bbbb' };

// The home's props for these runs (#629): each run's activity and record, as the State holds them
const work = (tasks: Task[], workers: Worker[], activityRecords: ActivityRecord[] = []) => {
  const { activities, ...rest } = withPointedWork({ tasks, workers, activities: [], activityRecords });
  return { ...rest, liveActivities: activities };
};

function navOf(live: string[] = []): HomeNav {
  return { openActivity: vi.fn(), isLive: (id) => live.includes(id), newActivity: vi.fn(), localTerminal: vi.fn(), addWorkspace: vi.fn() };
}

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('the home says no activity is open and offers nova atividade and terminal no local (redesign 08)', async () => {
  const user = userEvent.setup();
  const nav = navOf();
  render(<Home tasks={[]} liveActivities={[]} activityRecords={[]} workers={[]} workspaces={['hive']} nav={nav} />);
  expect(screen.getByRole('heading', { name: 'Nenhuma atividade aberta' })).toBeInTheDocument();
  expect(screen.getByText('escolha uma na lateral, retome uma recente ou comece uma nova.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /nova atividade/ }));
  await user.click(screen.getByRole('button', { name: /terminal no local/ }));
  expect([nav.newActivity, nav.localTerminal].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1]);
  expect(screen.queryByRole('region', { name: /precisam de você/ })).not.toBeInTheDocument(); // nothing pending: no section
});

test('precisam de você lists waiting sessions before approvals, each bordered in its status, abrir or revisar opening its activity (redesign 08)', async () => {
  const user = userEvent.setup();
  const nav = navOf(['I1', 'I2']);
  render(<Home {...work([task('1'), task('2')], [approval, waiting])} workspaces={['hive']} nav={nav} />);
  const section = screen.getByRole('region', { name: 'precisam de você · 2' });
  const [first, second] = within(section).getAllByRole('button').map((button) => button.parentElement as HTMLElement);
  expect(first).toHaveTextContent('#1 Task 1claude · 5e6b7939esperando vocêabrir');
  expect(first).toHaveClass('border-waiting');
  expect(second).toHaveTextContent('revisar');
  expect(second).toHaveClass('border-approval');
  await user.click(within(second).getByRole('button', { name: 'revisar' }));
  expect(nav.openActivity).toHaveBeenCalledWith('I2');
});

test('recentes opens a live task\'s activity and resumes a stopped task\'s last session (redesign 08)', async () => {
  const user = userEvent.setup();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MIDDAY);
  const hourAgo = new Date(MIDDAY.getTime() - 3_600_000).toISOString();
  const nav = navOf(['I1']);
  render(<Home {...work([task('1'), task('2')], [{ id: 's1', activityId: activityIdOf('I1'), status: 'working' }], records(hourAgo, '1', '2'))} workspaces={['hive']} nav={nav} />);
  const section = screen.getByRole('region', { name: 'recentes' });
  await user.click(within(section).getByRole('button', { name: /#1 Task 1.*trabalhando/ }));
  expect(nav.openActivity).toHaveBeenCalledWith('I1');
  await user.click(within(section).getByRole('button', { name: /#2 Task 2.*parada.*há 1 h/ }));
  expect(fetch).toHaveBeenCalledWith('/activities/a-I2/sessions/5e6b7939-2/open', expect.objectContaining({ method: 'POST' }));
});

test('the keys row shows each shortcut\'s current binding with its label (redesign 08)', () => {
  render(<Home tasks={[]} liveActivities={[]} activityRecords={[]} workers={[]} workspaces={['hive']} nav={navOf()} />);
  for (const hint of ['Ctrl+Shift+Nnova atividade', 'Ctrl+Shift+Pbuscar', 'Ctrl+Shift+Tterminal no local', 'Ctrl+2fluxo']) { // the flow's key moved to ⌘2 (#746)
    expect(screen.getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === hint)).toBeInTheDocument();
  }
});

test('with no workspace yet, the home only offers adicionar workspace… (redesign 08)', async () => {
  const user = userEvent.setup();
  const nav = navOf();
  render(<Home tasks={[]} liveActivities={[]} activityRecords={[]} workers={[]} workspaces={[]} nav={nav} />);
  expect(screen.getByRole('heading', { name: 'Nenhum workspace ainda' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /nova atividade/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'adicionar workspace…' }));
  expect(nav.addWorkspace).toHaveBeenCalled();
});
