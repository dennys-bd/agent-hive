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
