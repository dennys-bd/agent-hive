import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { type RunTab, useOpenFile, useOpenRun } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { Worker } from '../../src/types';
import { jsonResponse } from '../fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

// #533: tasks A and B each run their stage; A's design must survive the center leaving it
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const taskB: WithWork = { item: { itemId: 'B', id: '2', title: 'Task B', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's2' };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const workerB: Worker = { id: 's2', status: 'working', activityId: activityIdOf('B'), runId: 'W5' };
const RUN_B: RunTab = { ptyId: 'W5', kind: 'stage', task: 'B', title: '#2 Task B' };

// What a click on a file and on a run do inside the Dashboard: hand them to the dock's openers (#717, #457)
function Openers() {
  const openFile = useOpenFile();
  const openRun = useOpenRun();
  return (
    <>
      <button type="button" onClick={() => openFile?.('A', 'design/Landing.hv.html')}>design A</button>
      <button type="button" onClick={() => openRun?.(RUN_B)}>run B</button>
    </>
  );
}

function Home({ tasks = [taskA, taskB], workers = [workerA, workerB] }: { tasks?: WithWork[]; workers?: Worker[] }) {
  const work = withPointedWork({ tasks, workers, terminals: [], activities: [], activityRecords: [] });
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={tasks} workers={workers} liveActivities={work.activities} activityRecords={work.activityRecords}
      terminals={[]} onSelect={() => {}} detail={() => <Openers />} automation={() => <p>automação</p>} header={() => <header />}
    >
      <main>fluxo</main>
    </MainDock>
  );
}

const click = (name: string): void => { fireEvent.click(screen.getByRole('button', { name, hidden: true })); };
const layerOf = (frame: HTMLElement): HTMLElement | null => frame.closest('[data-design-layer]');

beforeEach(() => {
  resetViewState();
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/Landing.hv.html' }) : jsonResponse({ version: 'v1' }))));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('the design\'s frame is the same node after the center shows Fluxo and comes back, and after another activity is picked and this one again; inert meanwhile (#533)', async () => {
  render(<Home />);
  click('design A');
  const frame = await screen.findByTitle('Landing.hv.html');
  expect(layerOf(frame)).not.toHaveAttribute('inert');
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' }));
  expect(screen.getByTitle('Landing.hv.html')).toBe(frame);
  expect(layerOf(frame)).toHaveAttribute('inert');
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  expect(screen.getByTitle('Landing.hv.html')).toBe(frame);
  expect(layerOf(frame)).not.toHaveAttribute('inert');
  click('run B');
  expect(screen.queryByRole('tab', { name: 'Landing.hv.html' })).toBeNull(); // B's center shows
  expect(layerOf(frame)).toHaveAttribute('inert');
  click('design A');
  expect(screen.getByTitle('Landing.hv.html')).toBe(frame);
  expect(layerOf(frame)).not.toHaveAttribute('inert');
});

test('the pane and its frame go when their activity leaves the list (#533)', async () => {
  const { rerender } = render(<Home />);
  click('design A');
  await screen.findByTitle('Landing.hv.html');
  rerender(<Home tasks={[taskB]} workers={[workerB]} />);
  expect(screen.queryByTitle('Landing.hv.html')).toBeNull();
});
