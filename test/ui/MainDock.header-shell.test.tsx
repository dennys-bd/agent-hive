import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import type { HeaderShell } from '@/hooks/use-header-shell';
import { setLanguage } from '@/i18n';
import { type DockLayout, inEveryView } from '@/lib/dock-layout';
import { resetViewState } from '@/lib/view-state';
import type { Terminal } from '../../src/types';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, localPairs, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/w/a' };
const shellA: Terminal = { terminalId: 'W2', activityId: activityIdOf('A'), startedAt: '2026-09-27T10:00:00.000Z', cwd: '/repo' };
const DETAIL_RIGHT: DockLayout = { docks: { automation: 'left', activities: 'left', plugins: 'left', detail: 'right' }, sizes: inEveryView({ left: 30, right: 30 }), open: inEveryView({ left: true, right: true }) };

// What MainDock hands the header (#221), laid out for the queries: the center's slot, the shell's facts and a picker per pane
function Probe({ shell }: { shell: HeaderShell }) {
  const { panes, layout } = shell;
  const facts = { active: panes.active ?? null, enabled: panes.enabled, rightShown: shell.rightShown, canOpenRight: shell.canOpenRight, left: layout.open.left };
  return (
    <header>
      <div data-testid="center">{shell.bar}</div>
      <p data-testid="shell">{JSON.stringify(facts)}</p>
      <button type="button" onClick={() => panes.pick('files')}>pick arquivos</button>
      <button type="button" onClick={() => panes.pick('details')}>pick detalhes</button>
    </header>
  );
}

function Window() {
  const terminals = [shellA];
  const work = withPointedWork({ tasks: [taskA], workers: [], terminals, ...localPairs(['hive']) }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA]} workers={[]} terminals={terminals}
      liveActivities={work.activities} activityRecords={work.activityRecords} search={{ state: stateOf([taskA], { terminals }) }}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={(shell) => <Probe shell={shell} />}
      activityBar={(activity) => <div data-activity-bar>{activity.kind === 'task' ? activity.task.item.title : 'local'}</div>}
    >
      <main>fluxo</main>
    </MainDock>
  );
}

const shell = (): unknown => JSON.parse(screen.getByTestId('shell').textContent ?? 'null');
const railButton = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'views' })).getByRole('button', { name });
const openActivity = (name: RegExp): void => { fireEvent.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByRole('button', { name })); };
const pick = (name: string): void => { fireEvent.click(screen.getByRole('button', { name })); };
// toggleLeft and toggleRight off macOS (#452, #585)
const sideKey = (side: 'left' | 'right'): void => { fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true, altKey: side === 'right' }); };

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetViewState();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('with an activity open its bar is in the header and none sits over the center; the home and the flow leave the center column empty (#221)', () => {
  render(<Window />);
  expect(screen.getByTestId('center')).toBeEmptyDOMElement(); // the home
  openActivity(/#1 Task A/);
  const bars = document.querySelectorAll<HTMLElement>('[data-activity-bar]');
  expect(bars).toHaveLength(1);
  expect(screen.getByRole('banner')).toContainElement(bars[0]);
  expect(within(screen.getByTestId('center')).getByText('Task A')).toBeInTheDocument();
  fireEvent.click(railButton('fluxo')); // the pick stays under the flow, its bar does not
  expect(screen.getByTestId('center')).toBeEmptyDOMElement();
});

test('the shell\'s panes: none on the home; both on a task\'s activity, the active one closing the side and another opening it on its pane; arquivos alone on a local one; detalhes alone under the flow (#221)', () => {
  resetViewState({ dockLayout: DETAIL_RIGHT });
  render(<Window />);
  expect(shell()).toEqual({ active: null, enabled: { files: false, details: false }, rightShown: false, canOpenRight: false, left: true });
  openActivity(/#1 Task A/);
  expect(shell()).toEqual({ active: 'files', enabled: { files: true, details: true }, rightShown: true, canOpenRight: true, left: true });
  pick('pick detalhes');
  expect(shell()).toMatchObject({ active: 'details', rightShown: true });
  pick('pick detalhes'); // the active one: the side closes, as the group's × does
  expect(shell()).toMatchObject({ active: 'details', rightShown: false });
  pick('pick arquivos'); // an inactive one: the side opens on it
  expect(shell()).toMatchObject({ active: 'files', rightShown: true });
  openActivity(/^local/);
  expect(shell()).toMatchObject({ active: 'files', enabled: { files: true, details: false }, rightShown: true });
  fireEvent.click(railButton('fluxo'));
  expect(shell()).toMatchObject({ active: 'details', enabled: { files: false, details: true }, rightShown: true });
});

test('Cmd+B and Cmd+Shift+B still toggle the sides, and the shell follows (#452, #221)', () => {
  resetViewState({ dockLayout: DETAIL_RIGHT });
  render(<Window />);
  fireEvent.click(railButton('fluxo'));
  expect(shell()).toMatchObject({ rightShown: true, left: true });
  sideKey('right');
  expect(shell()).toMatchObject({ rightShown: false });
  sideKey('right');
  expect(shell()).toMatchObject({ rightShown: true });
  sideKey('left');
  expect(shell()).toMatchObject({ left: false });
  sideKey('left');
  expect(shell()).toMatchObject({ left: true });
});
