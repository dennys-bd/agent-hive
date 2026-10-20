import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { removeVariable } from '../../src/template-edit';
import type { AgentAnnotation } from '../../src/reviewer';
import { checkOf, isAgent, useAnnotations } from '@/hooks/use-annotations';
import { useItemEditor } from '@/hooks/use-item-editor';
import { usePlugins } from '@/hooks/use-plugins';
import { hasFix } from '@/lib/annotation-fix';
import { CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems, WORKSPACES } from './plugins-fixtures';

afterEach(() => vi.unstubAllGlobals());

// Lines: header 1–6 (depth declared on 5, never used), the title 7, the body from 9; TWO adds an undeclared reviewer on line 10
const DEPTH = '  depth: { default: full }';
const ONE = ['---', 'name: new-build', 'description: builds the plan', 'variables:', DEPTH, '---', '# new-build', '', 'Run it.', ''].join('\n');
const TWO = `${ONE}Ask {{ reviewer }}.\n`;
const DEPTH_KEY = `SKILL.md.liquid\0unused\0unused variable depth\0${DEPTH}`;
const echo = (_id: string, body: SaveBody): Response => json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text }));
const serverOf = (text: string, extra: Partial<ItemsServer> = {}): ItemsServer => ({
  catalogue: CATALOGUE, reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': text }) }, save: echo, ...extra,
});

function useAll() {
  const plugins = usePlugins(true);
  const editor = useItemEditor(plugins);
  return { plugins, editor, annotations: useAnnotations(editor, plugins.items, WORKSPACES) };
}
// new-build open, its dismissals read
async function opened() {
  const hook = renderHook(useAll);
  await waitFor(() => expect(hook.result.current.plugins.items).toBeDefined());
  act(() => hook.result.current.plugins.open({ kind: 'item', id: 'hive:new-build' }));
  await waitFor(() => expect(hook.result.current.annotations.canDismiss).toBe(true));
  return hook;
}

test("a declared, unused variable gives one yellow annotation; dismissing it drops it and saves its key, and editing its line's text brings it back (#327)", async () => {
  const server = serverOf(ONE);
  const mock = stubItems(server);
  const { result } = await opened();
  expect(result.current.annotations.list.map((a) => [a.line, a.severity, checkOf(a), isAgent(a) ? undefined : a.variable])).toEqual([[5, 'yellow', 'unused', 'depth']]);
  expect(mock).toHaveBeenCalledWith('/api/lint-input');
  act(() => result.current.annotations.dismiss(result.current.annotations.list[0]!));
  expect(result.current.annotations.list).toEqual([]);
  await waitFor(() => expect(server.dismissed).toEqual({ 'hive:new-build@mine': [DEPTH_KEY] }));
  act(() => result.current.editor.edit(ONE.replace(DEPTH, '  depth: { default: deep }')));
  expect(result.current.annotations.list.map(checkOf)).toEqual(['unused']);
});

test("applying an unused variable's fix removes its declaration, saving the clean buffer, and the annotation goes (#327)", async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf(ONE, { save: (id, body) => { saves.push(body); return echo(id, body); } }));
  const { result } = await opened();
  act(() => result.current.annotations.apply(result.current.annotations.list[0]!));
  const removed = removeVariable(ONE, 'depth');
  if (!removed.ok) throw new Error(removed.error.message);
  expect(result.current.annotations.list).toEqual([]);
  await waitFor(() => expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: removed.text }]));
});

test('next() opens the one after the open card, cycling, and reveals its line; close() closes it (#327)', async () => {
  stubItems(serverOf(TWO));
  const { result } = await opened();
  const steps: (number | undefined)[][] = [];
  for (let i = 0; i < 3; i += 1) {
    act(() => result.current.annotations.next());
    steps.push([result.current.annotations.open?.line, result.current.annotations.revealed?.line]);
  }
  expect(steps).toEqual([[5, 5], [10, 10], [5, 5]]);
  act(() => result.current.annotations.close());
  expect(result.current.annotations.open).toBeUndefined();
});

