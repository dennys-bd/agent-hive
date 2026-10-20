import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { AgentAnnotation } from '../../src/reviewer';
import { REVIEWER_DEFAULTS, type ReviewerConfig } from '../../src/types';
import { REVIEW_PAUSE_MS, type ReviewerSettings, type Scope, useReviewer } from '@/hooks/use-reviewer';
import { json } from './plugins-fixtures';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SCOPE: Scope = { id: 'hive:new-build', version: 'mine', path: 'SKILL.md.liquid' };
const OTHER: Scope = { ...SCOPE, path: 'slicing.md' };
// Lines: the title 1, a blank 2, "Run it." 3, "Ask {{ reviewer }}." 4
const TEXT = '# new-build\n\nRun it.\nAsk {{ reviewer }}.\n';
const EDITED = `${TEXT}More.\n`;
const noteOn = (line: number, title = 'the two blocks contradict'): AgentAnnotation => ({ line, severity: 'yellow', title, body: 'both branches cannot hold at once', source: 'agent' });
const configOf = (when: ReviewerConfig['when'], extra: Partial<ReviewerConfig> = {}): ReviewerConfig => ({ ...REVIEWER_DEFAULTS, when, ...extra });
const answer = (annotations: AgentAnnotation[]): Response => json({ annotations });

interface Props { scope?: Scope; text: string; saved?: string; config: ReviewerConfig }
interface Sent { text: string; signal: AbortSignal }

// POST …/review: each call's text and signal kept, answered by `reply` with the call's 1-based number; a held reply keeps the run going
function stubReview(reply: (n: number) => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit): Promise<Response> => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    sent.push({ text, signal: init?.signal ?? new AbortController().signal });
    return reply(sent.length);
  }));
  return sent;
}
function held(): { promise: Promise<Response>; resolve(response: Response): void } {
  let settle: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => { settle = resolve; });
  return { promise, resolve: (response) => settle(response) };
}
function renderReviewer(initial: Props, save: ReviewerSettings['save'] = async () => undefined) {
  return renderHook((p: Props) => useReviewer(p.scope, p.text, p.saved, p.config, save), { initialProps: initial });
}

test("on save: a change of the open file's saved text posts once with that text, and its annotations come back as the agent's; an unsaved edit posts nothing (#329)", async () => {
  const sent = stubReview(() => answer([noteOn(3)]));
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('save') };
  const { result, rerender } = renderReviewer(opened);
  rerender({ ...opened, text: EDITED });
  expect(sent).toEqual([]);
  rerender({ ...opened, text: EDITED, saved: EDITED });
  await waitFor(() => expect(result.current.list).toEqual([noteOn(3)]));
  expect(sent.map((s) => s.text)).toEqual([EDITED]);
});

test('on demand: neither a save nor typing posts; now() does, with the buffer (#329)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const sent = stubReview(() => answer([]));
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, rerender } = renderReviewer(opened);
  const typed = `${EDITED}Typed.\n`;
  rerender({ ...opened, text: EDITED, saved: EDITED });
  rerender({ ...opened, text: typed, saved: EDITED });
  act(() => { vi.advanceTimersByTime(REVIEW_PAUSE_MS * 2); });
  expect(sent).toEqual([]);
  act(() => result.current.review.now());
  expect(result.current.review.running).toBe(true);
  await waitFor(() => expect(result.current.review.running).toBe(false));
  expect(sent.map((s) => s.text)).toEqual([typed]);
});

test('as you type: 2 s after the last change it posts the buffer once; a pause that ends during the run posts one more after the answer, never two at once (#329)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const replies = [held(), held()];
  const sent = stubReview((n) => replies[n - 1]?.promise ?? answer([]));
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('type') };
  const { result, rerender } = renderReviewer(opened);
  rerender({ ...opened, text: `${TEXT}a` });
  act(() => { vi.advanceTimersByTime(REVIEW_PAUSE_MS / 2); });
  const first = `${TEXT}ab`;
  rerender({ ...opened, text: first }); // a change restarts the pause
  act(() => { vi.advanceTimersByTime(REVIEW_PAUSE_MS / 2); });
  expect(sent).toEqual([]);
  act(() => { vi.advanceTimersByTime(REVIEW_PAUSE_MS / 2); });
  expect(sent.map((s) => s.text)).toEqual([first]);
  const second = `${first}c`;
  rerender({ ...opened, text: second });
  act(() => { vi.advanceTimersByTime(REVIEW_PAUSE_MS); });
  expect(sent).toHaveLength(1); // the first run still going: no second
  await act(async () => { replies[0]?.resolve(answer([])); });
  await waitFor(() => expect(sent.map((s) => s.text)).toEqual([first, second]));
  await act(async () => { replies[1]?.resolve(answer([])); });
  await waitFor(() => expect(result.current.review.running).toBe(false));
  expect(sent).toHaveLength(2);
});

