import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { CopySessionHost } from '@/components/CopySession';
import { LocalSessionLines } from '@/components/SessionLines';
import { setLanguage } from '@/i18n';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

// Its own file: Radix's ContextMenu opens once per file under jsdom
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const sessions = [{ id: S, startedAt: '', stages: [], agent: 'claude' as const, lastUsedAt: '', name: 'no main' }];
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [], tasks: [], activities: [{ id: 'local:hive', kind: 'local', workspace: 'hive' }], activityRecords: [{ id: 'local:hive', taskIds: [], sessions }], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, usage: [], budget: {},
  usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click on a stopped local session: copiar para… ›, then limpar in the destructive colour, which posts the clear (#587)', async () => {
  render(<CopySessionHost state={state}><LocalSessionLines workspace="hive" sessions={sessions} workers={[]} runs={[]} onOpenRun={vi.fn()} /></CopySessionHost>);
  fireEvent.contextMenu(screen.getByRole('button', { name: /^claude/ }));
  expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['copiar para…', 'limpar']);
  expect(screen.getByRole('menuitem', { name: 'limpar' })).toHaveClass('text-destructive');
  fireEvent.click(screen.getByRole('menuitem', { name: 'limpar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/local%3Ahive/sessions/${S}/clear`, expect.objectContaining({ method: 'POST' })));
});
