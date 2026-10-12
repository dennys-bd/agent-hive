// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx. sonner is mocked so a refusal's toast needs no Toaster.
import { toast } from 'sonner';
import { afterEach, expect, test, vi } from 'vitest';
import { continueSleeping, wakeTerminal } from '@/components/sleeping-run';
import type { Activity } from '@/lib/activities';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

// Only what continueSleeping reads: a local activity with one sleeping run
const LOCAL = { kind: 'local', workspace: 'hive', slept: [{ run: { ptyId: 'W1' }, sessionId: 'S1' }] } as unknown as Activity;

test('a continue the server refuses releases the sleeping tab\'s hold, and hands it over nowhere (#672)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no' }), { status: 409, headers: { 'content-type': 'application/json' } })));
  const ops = { holdRun: vi.fn(), replaceRun: vi.fn(), releaseRun: vi.fn() };
  continueSleeping(LOCAL, 'W1', ops);
  expect(ops.holdRun).toHaveBeenCalledWith('W1');
  await vi.waitFor(() => expect(ops.releaseRun).toHaveBeenCalledWith('W1'));
  expect(ops.replaceRun).not.toHaveBeenCalled();
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

// A local activity whose codex run the Hive put to sleep before its first prompt (#931): an agent, no session
const FRESH = { kind: 'local', workspace: 'hive', slept: [{ run: { ptyId: 'W1', label: 'Codex', kind: 'session', agent: 'codex' } }] } as unknown as Activity;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a sleeping run with an agent and no session opens a new session of that agent, which takes its tab, then forgets the old record (#931)', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => json(String(url).endsWith('/sessions') ? { ok: true, ptyId: 'W9' } : { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const ops = { holdRun: vi.fn(), replaceRun: vi.fn(), releaseRun: vi.fn() };
  continueSleeping(FRESH, 'W1', ops);
  expect(ops.holdRun).toHaveBeenCalledWith('W1');
  await vi.waitFor(() => expect(ops.replaceRun).toHaveBeenCalledWith('W1', 'W9'));
  const calls = fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method, init?.method === 'POST' ? (JSON.parse(String(init.body)) as { kind?: string }).kind : undefined]);
  expect(calls).toEqual([['/activities/local%3Ahive/sessions', 'POST', 'codex'], ['/ptys/W1/scrollback', 'DELETE', undefined]]);
  expect(ops.releaseRun).not.toHaveBeenCalled();
});

test('a new session the server refuses releases the fresh tab and forgets nothing (#931)', async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ error: 'no' }, 409));
  vi.stubGlobal('fetch', fetchMock);
  const ops = { holdRun: vi.fn(), replaceRun: vi.fn(), releaseRun: vi.fn() };
  continueSleeping(FRESH, 'W1', ops);
  await vi.waitFor(() => expect(ops.releaseRun).toHaveBeenCalledWith('W1'));
  expect([ops.replaceRun.mock.calls, fetchMock.mock.calls.map(([, init]) => init?.method)]).toEqual([[], ['POST']]);
});
