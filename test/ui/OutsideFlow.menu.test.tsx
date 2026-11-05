import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OutsideFlow } from '@/components/tasks/OutsideFlow';
import type { DisplayControls } from '@/hooks/use-flow-view';
import { setLanguage } from '@/i18n';
import { DISPLAY_DEFAULTS, type DisplayOptions } from '@/lib/flow-view';
import type { BaseOptions, Item, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

// The outside-the-flow grid (#578). Radix's ContextMenu opens once per file under jsdom: one test here right-clicks, no other may
const STAGES: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
// #566: no stage is outside the flow; a branch gives the task an activity, so it is started (#568)
const task = (id: string, extra: Partial<WithWork> = {}, item: Partial<Item> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, boardColumn: 'Ready', auto: false, ...extra,
});
const started = (id: string, extra: Partial<WithWork> = {}, item: Partial<Item> = {}): WithWork => task(id, { branch: `hive/${id}-task-${id}`, ...extra }, item);
const state = (tasks: WithWork[], workspaces = ['hive']): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(STAGES, []), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces, sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const display = (options: Partial<DisplayOptions> = {}): DisplayControls => ({ options: { ...DISPLAY_DEFAULTS, ...options }, set: vi.fn() });
const show = (s: State, { options = {}, onOpen = vi.fn(), selectedId }: { options?: Partial<DisplayOptions>; onOpen?: (id: string) => void; selectedId?: string } = {}) =>
  render(<OutsideFlow state={s} display={display(options)} onOpen={onOpen} selectedId={selectedId} />);
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-task-id="I${id}"]`)!;
const BASES: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }; // what the Start dialog reads
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => reply(String(input).endsWith('/bases') ? BASES : { ok: true }))); });
afterEach(() => vi.unstubAllGlobals());

test('a right-click on a card opens the menu with levar ao fluxo… in place of the flow items (#578, #576)', async () => {
  show(state([started('1')]));
  fireEvent.contextMenu(card('1'));
  expect(await screen.findByRole('menuitem', { name: 'levar ao fluxo…' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'mover para etapa' })).not.toBeInTheDocument();
});
