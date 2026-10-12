import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CopySessionHost } from '@/components/CopySession';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { task, Center, resetCenterTest, seed, SESSION, SHELL } from './center-harness';
import { activityIdOf, withPointedWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Its own file: Radix's ContextMenu opens once per file under jsdom. The task's session is its record's (#629)
const S = 'abcdef12-0000-4000-8000-000000000001';
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's', status: 'working', runId: 'W2', activityId: activityIdOf('I1'), sessionId: S, freeSession: true }], terminals: [], stages: [],
  tasks: [{ ...task, workspace: 'hive', worktree: '/w/1' }], sourceOrder: [],
  localCount: 0, activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions: [{ id: S, startedAt: '', stages: ['dev'], agent: 'claude', lastUsedAt: '' }] }], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

test('an agent tab\'s right-click adds copiar para… after its own items; a terminal\'s does not (#587)', async () => {
  seed({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W2' }, { kind: 'run', ptyId: 'W3' }], active: 0 }, focused: 'g1' });
  render(<CopySessionHost state={state}><Center runs={[SESSION, SHELL]} /></CopySessionHost>);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Claude · abcdef12' }));
  expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['Dividir à direita', 'Dividir abaixo', 'copiar para…', 'Fechar']);
});
