import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { addVariable, moveBlock, setVariableValue } from '../../src/template-edit';
import { useItemEditor } from '@/hooks/use-item-editor';
import { usePlugins } from '@/hooks/use-plugins';
import type { MessageKey } from '@/i18n';
import { BUILD_TEXT, CATALOGUE, itemOf, type ItemsServer, json, readOf, type SaveBody, SPEC_TEXT, stubItems } from './plugins-fixtures';

afterEach(() => vi.unstubAllGlobals());

const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT, 'scripts/slice.py': 'print(1)\n' });
const SPEC = readOf('hive:new-spec', null, { 'SKILL.md': SPEC_TEXT });
const DEPLOY = readOf('hive-site:deploy', null, { 'SKILL.md': '---\nname: deploy\n---\nShip.\n' });
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': BUILD, 'hive:new-spec@': SPEC, 'hive-site:deploy@': DEPLOY }, ...extra });

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
const reopen = async (result: { current: ReturnType<typeof useBoth> }, id: string): Promise<void> => {
  act(() => result.current.plugins.open({ kind: 'item', id }));
  await waitFor(() => expect(result.current.editor.read?.item.id).toBe(id));
};

test('an item opens its mine, else the original, on its main file; a read the server refuses fails the item (#319, decision 4)', async () => {
  const mock = stubItems(serverOf());
  const { result } = await opened('hive:new-build');
  expect(mock).toHaveBeenCalledWith('/api/items/hive%3Anew-build?version=mine');
  const { editor } = result.current;
  expect([editor.path, editor.textOf('SKILL.md.liquid'), editor.isDirty('SKILL.md.liquid'), editor.mode, editor.viewAs]).toEqual(['SKILL.md.liquid', BUILD_TEXT, false, 'visual', undefined]);
  await reopen(result, 'hive:new-spec');
  expect(mock).toHaveBeenCalledWith('/api/items/hive%3Anew-spec');
  act(() => result.current.plugins.open({ kind: 'item', id: 'hive:new-plan' })); // its mine is not served: 404
  await waitFor(() => expect(result.current.editor.hasFailed).toBe(true));
});

test('edits live in a buffer per item and file: dirty, moved as moveBlock moves, a refused move a no-op, all kept across another item; collapse is per item (#319, decisions 6, 18, 20)', async () => {
  stubItems(serverOf());
  const { result } = await opened('hive:new-build');
  const edited = `${BUILD_TEXT}More.\n`;
  act(() => result.current.editor.edit(edited));
  expect(result.current.editor.isDirty('SKILL.md.liquid')).toBe(true);
  act(() => result.current.editor.move(11, 1));
  const moved = moveBlock(edited, 11, 1);
  if (!moved.ok) throw new Error(moved.error.message);
  expect(result.current.editor.textOf('SKILL.md.liquid')).toBe(moved.text);
  act(() => result.current.editor.move(14, 5));
  expect(result.current.editor.textOf('SKILL.md.liquid')).toBe(moved.text);
  act(() => result.current.editor.toggle(11));
  expect(result.current.editor.collapsed).toEqual([11]);
  await reopen(result, 'hive:new-spec');
  expect([result.current.editor.isDirty('SKILL.md'), result.current.editor.collapsed]).toEqual([false, []]);
  await reopen(result, 'hive:new-build');
  expect([result.current.editor.textOf('SKILL.md.liquid'), result.current.editor.collapsed]).toEqual([moved.text, [11]]);
});

