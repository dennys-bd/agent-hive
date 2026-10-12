import type { DesignAnchor, ReviewAnchor, ReviewFile, ReviewMessage, ReviewThread } from '../../src/types';
import { SESSION } from './diff-harness';

// A design file's comments in each of the handoff's five states (#113), plus a draft on another design and a line draft, which the panel leaves out
export const PATH = 'design/Landing.hv.html';
export const AT = (minute: number): string => `2026-10-12T14:${String(minute).padStart(2, '0')}:00.000Z`;
export const area = (pin: number, path = PATH): DesignAnchor => ({ kind: 'area', path, viewport: 1280, theme: 'dark', rect: { x: 0, y: 0, width: 320, height: 180 }, pin });
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
