// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx. sonner is mocked so a refusal's toast needs no Toaster.
import { afterEach, expect, test, vi } from 'vitest';
import { continueSleeping } from '@/components/sleeping-run';
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
