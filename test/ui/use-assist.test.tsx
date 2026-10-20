import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { applyProposal, type AssistAnswer, proposalHunk } from '../../src/assist';
import { type AssistPick, useAssist } from '@/hooks/use-assist';
import { useItemEditor } from '@/hooks/use-item-editor';
import { usePlugins } from '@/hooks/use-plugins';
import type { MessageKey } from '@/i18n';
import { type AssistBody, BUILD_TEXT, CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems } from './plugins-fixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT });
const PROPOSAL = { from: 9, to: 9, text: 'Intro.\nThen /hive:new-pr.' };
const ANSWER: AssistAnswer = { proposal: PROPOSAL, hunk: proposalHunk(BUILD_TEXT, PROPOSAL), text: applyProposal(BUILD_TEXT, PROPOSAL), changed: true };
const CLAUDE: AssistPick = { agent: 'claude', model: '' };
const NEVER = (): Promise<Response> => new Promise<Response>(() => undefined);
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': BUILD }, ...extra });

interface Props { pick: AssistPick; isWritable: boolean }
function useBoth({ pick, isWritable }: Props) {
  const plugins = usePlugins(true);
  const editor = useItemEditor(plugins);
  return { plugins, editor, assist: useAssist({ editor, path: 'SKILL.md.liquid', pick, isWritable }) };
}
async function opened() {
  const hook = renderHook(useBoth, { initialProps: { pick: CLAUDE, isWritable: true } });
  await waitFor(() => expect(hook.result.current.plugins.items).toBeDefined());
  act(() => hook.result.current.plugins.open({ kind: 'item', id: 'hive:new-build' }));
  await waitFor(() => expect(hook.result.current.editor.read?.item.id).toBe('hive:new-build'));
  return hook;
}

test('ask posts the buffer, the trimmed request and the pick; a selection goes as its lines cut to the file, none goes without one, a default model goes unnamed (#331)', async () => {
  const bodies: AssistBody[] = [];
  stubItems(serverOf({ assist: (_id, body) => { bodies.push(body); return json(ANSWER); } }));
  const { result, rerender } = await opened();
  act(() => result.current.assist.ask('  two sentences  ', { startLine: 9, endLine: 23 })); // 23: the empty line after the final newline
  await waitFor(() => expect(result.current.assist.status).toBe('proposed'));
  act(() => result.current.assist.discard());
  rerender({ pick: { agent: 'codex', model: 'gpt-5' }, isWritable: true });
  act(() => result.current.assist.ask('again'));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies).toEqual([
    { version: 'mine', path: 'SKILL.md.liquid', text: BUILD_TEXT, request: 'two sentences', selection: { startLine: 9, endLine: 22 }, agent: 'claude' },
    { version: 'mine', path: 'SKILL.md.liquid', text: BUILD_TEXT, request: 'again', agent: 'codex', model: 'gpt-5' },
  ]);
});

test('a changed answer is proposed and locks the editor; an unchanged one is back to idle with the "no change" line, unlocked (#331)', async () => {
  let answer: AssistAnswer = ANSWER;
  stubItems(serverOf({ assist: () => json(answer) }));
  const { result } = await opened();
  act(() => result.current.assist.ask('two sentences'));
  expect([result.current.assist.status, result.current.assist.request]).toEqual(['running', 'two sentences']);
  await waitFor(() => expect(result.current.assist.status).toBe('proposed'));
  expect([result.current.assist.answer, result.current.editor.isLocked]).toEqual([ANSWER, true]);
  act(() => result.current.assist.discard());
  answer = { ...ANSWER, text: BUILD_TEXT, changed: false };
  act(() => result.current.assist.ask('nothing'));
  await waitFor(() => expect(result.current.assist.line).toBe('plugins.assist.noChange'));
  expect([result.current.assist.status, result.current.assist.answer]).toEqual(['idle', undefined]);
  await waitFor(() => expect(result.current.editor.isLocked).toBe(false));
});

test("each refusal shows its own line and any other failure the generic one; the server's words go to the console only (#331)", async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let refusal = json({});
  stubItems(serverOf({ assist: () => refusal }));
  const { result } = await opened();
  const cases: [Response, MessageKey][] = [
    [json({ error: 'busy', code: 'busy' }, 409), 'plugins.assist.busy'],
    [json({ error: 'off PATH', code: 'agent_unavailable' }, 409), 'plugins.assist.unavailable'],
    [json({ error: 'refused', code: 'bad_answer' }, 502), 'plugins.assist.badAnswer'],
    [json({ error: 'failed', code: 'run_failed' }, 502), 'plugins.assist.failed'],
    [json({ error: 'selection: outside the text' }, 400), 'plugins.assist.unexpected'],
  ];
  for (const [answer, key] of cases) {
    refusal = answer;
    act(() => result.current.assist.ask('two sentences'));
    await waitFor(() => expect(result.current.assist.line).toBe(key));
    expect(result.current.assist.status).toBe('idle');
  }
  expect(errors).toHaveBeenCalledTimes(cases.length);
});

test('unmounting while the agent works aborts the request (#331)', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  stubItems(serverOf({ assist: (_id, _body, signal) => { signals.push(signal); return NEVER(); } }));
  const { result, unmount } = await opened();
  act(() => result.current.assist.ask('two sentences'));
  await waitFor(() => expect(signals).toHaveLength(1));
  unmount();
  expect(signals[0]?.aborted).toBe(true);
});

test('the text turning read-only drops the proposal and aborts a request in flight (#331, decision 5)', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  stubItems(serverOf({ assist: (_id, _body, signal) => { signals.push(signal); return signals.length === 1 ? json(ANSWER) : NEVER(); } }));
  const { result, rerender } = await opened();
  act(() => result.current.assist.ask('two sentences'));
  await waitFor(() => expect(result.current.assist.status).toBe('proposed'));
  rerender({ pick: CLAUDE, isWritable: false });
  expect([result.current.assist.status, result.current.assist.answer]).toEqual(['idle', undefined]);
  rerender({ pick: CLAUDE, isWritable: true });
  act(() => result.current.assist.ask('again'));
  await waitFor(() => expect(signals).toHaveLength(2));
  rerender({ pick: CLAUDE, isWritable: false });
  expect([signals[1]?.aborted, result.current.assist.status]).toEqual([true, 'idle']);
});

test("accept writes the answer's text and saves it; discard writes nothing; both clear the request (#331, decision 7)", async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ assist: () => json(ANSWER), save: (_id, body) => { saves.push(body); return json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text })); } }));
  const { result } = await opened();
  act(() => result.current.assist.ask('two sentences'));
  await waitFor(() => expect(result.current.assist.status).toBe('proposed'));
  act(() => result.current.assist.discard());
  expect([result.current.assist.status, result.current.assist.request, result.current.editor.textOf('SKILL.md.liquid'), saves]).toEqual(['idle', undefined, BUILD_TEXT, []]);
  act(() => result.current.assist.ask('two sentences'));
  await waitFor(() => expect(result.current.assist.status).toBe('proposed'));
  act(() => result.current.assist.accept());
  expect([result.current.assist.status, result.current.assist.request]).toEqual(['idle', undefined]);
  await waitFor(() => expect(saves.map((s) => s.text)).toEqual([ANSWER.text]));
  await waitFor(() => expect(result.current.editor.isDirty('SKILL.md.liquid')).toBe(false));
  expect(result.current.editor.textOf('SKILL.md.liquid')).toBe(ANSWER.text);
});