test('a dismissal the server holds hides its annotation on open; a failed write brings the dismissed one back with the error; nothing is linted under "view as" (#327)', async () => {
  stubItems(serverOf(TWO, { dismissed: { 'hive:new-build@mine': [DEPTH_KEY] }, putDismissed: () => json({ error: 'disk' }, 500) }));
  const { result } = await opened();
  expect(result.current.annotations.list.map(checkOf)).toEqual(['undeclared']);
  act(() => result.current.annotations.dismiss(result.current.annotations.list[0]!));
  expect(result.current.annotations.list).toEqual([]);
  await waitFor(() => expect(result.current.annotations.error).toBe('plugins.annotations.dismissFailed'));
  expect(result.current.annotations.list.map(checkOf)).toEqual(['undeclared']);
  act(() => result.current.editor.setViewAs('hive-site'));
  expect(result.current.annotations.list).toEqual([]);
});

test('two quick dismissals with the first write failing: the second stays hidden and is sent, the first comes back with the error, which a later write without it does not clear (#327)', async () => {
  const bodies: string[][] = [];
  let calls = 0;
  stubItems(serverOf(TWO, {
    putDismissed: (_id, body) => { bodies.push(body.keys); calls += 1; return calls === 1 ? json({ error: 'disk' }, 500) : json(body.keys); },
  }));
  const { result } = await opened();
  expect(result.current.annotations.list.map(checkOf)).toEqual(['unused', 'undeclared']);
  const [first, second] = result.current.annotations.list;
  act(() => { result.current.annotations.dismiss(first!); result.current.annotations.dismiss(second!); });
  expect(result.current.annotations.list).toEqual([]);
  await waitFor(() => expect(bodies).toHaveLength(2));
  await waitFor(() => expect(result.current.annotations.error).toBe('plugins.annotations.dismissFailed'));
  expect(result.current.annotations.list.map(checkOf)).toEqual(['unused']);
  expect(bodies[1]).toHaveLength(1);
  expect(bodies[1]).not.toContain(DEPTH_KEY);
  // dismissing the failed one again, now that writes work, clears the error
  act(() => result.current.annotations.dismiss(result.current.annotations.list[0]!));
  await waitFor(() => expect(result.current.annotations.error).toBeUndefined());
  expect(bodies[2]).toContain(DEPTH_KEY);
});

test('two quick dismissals both succeed: the last write carries both keys and no error shows (#327)', async () => {
  const bodies: string[][] = [];
  stubItems(serverOf(TWO, { putDismissed: (_id, body) => { bodies.push(body.keys); return json(body.keys); } }));
  const { result } = await opened();
  const [first, second] = result.current.annotations.list;
  act(() => { result.current.annotations.dismiss(first!); result.current.annotations.dismiss(second!); });
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies.at(-1)).toHaveLength(2);
  expect(result.current.annotations.list).toEqual([]);
  expect(result.current.annotations.error).toBeUndefined();
});

const RUN_NOTE: AgentAnnotation = { line: 9, severity: 'yellow', title: 'says to run nothing in particular', body: 'name what runs', source: 'agent' };

test("the agent's annotations follow the lint's; dismissing one hides it, saving its key with agent in the check's place, and the next review keeps it hidden; it has no fix (#329)", async () => {
  const saves: SaveBody[] = [];
  const server = serverOf(ONE, { review: () => json({ annotations: [RUN_NOTE] }), save: (id, body) => { saves.push(body); return echo(id, body); } });
  stubItems(server);
  const { result } = await opened();
  act(() => result.current.annotations.review.now());
  await waitFor(() => expect(result.current.annotations.list.map(checkOf)).toEqual(['unused', 'agent']));
  const agent = result.current.annotations.list[1]!;
  expect(hasFix(agent)).toBe(false);
  act(() => result.current.annotations.apply(agent));
  expect(saves).toEqual([]);
  act(() => result.current.annotations.dismiss(agent));
  expect(result.current.annotations.list.map(checkOf)).toEqual(['unused']);
  await waitFor(() => expect(server.dismissed).toEqual({ 'hive:new-build@mine': [`SKILL.md.liquid\0agent\0${RUN_NOTE.title}\0Run it.`] }));
  act(() => result.current.annotations.review.now());
  await waitFor(() => expect(result.current.annotations.review.running).toBe(false));
  expect(result.current.annotations.list.map(checkOf)).toEqual(['unused']);
});
