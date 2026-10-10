import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { wakeTerminal } from '@/components/sleeping-run';
import type { LocalActivity } from '@/lib/activities';
import type { CenterLayout } from '@/lib/center-layout';
import { wakeLayout } from '@/lib/wake';
import { localPairOf } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const posts = (): string[] => fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
const T0 = '2026-10-03T10:00:00.000Z';
const KEPT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const session = (id: string) => ({ id, startedAt: T0, stages: [], lastUsedAt: T0 });
// hive's local activity asleep: two kept sessions and two kept terminals, one of each in no tab
const sleeping: LocalActivity = {
  kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], sleeping: true,
  kept: [{ session: session(KEPT), status: 'empty' }, { session: session(OTHER), status: 'empty' }],
  terminals: [{ terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: true }, { terminalId: 'T2', label: 'Terminal 2', n: 2, asleep: true }],
};
const LAYOUT: CenterLayout = {
  root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'T1' }, { kind: 'run', ptyId: 'W1', sessionId: KEPT }, { kind: 'console' }], active: 0 },
  focused: 'g1',
};
const ops = () => ({ holdRun: vi.fn(), replaceRun: vi.fn(), releaseRun: vi.fn() });

beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('picking a sleeping activity wakes each terminal its layout holds and continues each session a tab names, holding the tab; the rest sleeps on (#696)', async () => {
  const held = ops();
  wakeLayout(sleeping, LAYOUT, held);
  expect(posts()).toEqual(['/terminals/T1/wake', `/activities/local%3Ahive/sessions/${KEPT}/open`]);
  expect(held.holdRun).toHaveBeenCalledWith('W1');
  await vi.waitFor(() => expect(held.releaseRun).toHaveBeenCalledWith('W1')); // the stub answers no run: the hold goes
});

test('an awake activity, or one with no stored layout, wakes nothing (#696)', () => {
  wakeLayout({ ...sleeping, sleeping: false }, LAYOUT, ops());
  wakeLayout(sleeping, undefined, ops());
  expect(posts()).toEqual([]);
});

test('a wake refused with 409 (already awake, or its old pty still ending) is harmless: no toast, no run; any other refusal shows its reason (#696)', async () => {
  const answer = (status: number, error: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })));
  vi.mocked(toast.error).mockClear();
  answer(409, 'o terminal não está dormindo');
  expect(await wakeTerminal('T1')).toBeUndefined();
  expect(toast.error).not.toHaveBeenCalled();
  answer(422, 'o terminal não pode acordar');
  expect(await wakeTerminal('T1')).toBeUndefined();
  expect(toast.error).toHaveBeenCalledWith('o terminal não pode acordar');
});
