import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import { DEFAULT_DOCK_LAYOUT, inEveryView } from '@/lib/dock-layout';
import { resetViewState } from '@/lib/view-state';
import type { Worker } from '../../src/types';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/w/a' };
const worker = (status: Worker['status']): Worker => ({ id: 's1', activityId: activityIdOf('A'), status, runId: 'W1', waitingSince: '2026-10-12T10:00:00.000Z' });

function Window({ workers = [] as Worker[], openSettings }: { workers?: Worker[]; openSettings?: () => void }) {
  const work = withPointedWork({ tasks: [taskA], workers, terminals: [], activities: [], activityRecords: [] }); // #629: what the runs point at
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA]} workers={workers} terminals={[]}
      liveActivities={work.activities} activityRecords={work.activityRecords} search={{ state: stateOf([taskA], { workers }), openSettings }}
      onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={() => <header />}
    >
      <main>fluxo</main>
    </MainDock>
  );
}

const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'views' });
const railButton = (name: string): HTMLElement => within(rail()).getByRole('button', { name });
const hasDot = (): boolean => railButton('atividades').querySelector('[data-waiting-dot]') !== null;

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetViewState();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('with a header the rail is the first thing left of the dock in both views, and a click switches the view as Ctrl+1 / Ctrl+2 do (#220)', () => {
  render(<Window />);
  const atLeft = (): void => {
    expect(rail().parentElement?.firstElementChild).toBe(rail());
    expect(rail().nextElementSibling).toContainElement(screen.getByRole('main', { hidden: true })); // DockFrame, the flow inside it
  };
  atLeft();
  expect(railButton('atividades')).toHaveAttribute('aria-current', 'page'); // the window opens on Atividades (#746)
  fireEvent.click(railButton('fluxo'));
  expect(screen.getByRole('main')).toHaveTextContent('fluxo'); // the board is the center
  expect(railButton('fluxo')).toHaveAttribute('aria-current', 'page');
  expect(railButton('atividades')).not.toHaveAttribute('aria-current');
  atLeft();
  fireEvent.click(railButton('atividades'));
  expect(screen.getByRole('main', { hidden: true })).not.toBeVisible();
  expect(railButton('atividades')).toHaveAttribute('aria-current', 'page');
});

test('with the left side collapsed only the left group goes: the rail stays (#220)', () => {
  resetViewState({ dockLayout: { ...DEFAULT_DOCK_LAYOUT, open: inEveryView({ left: false, right: false }) } });
  render(<Window />);
  expect(screen.getByRole('navigation', { name: 'Atividades', hidden: true })).not.toBeVisible(); // the left group's list
  expect(rail()).toBeVisible();
  fireEvent.click(railButton('fluxo'));
  expect(rail()).toBeVisible();
});

test('the activities icon carries the dot while a session is waiting or awaiting approval, and none while every one works or none exists (#220)', () => {
  const { rerender } = render(<Window workers={[worker('waiting')]} />);
  expect(hasDot()).toBe(true);
  rerender(<Window workers={[worker('approval')]} />);
  expect(hasDot()).toBe(true);
  rerender(<Window workers={[worker('working')]} />);
  expect(hasDot()).toBe(false);
  rerender(<Window />);
  expect(hasDot()).toBe(false);
});

test('the keyboard button opens the shortcut map as Ctrl+/ does; the settings button opens Settings (#220, #639)', async () => {
  const user = userEvent.setup();
  const openSettings = vi.fn();
  render(<Window openSettings={openSettings} />);
  await user.click(railButton('mapa de atalhos'));
  expect(screen.getByRole('dialog', { name: 'atalhos' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'atalhos' })).not.toBeInTheDocument();
  await user.click(railButton('configurações'));
  expect(openSettings).toHaveBeenCalledOnce();
});

test('without a header, as in the terminal\'s harness, there is no rail (#220)', () => {
  render(
    <MainDock fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[]} workers={[]} terminals={[]} onSelect={vi.fn()} detail={() => <p>detalhes</p>}>
      <main>fluxo</main>
    </MainDock>,
  );
  expect(screen.queryByRole('navigation', { name: 'views' })).not.toBeInTheDocument();
});
