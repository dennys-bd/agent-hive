import { toast } from 'sonner';
import { afterEach, expect, test, vi } from 'vitest';
import { act } from '@/components/actions';
import { sendJson, setWriteGate, WriteCancelled } from '@/lib/api';
import { jsonResponse } from '../fakes';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
afterEach(() => { setWriteGate(undefined); vi.unstubAllGlobals(); fetchMock.mockClear(); vi.mocked(toast.error).mockClear(); });

test('a gate that rejects stops the fetch; one that resolves lets it go and hears written after the answer; a /view-state/ write never asks (#469)', async () => {
  vi.stubGlobal('fetch', fetchMock);
  const asked: string[] = [];
  let isAllowed = false;
  let written = 0;
  setWriteGate({ ask: async (path) => { asked.push(path); if (!isAllowed) throw new WriteCancelled('cancelled'); }, written: () => { written += 1; } });
  await expect(sendJson('POST', '/signal', { signal: 'red' })).rejects.toBeInstanceOf(WriteCancelled);
  expect([fetchMock.mock.calls.length, written]).toEqual([0, 0]);
  isAllowed = true;
  await sendJson('POST', '/signal', { signal: 'red' });
  expect([fetchMock.mock.calls.length, written]).toEqual([1, 1]);
  await sendJson('POST', '/view-state/dockLayout', { value: {} });
  expect(asked).toEqual(['/signal', '/signal']);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('without a gate a write goes out in the same tick, as before run mode (#469)', () => {
  vi.stubGlobal('fetch', fetchMock);
  void sendJson('POST', '/signal', { signal: 'red' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('act drops a cancel without a toast and still toasts any other refusal, a frozen run\'s included (#469)', async () => {
  vi.stubGlobal('fetch', fetchMock);
  setWriteGate({ ask: () => Promise.reject(new WriteCancelled('intervenção cancelada')), written: () => undefined });
  expect(await act('/signal')).toBeUndefined();
  expect(toast.error).not.toHaveBeenCalled();
  setWriteGate({ ask: () => Promise.reject(new Error('este run está congelado')), written: () => undefined });
  await act('/signal');
  expect(toast.error).toHaveBeenCalledWith('este run está congelado');
  expect(fetchMock).not.toHaveBeenCalled();
});
