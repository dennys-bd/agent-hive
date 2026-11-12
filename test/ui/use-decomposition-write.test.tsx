import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { closeDecomposition, openDecomposition, useDecompositionWrite, useOpenDecomposition, writeDecomposition } from '@/hooks/use-decomposition-write';
import { setLanguage } from '@/i18n';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

// The decomposition write's store (#781): the write outlives the dialog, and its failure reaches a closed dialog as one toast.
const ID = 'a-I1';
const CHOICE = { source: 'board', column: 'Backlog' };
const TRANSIENT = 'O GitHub não respondeu. As issues já criadas ficam: clique em "criar issues" de novo para continuar de onde parou.';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let answer: () => Response | Promise<Response> = () => json({ ok: true });
const fetchMock = vi.fn(async () => answer());
const read = () => renderHook(() => ({ write: useDecompositionWrite(ID), open: useOpenDecomposition() }));
const actionOf = (options: unknown): { label: string; onClick(): void } => (options as { action: { label: string; onClick(): void } }).action;

beforeEach(() => {
  setLanguage('pt');
  answer = () => json({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('closing while the write runs sends no request and its promise still settles; a success shows nothing (#781)', async () => {
  let release = (): void => undefined;
  answer = () => new Promise((resolve) => { release = () => resolve(json({ ok: true })); });
  const { result } = read();
  let written: Promise<void> = Promise.resolve();
  act(() => { openDecomposition(ID, '#1'); written = writeDecomposition(ID, CHOICE); closeDecomposition(ID); });
  expect(result.current).toMatchObject({ write: { isOpen: false, isRunning: true }, open: undefined });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { release(); await written; });
  expect(result.current.write).toMatchObject({ isOpen: false, isRunning: false });
  expect(result.current.write.error).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
});

test('a second start while the write runs posts nothing (#781)', async () => {
  let release = (): void => undefined;
  answer = () => new Promise((resolve) => { release = () => resolve(json({ ok: true })); });
  act(() => openDecomposition(ID, '#1'));
  const first = writeDecomposition(ID, CHOICE);
  await writeDecomposition(ID, CHOICE);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { release(); await first; });
});

test('a write that fails with the dialog closed fires one error toast titled with the ref, the inline text as its description; reabrir opens it with the error and nothing running (#781)', async () => {
  answer = () => json({ error: 'stream error: REFUSED_STREAM', code: 'transient' }, 502);
  const { result } = read();
  await act(async () => { openDecomposition(ID, '#678'); const written = writeDecomposition(ID, CHOICE); closeDecomposition(ID); await written; });
  expect(toast.error).toHaveBeenCalledTimes(1);
  const [title, options] = vi.mocked(toast.error).mock.calls[0]!;
  expect([title, options?.description, actionOf(options).label]).toEqual(['A criação das issues de #678 parou', TRANSIENT, 'reabrir']);
  expect(result.current.write.error).toBe(TRANSIENT);
  expect(options?.id).toBe('decomposition-a-I1');
  act(() => actionOf(options).onClick());
  // reopened, the write keeps the choice it started with, so a second press resumes it there; the toast goes
  expect(result.current).toMatchObject({ open: ID, write: { isOpen: true, isRunning: false, error: TRANSIENT, choice: CHOICE } });
  expect(toast.dismiss).toHaveBeenCalledWith('decomposition-a-I1');
});

test('a failure with the dialog open stays in the store, with no toast: a 502 adds the recovery sentence, a 409 keeps the words alone (#781)', async () => {
  const { result } = read();
  act(() => openDecomposition(ID, '#1'));
  answer = () => json({ error: 'Resource not accessible by integration' }, 502);
  await act(() => writeDecomposition(ID, CHOICE));
  // a full stop joins words that carry none, as the screen shows
  expect(result.current.write.error).toBe('Resource not accessible by integration. As issues já criadas ficam: clique em "criar issues" de novo para continuar de onde parou.');
  answer = () => json({ error: 'as issues desta decomposição já estão sendo criadas' }, 409);
  await act(() => writeDecomposition(ID, CHOICE));
  expect(result.current.write).toMatchObject({ isOpen: true, isRunning: false, error: 'as issues desta decomposição já estão sendo criadas' });
  expect(toast.error).not.toHaveBeenCalled();
});

test('opening another activity\'s dialog closes the first, so a failure of its write toasts (#781)', async () => {
  answer = () => json({ error: 'Bad credentials' }, 502);
  const { result } = read();
  await act(async () => { openDecomposition(ID, '#1'); const written = writeDecomposition(ID, CHOICE); openDecomposition('a-I2', '#2'); await written; });
  expect(result.current).toMatchObject({ open: 'a-I2', write: { isOpen: false } });
  expect(toast.error).toHaveBeenCalledTimes(1);
});
