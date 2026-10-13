import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { Flow } from '@/components/Flow';
import { setLanguage, t } from '@/i18n';
import type { Task, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const task = (n: number): Task => ({
  item: { itemId: `I${n}`, id: String(n), title: `Task ${n}`, body: '', url: '' }, stage: 'spec', boardColumn: 'Backlog', auto: true,
});
const tasks = Array.from({ length: 12 }, (_, i) => task(i + 1));
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], stages: [{ name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' }], tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {},
  usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
};

function Dock() {
  return (
    <MainDock
      fileLinks={false} fontFamily="monospace" workspaces={['hive']} tasks={[]} workers={[]} terminals={[]} onSelect={vi.fn()} detail={() => <p>detalhes</p>}
      header={() => <header />}
    >
      <Flow state={state} />
    </MainDock>
  );
}

const search = (): HTMLElement => screen.getByLabelText(t('flow.search'));
const toActivities = (): void => { fireEvent.click(screen.getByRole('button', { name: 'atividades' })); };
const toFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); };

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

test('a typed task search survives a switch to Atividades and back (#596)', async () => {
  const user = userEvent.setup();
  render(<Dock />);
  toFlow();
  await user.type(search(), 'Task 3');
  toActivities();
  toFlow();
  expect(search()).toHaveValue('Task 3');
});

test('under Atividades the search tasks key leaves the hidden search box alone (#596)', () => {
  render(<Dock />);
  toFlow();
  toActivities();
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
  expect(document.body).toHaveFocus();
  toFlow();
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
  expect(search()).toHaveFocus();
});