test('save writes the open file to its version and settles it clean, then reads the catalogue again; a failed save shows its copy and keeps the buffer (#319, decisions 7, 8)', async () => {
  let refuse = false;
  const saves: SaveBody[] = [];
  const mock = stubItems(serverOf({ save: (_id, body) => {
    saves.push(body);
    return refuse ? json({ error: 'disk' }, 500) : json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text, 'scripts/slice.py': 'print(1)\n' }));
  } }));
  const { result } = await opened('hive:new-build');
  await act(() => result.current.editor.save()); // clean: nothing is written
  const changed = `${BUILD_TEXT}changed\n`;
  act(() => result.current.editor.edit(changed));
  await act(() => result.current.editor.save());
  expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: changed }]);
  expect([result.current.editor.isDirty('SKILL.md.liquid'), result.current.editor.textOf('SKILL.md.liquid')]).toEqual([false, changed]);
  expect(mock.mock.calls.filter(([path]) => path === '/api/items')).toHaveLength(2);
  refuse = true;
  act(() => result.current.editor.edit(`${BUILD_TEXT}again\n`));
  await act(() => result.current.editor.save());
  expect([result.current.editor.error, result.current.editor.isDirty('SKILL.md.liquid')]).toEqual(['plugins.editor.saveFailed', true]);
});

test("a Hive .md that now uses Liquid saves as .liquid from the .md; the tab takes the name and the note stays until a file opens; a workspace item is never renamed (#319, decision 9)", async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (id, body) => { saves.push(body); return json(readOf(id, 'mine', { [body.path]: body.text })); } }));
  const { result } = await opened('hive:new-spec');
  const text = `${SPEC_TEXT}Run in {{ workspace }}.\n`;
  act(() => result.current.editor.edit(text));
  await act(() => result.current.editor.save());
  expect(saves.at(-1)).toEqual({ version: null, path: 'SKILL.md.liquid', text, from: 'SKILL.md' });
  expect([result.current.editor.path, result.current.editor.renamedTo]).toEqual(['SKILL.md.liquid', 'SKILL.md.liquid']);
  act(() => result.current.editor.openFile('SKILL.md.liquid'));
  expect(result.current.editor.renamedTo).toBeUndefined();
  await reopen(result, 'hive-site:deploy');
  const shipped = '---\nname: deploy\ndescription: ships\n---\nShip {{ workspace }}.\n';
  act(() => result.current.editor.edit(shipped));
  await act(() => result.current.editor.save());
  expect(saves.at(-1)).toEqual({ version: null, path: 'SKILL.md', text: shipped });
});

test('a new file saves an empty file at its path and opens it; a taken path and a refused one answer their copy (#319, decision 13)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (_id, body) => {
    saves.push(body);
    return body.path === '../x' ? json({ error: 'bad path' }, 400) : json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT, [body.path]: '' }));
  } }));
  const { result } = await opened('hive:new-build');
  let refused: unknown = 'unset';
  await act(async () => { refused = await result.current.editor.newFile(' notes.md '); });
  expect([refused, saves, result.current.editor.path]).toEqual([undefined, [{ version: 'mine', path: 'notes.md', text: '' }], 'notes.md']);
  await act(async () => { refused = await result.current.editor.newFile('SKILL.md.liquid'); });
  expect(refused).toBe('plugins.file.taken');
  await act(async () => { refused = await result.current.editor.newFile('../x'); });
  expect(refused).toBe('plugins.file.badPath');
});

test("revert deletes the open version, opens the original on its main file and drops the version's buffers (#319, decision 12)", async () => {
  const original = readOf('hive:new-build', null, { 'SKILL.md': 'the original\n' });
  const mock = stubItems(serverOf({ reads: { 'hive:new-build@mine': BUILD, 'hive:new-build@': original }, revert: () => json(itemOf('hive:new-build')) }));
  const { result } = await opened('hive:new-build');
  act(() => result.current.editor.edit('unsaved\n'));
  await act(() => result.current.editor.revert());
  expect(mock.mock.calls.some(([path, init]) => path === '/api/items/hive%3Anew-build/versions/mine' && init?.method === 'DELETE')).toBe(true);
  expect([result.current.editor.read?.version, result.current.editor.path, result.current.editor.textOf('SKILL.md')]).toEqual([null, 'SKILL.md', 'the original\n']);
  expect(result.current.editor.isDirty('SKILL.md.liquid')).toBe(false);
});

