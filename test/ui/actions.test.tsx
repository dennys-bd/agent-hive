// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx. sonner is mocked so the toast text is observable without a Toaster.
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, actThen, attachRun, continueTaskSession, focusOrOpen, focusRun, stageMoves } from '@/components/actions';
import { localRunTab, type RunTab } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { shownSize, trackTerminal } from '@/lib/xterm-setup';
import type { Terminal } from '@xterm/xterm';
import type { Stage, Task } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const failing = (status: number, error: string) =>
  vi.fn(async () => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }));

beforeEach(() => { setLanguage('pt'); vi.mocked(toast.error).mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const TAB: RunTab = { ptyId: 'W1', kind: 'session', task: 'board:I1', title: '#1 X' };
const TASK: Task = { item: { itemId: 'board:I1', id: '1', title: 'X', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };

test('focusRun asks focusTab with the run\'s activity key and pty id: true opens no tab; false, a rejection or a partial bridge opens it; a plain browser opens at once; it never fetches (#554, #251)', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const openTab = vi.fn();
  focusRun(TAB, openTab);
  expect(openTab).toHaveBeenCalledWith(TAB);
  const focusTab = vi.fn(async (_activity: string, _key: string) => true);
  vi.stubGlobal('hive', { focusTab });
  focusRun(TAB, openTab);
  expect(focusTab).toHaveBeenCalledWith('board:I1', 'W1'); // asked before the click returns
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(openTab).toHaveBeenCalledTimes(1);
  focusTab.mockResolvedValueOnce(false);
  focusRun(TAB, openTab);
  await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(2));
  focusTab.mockRejectedValueOnce(new Error('main window not found'));
  focusRun(TAB, openTab);
  await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(3));
  vi.stubGlobal('hive', {}); // a partial bridge: its throw counts as no window
  focusRun(TAB, openTab);
  await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(4));
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a workspace\'s run asks for its local activity; attachRun focuses the run POST /open answered and opens no tab (#554, #590, #249)', async () => {
  const focusTab = vi.fn(async (_activity: string, _key: string) => true);
  vi.stubGlobal('hive', { focusTab });
  const openTab = vi.fn();
  focusRun(localRunTab('P1', 'hive'), openTab);
  attachRun({ ok: true, ptyId: 'W1' }, TASK, 'session', openTab);
  expect(focusTab.mock.calls).toEqual([['local/hive', 'P1'], ['board:I1', 'W1']]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(openTab).not.toHaveBeenCalled();
});

test('focusOrOpen opens at once in a plain browser and calls open only once focusTab answers false (#554)', async () => {
  const open = vi.fn();
  focusOrOpen('I1', 'file:src/a.ts', open);
  expect(open).toHaveBeenCalledTimes(1);
  vi.stubGlobal('hive', { focusTab: vi.fn(async () => false) });
  focusOrOpen('I1', 'file:src/a.ts', open);
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
});

test('attachRun opens the run POST /open answered as the task\'s session or terminal; nothing without a run (#249, #378)', async () => {
  vi.stubGlobal('hive', { focusTab: vi.fn(async () => false) });
  const openTab = vi.fn();
  attachRun({ ok: true, ptyId: 'W1' }, TASK, 'terminal', openTab);
  await vi.waitFor(() => expect(openTab).toHaveBeenCalledWith({ ptyId: 'W1', kind: 'terminal', task: 'board:I1', title: '#1 X' }));
  attachRun({ ok: true }, TASK, 'session', openTab); // a spawn failure: no run to attach
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(openTab).toHaveBeenCalledTimes(1);
});

test('act resolves (never rejects) even when the request fails, and still toasts the error (#121)', async () => {
  vi.stubGlobal('fetch', failing(500, 'boom'));
  await expect(act('/sources/refresh')).resolves.toBeUndefined();
  expect(toast.error).toHaveBeenCalledWith('boom');
});

test('act resolves with the answer\'s body on success, so a caller that needs it (POST /open\'s run, #249) can read it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, ptyId: 'W1' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  await expect(act('/tasks/I1/open')).resolves.toEqual({ ok: true, ptyId: 'W1' });
});

test('a continued session posts the grid of the terminal shown with its open, and actThen sends the body it is given (#808)', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: 800 });
  Object.defineProperty(element, 'clientHeight', { value: 600 });
  const untrack = trackTerminal('W7', { cols: 132, rows: 41, element } as unknown as Terminal);
  continueTaskSession(TASK, { activityId: 'a-I1', sessionId: 'S1' });
  await actThen('/activities/a-I1/continue', undefined, { size: shownSize() });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  untrack();
  const sent = fetchMock.mock.calls.map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);
  expect(sent).toEqual([
    ['/activities/a-I1/sessions/S1/open', { size: { cols: 132, rows: 41 } }],
    ['/activities/a-I1/continue', { size: { cols: 132, rows: 41 } }],
  ]);
});

test('stageMoves lists every stage but the task\'s own, in order, each posting move-to with its name (#916)', async () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const stage = (name: string): Stage => ({ name, from: {}, prompt: '/x' });
  const moves = stageMoves(TASK, { stages: [stage('spec'), stage('dev'), stage('review')] });
  expect(moves.map((m) => m.stage)).toEqual(['spec', 'review']);
  moves[1].move();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/board%3AI1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review' }) })));
});
