import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock, type MainDockProps } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import { type DockLayout, inEveryView } from '@/lib/dock-layout';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task, Terminal } from '../../src/types';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, localPairs, withPointedWork, type WithWork } from '../fixtures/work';
import { localActivityId } from '../../src/activities';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/w/a' };
const shellA: Terminal = { terminalId: 'W2', activityId: activityIdOf('A'), startedAt: '2026-09-27T10:00:00.000Z', cwd: '/repo' };

function Home({ workspaces = ['hive'], terminals = [] as Terminal[], tasks = [taskA], newActivity }: { workspaces?: string[]; terminals?: Terminal[]; tasks?: Task[]; newActivity?: MainDockProps['newActivity'] }) {
  const work = withPointedWork({ tasks: tasks, workers: [], terminals: terminals, ...localPairs(workspaces) }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={workspaces} tasks={tasks} workers={[]} terminals={terminals}
      liveActivities={work.activities} activityRecords={work.activityRecords}
      search={{ state: stateOf(tasks, { terminals, workspaces: workspaces }) }} newActivity={newActivity}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={() => <header />}
    >
      <main>fluxo</main>
    </MainDock>
  );
}

const key = (letter: string): void => { fireEvent.keyDown(window, { key: letter.toUpperCase(), code: `Key${letter.toUpperCase()}`, ctrlKey: true, shiftKey: true }); }; // Ctrl+Shift off macOS (#585)
// The dashboard's own posts; the view state's debounced writes (#484) are left out, they land 250 ms after any mount
const posts = (): string[] => vi.mocked(fetch).mock.calls
  .filter(([url, init]) => init?.method === 'POST' && !String(url).startsWith('/view-state/')).map(([url]) => String(url));
const toHome = (): void => { fireEvent.click(screen.getByRole('button', { name: 'atividades' })); };

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/workspaces/branches' ? [{ name: 'hive', branch: 'main' }, { name: 'site', branch: null }] : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const DETAIL_RIGHT: DockLayout = { docks: { automation: 'left', activities: 'left', plugins: 'left', detail: 'right' }, sizes: inEveryView({ left: 30, right: 30 }), open: inEveryView({ left: true, right: true }) }; // Detalhes alone on the right

test('the window opens on the home, which hides the right side without closing it: under Automação it shows, and the home hides it again (redesign 08, #746)', () => {
  resetViewState({ dockLayout: DETAIL_RIGHT });
  render(<Home />);
  expect(screen.getByRole('heading', { name: 'Nenhuma atividade aberta' })).toBeInTheDocument();
  expect(screen.getByText('detalhes')).not.toBeVisible();
  expect((readView('dockLayout') as DockLayout | undefined)?.open.activities.right).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' }));
  expect(screen.getByText('detalhes')).toBeVisible();
  toHome();
  expect(screen.getByText('detalhes')).not.toBeVisible();
});

test('the new activity key goes to the flow; the search key opens the search on tudo and the search-commands key on comandos; Escape closes it (redesign 08, #584)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  toHome();
  key('n');
  expect(screen.getByRole('main')).toHaveTextContent('fluxo');
  key('p');
  expect(within(screen.getByRole('dialog', { name: 'busca' })).getByRole('button', { pressed: true })).toHaveTextContent('tudo');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'F1', code: 'F1' }); // searchOperations off macOS (#585)
  expect(within(screen.getByRole('dialog', { name: 'busca' })).getByRole('button', { pressed: true })).toHaveTextContent('comandos');
});

