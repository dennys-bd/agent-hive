import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { ARCHIVED, DONE, DRAFT, EXPERIMENTS, MCP_DRAFT, RUNNING, stubBenchmarkFetch } from './benchmark-fixtures';
import { experiment } from '../benchmark/fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });
const hook = (experiments: Experiment[]) => renderHook(({ list }) => useBenchmark(list), { initialProps: { list: experiments } });

test('first open selects the first row of the first group, on braços; no live experiment is the empty state (#461)', () => {
  const { result } = hook(EXPERIMENTS);
  expect([result.current.selected?.id, result.current.tab]).toEqual([RUNNING.id, 'arms']);
  expect(hook([ARCHIVED]).result.current.selected).toBeUndefined();
});

test('with only archived experiments, picking one in the archived group selects it, so it can be unarchived (#461)', () => {
  const { result } = hook([ARCHIVED]);
  act(() => result.current.select(ARCHIVED.id));
  expect(result.current.selected?.id).toBe(ARCHIVED.id);
});

test('experimento vazio and duplicar post kind empty / duplicate and select the answer once the state holds it (#461)', async () => {
  const calls = stubBenchmarkFetch();
  const { result, rerender } = hook(EXPERIMENTS);
  await act(() => result.current.createEmpty('hive-site'));
  await act(() => result.current.duplicate(DONE.id));
  expect(calls).toEqual([
    { method: 'POST', path: '/benchmark/experiments', body: { kind: 'empty', workspace: 'hive-site' } },
    { method: 'POST', path: '/benchmark/experiments', body: { kind: 'duplicate', of: DONE.id } },
  ]);
  rerender({ list: [...EXPERIMENTS, experiment({ id: 'new-1', name: 'novo' })] });
  expect(result.current.selected?.id).toBe('new-1');
});

test('rename and archive patch the experiment; delete sends DELETE and selects the next row, else the previous (#461)', async () => {
  const calls = stubBenchmarkFetch();
  const { result } = hook(EXPERIMENTS);
  await act(() => result.current.rename(DRAFT.id, 'opus no plan 2'));
  await act(() => result.current.setArchived(DRAFT.id, true));
  await act(() => result.current.remove(DRAFT.id));
  expect(calls).toEqual([
    { method: 'PATCH', path: `/benchmark/experiments/${DRAFT.id}`, body: { name: 'opus no plan 2' } },
    { method: 'PATCH', path: `/benchmark/experiments/${DRAFT.id}`, body: { archived: true } },
    { method: 'DELETE', path: `/benchmark/experiments/${DRAFT.id}` },
  ]);
  expect(result.current.selected?.id).toBe(MCP_DRAFT.id);
});

test("a refusal is a toast in the user's language, never the server's words, and changes no selection (#461)", async () => {
  stubBenchmarkFetch(409);
  const { result } = hook(EXPERIMENTS);
  await act(() => result.current.remove(RUNNING.id));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('o experimento está executando ou dormindo'));
  expect(result.current.selected?.id).toBe(RUNNING.id);
});
