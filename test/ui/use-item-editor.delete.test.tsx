import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { CatalogueItem } from '../../src/types';
import { useItemEditor } from '@/hooks/use-item-editor';
import { usePlugins } from '@/hooks/use-plugins';
import { BUILD_TEXT, CATALOGUE, itemOf, type ItemsServer, json, readOf, stubItems, versionOf } from './plugins-fixtures';

afterEach(() => vi.unstubAllGlobals());

const OWN_TEXT = '---\nname: own\ndescription: checks\n---\nCheck.\n';
const ownOf = (names: readonly string[]): CatalogueItem =>
  itemOf('hive:own', { userCreated: true, state: 'customized', versions: names.map((name) => versionOf(name, { from: null })) });
const OWN_READS = Object.fromEntries(['mine', 'tdd', 'fast'].map((v) => [`hive:own@${v}`, readOf('hive:own', v, { 'SKILL.md': OWN_TEXT })]));
const isDelete = ([, init]: [string, RequestInit?]): boolean => init?.method === 'DELETE';

function useBoth() {
  const plugins = usePlugins(true);
  return { plugins, editor: useItemEditor(plugins) };
}
async function opened(id: string) {
  const hook = renderHook(useBoth);
  await waitFor(() => expect(hook.result.current.plugins.items).toBeDefined());
  act(() => hook.result.current.plugins.open({ kind: 'item', id }));
  await waitFor(() => expect(hook.result.current.editor.read?.item.id).toBe(id));
  return hook;
}
// The store's delete of one version, as GET /api/items answers it after it: the item listed without it
function dropping(server: ItemsServer): NonNullable<ItemsServer['revert']> {
  return (id, version) => {
    server.catalogue = server.catalogue.map((i) => (i.id === id ? { ...i, versions: i.versions.filter((v) => v.name !== version) } : i));
    return json(server.catalogue.find((i) => i.id === id));
  };
}

test('deleteVersion on a Hive item sends the DELETE, reads the catalogue again and opens the original (#983)', async () => {
  const original = readOf('hive:new-build', null, { 'SKILL.md': 'the original\n' });
  const server: ItemsServer = { catalogue: CATALOGUE, reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT }), 'hive:new-build@': original } };
  server.revert = dropping(server);
  const mock = stubItems(server);
  const { result } = await opened('hive:new-build');
  const reads = (): number => mock.mock.calls.filter(([path]) => path === '/api/items').length;
  const before = reads();
  let answer: unknown = 'unset';
  await act(async () => { answer = await result.current.editor.deleteVersion(); });
  expect(answer).toBeUndefined();
  expect(mock.mock.calls.filter(isDelete).map(([path]) => path)).toEqual(['/api/items/hive%3Anew-build/versions/mine']);
  expect(reads()).toBe(before + 1);
  expect([result.current.editor.version, result.current.editor.read?.version, result.current.editor.path]).toEqual([null, null, 'SKILL.md']);
});

test('deleteVersion on a user-created item opens mine when it is left, else its first version, and never reads an original it has none of (#983)', async () => {
  const server: ItemsServer = { catalogue: [...CATALOGUE, ownOf(['mine', 'tdd', 'fast'])], reads: OWN_READS };
  server.revert = dropping(server);
  const mock = stubItems(server);
  const { result } = await opened('hive:own');
  act(() => result.current.editor.openVersion('tdd'));
  await waitFor(() => expect(result.current.editor.read?.version).toBe('tdd'));
  await act(async () => { await result.current.editor.deleteVersion(); });
  await waitFor(() => expect(result.current.editor.read?.version).toBe('mine'));
  await act(async () => { await result.current.editor.deleteVersion(); });
  await waitFor(() => expect(result.current.editor.read?.version).toBe('fast'));
  expect(mock.mock.calls.filter(isDelete).map(([path]) => path)).toEqual(['/api/items/hive%3Aown/versions/tdd', '/api/items/hive%3Aown/versions/mine']);
  expect(mock.mock.calls.some(([path]) => path === '/api/items/hive%3Aown')).toBe(false);
  expect(result.current.editor.error).toBeUndefined();
});

test("deleting a user-created item's last version takes the item: the 204 is not read again, the section's list opens and no note is set (#983)", async () => {
  const server: ItemsServer = { catalogue: [...CATALOGUE, ownOf(['mine'])], reads: OWN_READS };
  server.revert = (id) => {
    server.catalogue = server.catalogue.filter((i) => i.id !== id);
    return new Response(null, { status: 204 });
  };
  const mock = stubItems(server);
  const { result } = await opened('hive:own');
  let answer: unknown = 'unset';
  await act(async () => { answer = await result.current.editor.deleteVersion(); });
  expect(answer).toBeUndefined();
  expect(result.current.plugins.screen).toEqual({ kind: 'list', section: 'skills' });
  expect(result.current.plugins.items?.some((i) => i.id === 'hive:own')).toBe(false);
  const after = mock.mock.calls.slice(mock.mock.calls.findIndex(isDelete) + 1).map(([path]) => path);
  expect(after.filter((path) => path.startsWith('/api/items/'))).toEqual([]);
  expect([result.current.editor.item, result.current.editor.error]).toEqual([undefined, undefined]);
});

test('a refused delete answers its copy and leaves the version open (#983)', async () => {
  stubItems({ catalogue: [...CATALOGUE, ownOf(['mine', 'tdd'])], reads: OWN_READS, revert: () => json({ error: 'in use', code: 'in_use' }, 409) });
  const { result } = await opened('hive:own');
  let answer: unknown;
  await act(async () => { answer = await result.current.editor.deleteVersion(); });
  expect([answer, result.current.editor.version, result.current.plugins.screen]).toEqual(['plugins.delete.failed', 'mine', { kind: 'item', id: 'hive:own' }]);
});