test("an agent annotation follows its line when lines go in above it and goes when that line's text changes; the next review replaces the last one's (#329)", async () => {
  const replies = [answer([noteOn(3)]), answer([noteOn(4, 'reviewer is undeclared')])];
  stubReview((n) => replies[n - 1] ?? answer([]));
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, rerender } = renderReviewer(opened);
  act(() => result.current.review.now());
  await waitFor(() => expect(result.current.list.map((a) => a.line)).toEqual([3]));
  rerender({ ...opened, text: `Above.\n\n${TEXT}` });
  expect(result.current.list.map((a) => a.line)).toEqual([5]);
  rerender({ ...opened, text: TEXT.replace('Run it.', 'Run it twice.') });
  expect(result.current.list).toEqual([]);
  rerender(opened);
  act(() => result.current.review.now());
  await waitFor(() => expect(result.current.list.map((a) => a.title)).toEqual(['reviewer is undeclared']));
});

test('switching file during a run aborts it, and its answer never shows, there or back on the first file (#329)', async () => {
  const reply = held();
  const sent = stubReview(() => reply.promise);
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, rerender } = renderReviewer(opened);
  act(() => result.current.review.now());
  rerender({ ...opened, scope: OTHER });
  expect(sent[0]?.signal.aborted).toBe(true);
  expect(result.current.review.running).toBe(false);
  await act(async () => { reply.resolve(answer([noteOn(3)])); });
  expect(result.current.list).toEqual([]);
  rerender(opened);
  expect(result.current.list).toEqual([]);
});

test('a 409 busy shows nothing; a 502 bad_answer shows its copy; the next success clears it (#329)', async () => {
  const replies = [
    json({ error: 'a review of this item is already running', code: 'busy' }, 409),
    json({ error: "the reviewer's answer was refused; see hive.log", code: 'bad_answer' }, 502),
    answer([]),
  ];
  stubReview((n) => replies[n - 1] ?? answer([]));
  const { result } = renderReviewer({ scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') });
  const run = async (): Promise<void> => {
    act(() => result.current.review.now());
    await waitFor(() => expect(result.current.review.running).toBe(false));
  };
  await run();
  expect(result.current.review.error).toBeUndefined();
  await run();
  expect(result.current.review.error).toBe('plugins.reviewer.error.badAnswer');
  await run();
  expect(result.current.review.error).toBeUndefined();
});

test('a busy answer right after the hook aborted its own run on the item is retried once, 1 s later (#329)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const busy = (): Response => json({ error: 'a review of this item is already running', code: 'busy' }, 409);
  const replies: (Response | Promise<Response>)[] = [held().promise, busy(), busy()];
  const sent = stubReview((n) => replies[n - 1] ?? answer([]));
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, rerender } = renderReviewer(opened);
  act(() => result.current.review.now());
  rerender({ ...opened, scope: { ...SCOPE, version: 'tdd' } }); // another version of the same item: the run is aborted
  act(() => result.current.review.now());
  await waitFor(() => expect(sent).toHaveLength(2));
  act(() => { vi.advanceTimersByTime(1000); });
  await waitFor(() => expect(sent).toHaveLength(3));
  await waitFor(() => expect(result.current.review.running).toBe(false));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sent).toHaveLength(3); // once: the second busy is dropped
  expect(result.current.review.error).toBeUndefined();
});

test("set saves the config with only the changed field different; a refused save shows 'reviewer setting not saved' and the config stays (#329)", async () => {
  const save = vi.fn(async (_reviewer: ReviewerConfig): Promise<void> => undefined);
  const config = configOf('save', { version: 'strict' });
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config };
  const { result, rerender } = renderReviewer(opened, save);
  await act(() => result.current.review.set({ when: 'demand' }));
  expect(save).toHaveBeenLastCalledWith({ ...config, when: 'demand' });
  const reloaded = { ...config, when: 'demand' as const }; // the settings info reloaded after the save
  rerender({ ...opened, config: reloaded });
  save.mockRejectedValueOnce(new Error('disk full'));
  await act(() => result.current.review.set({ on: false }));
  expect(save).toHaveBeenLastCalledWith({ ...reloaded, on: false });
  expect(result.current.review.error).toBe('plugins.reviewer.error.notSaved');
  expect(result.current.review.config).toEqual(reloaded);
});

