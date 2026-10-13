import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import type { Worker, } from '../../src/types';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', worktree: '/w/a', workspace: 'hive', auto: true };
const working: Worker = { id: 's1', activityId: activityIdOf('A'), status: 'working', runId: 'W1' };

function Home({ commands, flow = <main>fluxo</main> }: { commands: string[]; flow?: ReactNode }) {
  const work = withPointedWork({ tasks: [taskA], workers: [working], terminals: [], activities: [], activityRecords: [] }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA]} workers={[working]} terminals={[]}
      liveActivities={work.activities} activityRecords={work.activityRecords}
      search={{ state: stateOf([taskA], { workers: [working], commands: { hive: commands } }) }}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>}
      header={() => <header />}
    >
      {flow}
    </MainDock>
  );
}

// runCommand is Ctrl+Shift+R off macOS (#585)
const runKey = (): boolean => fireEvent.keyDown(window, { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true });
const runs = (): unknown[] => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/activities/a-A/run').map(([, init]) => JSON.parse(String(init?.body)));
const showActivity = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  await user.click(screen.getByRole('button', { name: /#1 Task A/ }));
};

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('with one command, the run-command key runs it on the shown activity at once (#585)', async () => {
  const user = userEvent.setup();
  render(<Home commands={['test']} />);
  await showActivity(user);
  runKey();
  await waitFor(() => expect(runs()).toEqual([{ command: 'test' }]));
  expect(screen.queryByRole('dialog', { name: 'busca' })).not.toBeInTheDocument();
});

test('with several, it opens the search on that task\'s commands; a pick runs it (#585)', async () => {
  const user = userEvent.setup();
  render(<Home commands={['test', 'lint']} />);
  await showActivity(user);
  runKey();
  const search = await screen.findByRole('dialog', { name: 'busca' });
  expect(within(search).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringMatching(/test/), expect.stringMatching(/lint/)]);
  await user.keyboard('lint{Enter}');
  await waitFor(() => expect(runs()).toEqual([{ command: 'lint' }]));
});

test('in the flow it acts on the focused task; with no command it does nothing and leaves the key alone (#585)', async () => {
  const { rerender } = render(<Home commands={['test']} flow={<main><button type="button" data-task-id="A">task A</button></main>} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  screen.getByRole('button', { name: 'task A' }).focus();
  runKey();
  await waitFor(() => expect(runs()).toEqual([{ command: 'test' }]));
  rerender(<Home commands={[]} flow={<main><button type="button" data-task-id="A">task A</button></main>} />);
  runKey();
  expect(runs()).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: 'busca' })).not.toBeInTheDocument();
});