test("only the item's main file needs a header: a skill's other file saves with none (#323)", async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (_id, body) => { saves.push(body); return json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT, [body.path]: body.text })); } }));
  const { result } = await opened('hive:new-build');
  act(() => result.current.editor.openFile('scripts/slice.py'));
  act(() => result.current.editor.edit('print(2)\n'));
  await act(() => result.current.editor.save());
  expect([saves, result.current.editor.error]).toEqual([[{ version: 'mine', path: 'scripts/slice.py', text: 'print(2)\n' }], undefined]);
});

test('applyEdit writes the buffer and saves it when it was clean, only writes it when it was dirty, and answers a refused edit as copy (#321, decisions 5, 15)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (_id, body) => {
    saves.push(body);
    return json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text, 'scripts/slice.py': 'print(1)\n' }));
  } }));
  const { result } = await opened('hive:new-build');
  const set = setVariableValue(BUILD_TEXT, 'delivery', 'agent-hive', 'stacked');
  if (!set.ok) throw new Error(set.error.message);
  let answer: MessageKey | undefined = 'plugins.variables.error.invalid';
  act(() => { answer = result.current.editor.applyEdit(set); });
  expect(answer).toBeUndefined();
  await waitFor(() => expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: set.text }]));
  await waitFor(() => expect(result.current.editor.isDirty('SKILL.md.liquid')).toBe(false));

  act(() => result.current.editor.edit(`${set.text}typed\n`));
  const again = setVariableValue(`${set.text}typed\n`, 'delivery', 'agent-hive', undefined);
  if (!again.ok) throw new Error(again.error.message);
  act(() => { result.current.editor.applyEdit(again); });
  expect([saves.length, result.current.editor.textOf('SKILL.md.liquid'), result.current.editor.isDirty('SKILL.md.liquid')]).toEqual([1, again.text, true]);

  expect([
    result.current.editor.applyEdit(setVariableValue(BUILD_TEXT, 'nobody', 'agent-hive', 'x')),
    result.current.editor.applyEdit(addVariable(BUILD_TEXT, { name: 'delivery' })),
    result.current.editor.applyEdit(addVariable(BUILD_TEXT, { name: 'workspace' })),
    result.current.editor.applyEdit(addVariable(BUILD_TEXT, { name: '2fast' })),
    result.current.editor.applyEdit(setVariableValue(BUILD_TEXT, 'delivery', 'agent-hive', 'trunk')),
  ]).toEqual(['plugins.variables.error.undeclared', 'plugins.variables.error.taken', 'plugins.variables.error.badName', 'plugins.variables.error.badName', 'plugins.variables.error.invalid']);
});

test("a Hive item with a version open reads its original once; the original open and a workspace item read none (#321, decision 10)", async () => {
  const original = readOf('hive:new-build', null, { 'SKILL.md': '---\nvariables:\n  delivery: { default: x }\n---\n{{ delivery }}\n' });
  const mock = stubItems(serverOf({ reads: { 'hive:new-build@mine': BUILD, 'hive:new-build@': original, 'hive:new-spec@': SPEC, 'hive-site:deploy@': DEPLOY } }));
  const { result } = await opened('hive:new-build');
  await waitFor(() => expect(result.current.editor.original).toEqual(original));
  await reopen(result, 'hive:new-spec');
  expect(result.current.editor.original).toBeUndefined();
  await reopen(result, 'hive-site:deploy');
  expect(result.current.editor.original).toBeUndefined();
  await reopen(result, 'hive:new-build');
  expect(result.current.editor.original).toEqual(original);
  expect(mock.mock.calls.filter(([path]) => path === '/api/items/hive%3Anew-build')).toHaveLength(1);
  expect(mock.mock.calls.filter(([path]) => path === '/api/items/hive%3Anew-spec')).toHaveLength(1); // its own read, no second one
});
