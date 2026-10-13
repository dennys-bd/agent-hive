import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import type { Task, Worker } from '../../src/types';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/w/a' };
const working: Worker = { id: 's1', activityId: activityIdOf('A'), status: 'working', runId: 'W1' };
const second: Worker = { id: 's2', activityId: activityIdOf('A'), status: 'working', runId: 'W2', freeSession: true };

function Home({ tasks = [taskA], workers = [] as Worker[], flow = <main>fluxo</main> }: { tasks?: Task[]; workers?: Worker[]; flow?: ReactNode }) {
  const work = withPointedWork({ tasks: tasks, workers: workers, terminals: [], activities: [], activityRecords: [] }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={tasks} workers={workers} terminals={[]} liveActivities={work.activities} activityRecords={work.activityRecords} search={{ state: stateOf(tasks, { workers }) }}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>}
      header={() => <header />}
    >
      {flow}
    </MainDock>
  );
}

const commandsKey = (): void => { fireEvent.keyDown(window, { key: 'F1', code: 'F1' }); }; // searchOperations off macOS (#585)
const posts = (): string[] => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url));

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('with an activity open, ⌘⇧P lists its operations; dormir todas opens its dialog and sleeps both agent sessions (#584, #672)', async () => {
  const user = userEvent.setup();
  render(<Home workers={[working, second]} />);
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  await user.click(screen.getByRole('button', { name: /#1 Task A/ }));
  commandsKey();
  await user.keyboard('dormir{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'Dormir #1 Task A?' });
  await user.click(within(dialog).getByRole('button', { name: 'dormir todas' }));
  await waitFor(() => expect(posts()).toContain('/ptys/sleep'));
});

test('a focused task leads the comandos with its operations; aprovar posts and the focus goes back to it (#584)', async () => {
  const user = userEvent.setup();
  const pending: WithWork = { ...taskA, approval: { since: '2026-09-28T10:00:00.000Z' } };
  render(<Home tasks={[pending]} flow={<main><button type="button" data-task-id="A">task A</button></main>} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  const face = screen.getByRole('button', { name: 'task A' });
  face.focus();
  commandsKey();
  expect(screen.getAllByRole('option').slice(0, 3).map((o) => o.textContent)).toEqual([
    expect.stringMatching(/enviar feedback….*#1/), expect.stringMatching(/aprovar.*#1/), expect.stringMatching(/começar sozinho.*#1/),
  ]);
  await user.keyboard('aprovar{Enter}');
  await waitFor(() => expect(posts()).toContain('/activities/a-A/approve'));
  await waitFor(() => expect(face).toHaveFocus());
});

test('the search key pressed while it is open keeps the focus group, switches to the scope it names and gives the focus back on Escape (#584)', async () => {
  const user = userEvent.setup();
  const pending: WithWork = { ...taskA, approval: { since: '2026-09-28T10:00:00.000Z' } };
  render(<Home tasks={[pending]} flow={<main><button type="button" data-task-id="A">task A</button></main>} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  const face = screen.getByRole('button', { name: 'task A' });
  face.focus();
  commandsKey();
  fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
  expect(within(screen.getByRole('dialog', { name: 'busca' })).getByRole('button', { pressed: true })).toHaveTextContent('tudo');
  commandsKey();
  expect(within(screen.getByRole('dialog', { name: 'busca' })).getByRole('button', { pressed: true })).toHaveTextContent('comandos');
  expect(screen.getAllByRole('option')[0]).toHaveTextContent(/enviar feedback…/);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(face).toHaveFocus());
});
