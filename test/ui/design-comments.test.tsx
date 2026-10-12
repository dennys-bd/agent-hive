import { expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { fileComments, nextPin, recipientOf, targetOf, threadState } from '@/lib/design-comments';
import { EMPTY_REVIEW } from '@/lib/review-view';
import { NEW_SESSION } from '../../src/types';
import { AT, PATH, REVIEW } from './design-review';
import { SESSION } from './diff-harness';

const ids = (items: { id: string }[]): string[] => items.map((item) => item.id);
const [withAgent, answered] = REVIEW.threads;

test('a file\'s comments: drafts and unresolved threads are open, resolved ones apart, each list by pin; another file\'s and line comments stay out (#113)', () => {
  const { open, resolved } = fileComments(REVIEW, PATH);
  expect(ids(open)).toEqual(['T2', 'T3', 'T4', 'D5']);
  expect(ids(resolved)).toEqual(['T1', 'T6']);
  expect(ids(fileComments(REVIEW, 'other.hv.html').open)).toEqual(['D9']);
  expect(fileComments(EMPTY_REVIEW, PATH)).toEqual({ open: [], resolved: [] });
});

test('each item\'s state: draft, with the agent, replied, agent-resolved, resolved by you or confirmed; a reply after the agent\'s goes back to the agent (#113)', () => {
  const { open, resolved } = fileComments(REVIEW, PATH);
  expect(open.map((c) => c.state)).toEqual(['replied', 'agentDone', 'agent', 'draft']);
  expect(resolved.map((c) => [c.state, c.isConfirmed])).toEqual([['resolved', false], ['resolved', true]]);
  expect(open.find((c) => c.id === 'T4')).toMatchObject({ kind: 'thread', text: 'with the agent', at: AT(1), session: SESSION });
  expect(open.find((c) => c.id === 'D5')).toMatchObject({ kind: 'draft', text: 'a draft', at: undefined, messages: [] });
  expect(threadState({ ...answered, messages: [...answered.messages, { id: 'm7', author: 'user', at: AT(3), text: 'blue' }] })).toBe('agent');
  const failed = { ...withAgent, participants: [], messages: [{ ...withAgent.messages[0], failed: true as const, pending: [NEW_SESSION] }] };
  expect(fileComments({ ...EMPTY_REVIEW, threads: [failed] }, PATH).open[0]).toMatchObject({ state: 'agent', session: NEW_SESSION });
});

test('the recipient: the pick while it is the task\'s, else the session in focus while it is, else a new session (#113)', () => {
  const sessions = [{ id: SESSION }];
  expect(recipientOf(SESSION, undefined, sessions)).toEqual({ session: SESSION, how: 'focus' });
  expect(recipientOf('gone', undefined, sessions)).toEqual({ session: NEW_SESSION, how: 'new' });
  expect(recipientOf(undefined, undefined, sessions)).toEqual({ session: NEW_SESSION, how: 'new' });
  expect(recipientOf(SESSION, NEW_SESSION, sessions)).toEqual({ session: NEW_SESSION, how: 'picked' });
  expect(recipientOf(undefined, 'gone', sessions)).toEqual({ session: NEW_SESSION, how: 'new' });
});

test('targetOf heads an element by its selector and an area by its rounded size; nextPin is the file\'s highest pin plus one (#114)', () => {
  setLanguage('pt');
  const rect = { x: 0, y: 0, width: 320.4, height: 179.6 };
  expect(targetOf({ kind: 'element', selector: 'main > h1:nth-of-type(1)', text: 'Hi', rect })).toBe('main > h1:nth-of-type(1)');
  expect(targetOf({ kind: 'area', rect })).toBe('área · 320×180');
  expect(nextPin(fileComments(REVIEW, PATH))).toBe(7); // T6 is the highest, resolved ones included
  expect(nextPin({ open: [], resolved: [] })).toBe(1);
});
