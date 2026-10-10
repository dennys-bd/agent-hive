import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useItemFields } from '@/hooks/use-item-fields';
import type { ItemField } from '../../src/types';

const field = (value: string): ItemField => ({ name: 'Priority', type: 'singleSelect', value, options: ['P0', 'P1'] });
const jsonRes = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ fields: [field('P1')] })));
});
afterEach(() => vi.unstubAllGlobals());

test('replace applies the answer of the item shown and drops one of an item no longer shown (#686)', async () => {
  const { result, rerender } = renderHook(({ itemId }) => useItemFields(itemId), { initialProps: { itemId: 'roadmap:PVTI_1' } });
  await waitFor(() => expect(result.current.fields).toEqual([field('P1')]));
  act(() => result.current.replace('roadmap:PVTI_1', [field('P0')]));
  expect(result.current.fields).toEqual([field('P0')]);
  rerender({ itemId: 'roadmap:PVTI_2' });
  await waitFor(() => expect(result.current.fields).toEqual([field('P1')]));
  act(() => result.current.replace('roadmap:PVTI_1', [field('P0')])); // a write of the first item answering late
  expect(result.current.fields).toEqual([field('P1')]);
});
