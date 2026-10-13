import { act, screen } from '@testing-library/react';
import { type Mock, vi } from 'vitest';
import type { DesignAnchor, DesignRect, ReviewAnchor, ReviewFile, ReviewMessage, ReviewThread } from '../../src/types';
import { type FakeHive, SESSION } from './diff-harness';

// A design file's comments in each of the handoff's five states (#113), plus a draft on another design and a line draft, which the panel leaves out
export const PATH = 'design/Landing.hv.html';
export const AT = (minute: number): string => `2026-10-12T14:${String(minute).padStart(2, '0')}:00.000Z`;
export const area = (pin: number, path = PATH, state: Partial<Pick<DesignAnchor, 'viewport' | 'theme' | 'tweaks'>> = {}): DesignAnchor => ({ kind: 'area', path, viewport: 1280, theme: 'dark', tweaks: {}, rect: { x: 0, y: 0, width: 320, height: 180 }, pin, ...state });
const LINES: ReviewAnchor = { scope: 'worktree', path: PATH, side: 'new', start: 1, end: 1, excerpt: ['x'] };
const you = (id: string, minute: number, text: string): ReviewMessage => ({ id, author: 'user', at: AT(minute), text, to: [SESSION] });
const agent = (id: string, minute: number, text: string): ReviewMessage => ({ id, author: { session: SESSION }, at: AT(minute), text });
const thread = (id: string, pin: number, messages: ReviewMessage[], extra: Partial<ReviewThread> = {}): ReviewThread => ({ id, anchor: area(pin), participants: [SESSION], messages, ...extra });
const MARK = { session: SESSION, at: AT(9) };

export const REVIEW: ReviewFile = {
  reviewed: [],
  drafts: [{ id: 'D5', anchor: area(5), session: SESSION, text: 'a draft' }, { id: 'D9', anchor: area(1, 'other.hv.html'), session: SESSION, text: 'elsewhere' }, { id: 'L1', anchor: LINES, session: SESSION, text: 'a line' }],
  threads: [
    thread('T4', 4, [you('m4', 1, 'with the agent')]),
    thread('T2', 2, [you('m2', 1, 'a question'), agent('r2', 2, 'which colour?')]),
    thread('T3', 3, [you('m3', 1, 'proposed')], { agentResolved: MARK }),
    thread('T1', 1, [you('m1', 1, 'mine')], { resolved: true }),
    thread('T6', 6, [you('m6', 1, 'confirmed')], { resolved: true, agentResolved: MARK }),
  ],
};

// The design pane against a fakeHive (#114): the mint answered, the frame's window as the bridge's source
export const FRAME_URL = '/design-frame/tok/Landing.hv.html';
export const FRAME_NAME = 'Landing.hv.html';
export const RECT: DesignRect = { x: 100, y: 200, width: 50, height: 20 };
export const mintFrame = (hive: FakeHive): void => {
  hive.answers[`GET /activities/a-I1/design-frame?${new URLSearchParams({ path: PATH })}`] = { url: FRAME_URL };
};
/** A message of the pane's bridge (#112), posted from its frame's window. */
export function fromBridge(data: Record<string, unknown>): void {
  const { contentWindow } = screen.getByTitle(FRAME_NAME) as HTMLIFrameElement;
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { hive: 'design', ...data }, source: contentWindow })); });
}
export const pinsAt = (ids: readonly string[], rect: DesignRect | null = RECT): Record<string, unknown> => ({ type: 'pins', pins: ids.map((id) => ({ id, rect })) });
/** jsdom has no scrollIntoView: a counting stub on Element, taken off by unstubScrollIntoView in afterEach. */
export function stubScrollIntoView(): Mock {
  const scroll = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
  return scroll;
}
export const unstubScrollIntoView = (): void => { Reflect.deleteProperty(Element.prototype, 'scrollIntoView'); };
/** What the pane posts to its frame from now on (#241), every message in order. */
export function postsToFrame(): () => Record<string, unknown>[] {
  const { contentWindow } = screen.getByTitle(FRAME_NAME) as HTMLIFrameElement;
  if (contentWindow === null) throw new Error('the frame has no window');
  const spy = vi.spyOn(contentWindow, 'postMessage').mockImplementation(() => undefined);
  return () => spy.mock.calls.map(([data]) => data as Record<string, unknown>);
}