const busy = (): Response => json({ error: 'a review of this item is already running', code: 'busy' }, 409);
// A run on another version is aborted, then the next one meets the busy answer: the retry timer is pending after this
async function intoBusyRetry(opened: Props, reply: (n: number) => Response | Promise<Response>) {
  const sent = stubReview(reply);
  const hook = renderReviewer(opened);
  act(() => hook.result.current.review.now());
  hook.rerender({ ...opened, scope: { ...SCOPE, version: 'tdd' } });
  const moved: Props = { ...opened, scope: { ...SCOPE, version: 'tdd' } };
  act(() => hook.result.current.review.now());
  await waitFor(() => expect(sent).toHaveLength(2));
  return { ...hook, sent, moved };
}

test('the busy retry reviews the buffer as it is when it fires, not the text of the busy run; running stays on meanwhile (#329)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, rerender, sent, moved } = await intoBusyRetry(opened, (n) => (n === 1 ? held().promise : n === 2 ? busy() : answer([])));
  expect(result.current.review.running).toBe(true);
  rerender({ ...moved, text: EDITED });
  act(() => { vi.advanceTimersByTime(1000); });
  await waitFor(() => expect(sent).toHaveLength(3));
  expect(sent[2]?.text).toBe(EDITED);
  await waitFor(() => expect(result.current.review.running).toBe(false));
});

test('on save: a save that came during the busy run is the text the retry posts (#329)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const second = held();
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('save') };
  const { rerender, sent, moved } = await intoBusyRetry(opened, (n) => (n === 1 ? held().promise : n === 2 ? second.promise : answer([])));
  rerender({ ...moved, text: EDITED, saved: EDITED });
  await act(async () => { second.resolve(busy()); });
  act(() => { vi.advanceTimersByTime(1000); });
  await waitFor(() => expect(sent).toHaveLength(3));
  expect(sent[2]?.text).toBe(EDITED);
});

test('a newer run clears a pending busy retry, so the stale retry never fires over it (#329)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, sent } = await intoBusyRetry(opened, (n) => (n === 1 ? held().promise : n === 2 ? busy() : answer([])));
  act(() => result.current.review.now());
  await waitFor(() => expect(sent).toHaveLength(3));
  await waitFor(() => expect(result.current.review.running).toBe(false));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sent).toHaveLength(3);
});

test('on demand: a click during a run does not queue another run after it (#329)', async () => {
  const first = held();
  const sent = stubReview((n) => (n === 1 ? first.promise : answer([])));
  const opened: Props = { scope: SCOPE, text: TEXT, saved: TEXT, config: configOf('demand') };
  const { result, rerender } = renderReviewer(opened);
  act(() => result.current.review.now());
  rerender({ ...opened, text: EDITED });
  act(() => result.current.review.now());
  await act(async () => { first.resolve(answer([])); });
  await waitFor(() => expect(result.current.review.running).toBe(false));
  expect(sent).toHaveLength(1);
});

test('two quick set calls merge: the second keeps the first change; a refusal restores the config before it (#329)', async () => {
  const save = vi.fn(async (_reviewer: ReviewerConfig): Promise<void> => undefined);
  const config = configOf('save');
  const { result } = renderReviewer({ scope: SCOPE, text: TEXT, saved: TEXT, config }, save);
  await act(async () => { void result.current.review.set({ on: false }); await result.current.review.set({ when: 'demand' }); });
  expect(save).toHaveBeenLastCalledWith({ ...config, on: false, when: 'demand' });
  save.mockRejectedValueOnce(new Error('disk full'));
  await act(() => result.current.review.set({ agent: 'codex' }));
  await act(() => result.current.review.set({ model: 'm' }));
  expect(save).toHaveBeenLastCalledWith({ ...config, on: false, when: 'demand', model: 'm' });
});

test('canReview is false without a scope and true with one (#329)', () => {
  const { result, rerender } = renderReviewer({ text: TEXT, config: configOf('demand') });
  expect(result.current.review.canReview).toBe(false);
  rerender({ scope: SCOPE, text: TEXT, config: configOf('demand') });
  expect(result.current.review.canReview).toBe(true);
});