test('with one workspace the new terminal key opens a shell on its checkout at once; with an activity picked, in the activity (redesign 08)', () => {
  const { rerender } = render(<Home />);
  key('t');
  expect(posts()).toEqual(['/activities/local%3Ahive/shell']);
  rerender(<Home terminals={[shellA]} />);
  toHome();
  fireEvent.click(screen.getByRole('button', { name: /#1 Task A/ }));
  key('t');
  expect(posts().at(-1)).toBe('/activities/a-A/open'); // #629: the activity's own open
});

test('with several workspaces terminal no local opens the picker: colour, name and branch per row, the last one used selected, typing filtering (redesign 08)', async () => {
  const user = userEvent.setup();
  resetViewState({ lastWorkspace: 'site' });
  render(<Home workspaces={['hive', 'site']} />);
  toHome();
  await user.click(screen.getByRole('button', { name: /terminal no local/ }));
  const picker = screen.getByRole('dialog', { name: 'terminal no local' });
  expect(await within(picker).findByText('main')).toBeInTheDocument();
  expect(within(picker).getByRole('option', { name: 'site' })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{Enter}');
  expect(posts()).toEqual(['/activities/local%3Asite/shell']);
  expect(readView('lastWorkspace')).toBe('site');
  key('t');
  await user.keyboard('hiv');
  expect(within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.textContent)).toEqual(['hivemain']);
});

test('a last workspace no longer listed selects the first row instead of none (redesign 08)', async () => {
  const user = userEvent.setup();
  resetViewState({ lastWorkspace: 'gone' });
  render(<Home workspaces={['hive', 'site']} />);
  key('t');
  expect(within(screen.getByRole('dialog')).getByRole('option', { name: /hive/ })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{Enter}');
  expect(posts()).toEqual(['/activities/local%3Ahive/shell']);
});

test('a recent task with only its worktree left resumes its last session rather than opening an empty activity (redesign 03, 08)', async () => {
  const user = userEvent.setup();
  const at = new Date(Date.now() - 60_000).toISOString();
  const id = '5e6b7939-0000-4000-8000-000000000001';
  const idle: Task = taskA;
  const activityRecords = [{ id: 'a-A', taskIds: [idle.item.itemId], sessions: [{ id, startedAt: at, stages: ['dev'], agent: 'claude' as const, lastUsedAt: at }] }]; // #629: the session is the record's
  render(
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[idle]} workers={[]} terminals={[]} activityRecords={activityRecords}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={() => <header />}
    >
      <main>fluxo</main>
    </MainDock>,
  );
  toHome();
  await user.click(within(screen.getByRole('region', { name: 'recentes' })).getByRole('button', { name: /#1 Task A/ }));
  expect(posts()).toContain(`/activities/a-A/sessions/${id}/open`);
});

test('the new terminal key opens a terminal in the workspace\'s local activity: the activity is selected, and its tab shows once the run is live (#590)', async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url === '/activities/local%3Ahive/shell' ? { ok: true, ptyId: 'P1' } : url === '/workspaces/branches' ? [{ name: 'hive', branch: 'main' }] : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const { rerender } = render(<Home />);
  key('t');
  const local = (): HTMLElement => within(screen.getByRole('navigation', { name: 'Atividades' })).getByRole('button', { name: /^local/ });
  await waitFor(() => expect(local()).toHaveAttribute('aria-current', 'true'));
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/activities/local%3Ahive/shell')).toBe(true);
  rerender(<Home terminals={[{ terminalId: 'P1', activityId: localActivityId('hive'), startedAt: '2026-09-29T10:00:00.000Z', cwd: '/repo' }]} />);
  expect(within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Terminal']);
});

test('a task\'s ↵ opens the Start dialog on it, and + criar tarefa opens it with the typed title (#584)', async () => {
  const user = userEvent.setup();
  const other: WithWork = { ...taskA, item: { ...taskA.item, itemId: 'B', id: '2', title: 'Task B' }, worktree: undefined };
  render(<Home tasks={[taskA, other]} newActivity={(start) => <p>{`start:${start.taskId ?? ''}:${start.title ?? ''}`}</p>} />);
  key('p');
  await user.keyboard('task b{Enter}');
  expect(screen.getByText('start:B:')).toBeInTheDocument();
  key('p');
  await user.keyboard('#nothing like it');
  await user.click(screen.getByRole('option', { name: '+ criar tarefa "nothing like it"' }));
  expect(screen.getByText('start::nothing like it')).toBeInTheDocument();
});

test('a local activity picked under Atividades shows the right side with its checkout\'s tree and no detail; the home still hides it, and the saved layout keeps it open (#633)', async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const body = String(input) === '/activities/local%3Ahive/tree' ? { files: ['README.md'], marks: {}, ignored: { files: [], folders: [] } } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  resetViewState({ dockLayout: DETAIL_RIGHT });
  render(<Home />);
  toHome();
  expect(screen.getByText('detalhes')).not.toBeVisible();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByRole('button', { name: /^local/ }));
  expect(await screen.findByRole('button', { name: 'README.md' })).toBeVisible();
  expect(screen.queryByText('detalhes')).not.toBeInTheDocument(); // neither the detail body nor the arquivos | detalhes toggle
  expect((readView('dockLayout') as DockLayout | undefined)?.open.activities.right).toBe(true);
});

test('picking a sleeping activity wakes nothing, though its stored layout names its session: only a click in its pane or on its line does (#16)', () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const id = '5e6b7939-0000-4000-8000-000000000002';
  const activityRecords = [{ id: 'a-A', taskIds: [taskA.item.itemId], sessions: [{ id, startedAt: at, stages: ['dev'], agent: 'claude' as const, lastUsedAt: at }] }];
  resetViewState({ centerLayouts: { A: { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1', sessionId: id }], active: 0 }, focused: 'g1' } } });
  render(
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA]} workers={[]} terminals={[]} activityRecords={activityRecords}
      liveActivities={withPointedWork({ tasks: [taskA], workers: [], terminals: [], activities: [], activityRecords }).activities}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={() => <header />}
    >
      <main>fluxo</main>
    </MainDock>,
  );
  toHome();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByRole('button', { name: /#1 Task A/ }));
  expect(posts().filter((url) => url.includes('/open') || url.includes('/wake'))).toEqual([]);
});
