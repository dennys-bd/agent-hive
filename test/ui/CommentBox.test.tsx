import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { displayBinding } from '../../src/shortcuts';
import { ADD_KEY, CommentBox, SEND_KEY } from '@/components/CommentBox';
import type { ReviewPane } from '@/components/review-context';
import { setLanguage } from '@/i18n';
import { EMPTY_REVIEW } from '@/lib/review-view';
import { isMac } from '@/lib/shortcut-bindings';
import { inSessionsPane } from './diff-harness';
import { taskReview } from '@/lib/review-events';

const PANE: ReviewPane = { reviewKey: taskReview('I1'), scope: 'worktree', task: '#1 Task 1', review: EMPTY_REVIEW, sessions: [], defaultSession: 'new', refresh: vi.fn(), edit: vi.fn(), isSending: false, track: (request) => request };
const TARGET = { anchor: { scope: 'worktree' as const, path: 'src/a.ts', side: 'new' as const, start: 2, end: 2, excerpt: ['2'] } };
beforeEach(() => setLanguage('pt'));

test('the box\'s actions: enviar, adicionar à revisão, the session, cancelar on the right; both sends show their key as the footer does (#591)', () => {
  render(inSessionsPane(PANE, <CommentBox target={TARGET} onClose={vi.fn()} />));
  const buttons = within(screen.getByRole('group', { name: 'linha 2' })).getAllByRole('button');
  const [send, add] = [SEND_KEY, ADD_KEY].map((key) => displayBinding(key, isMac()));
  expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([`enviar${send}`, `adicionar à revisão${add}`, 'sessão', 'cancelar']);
  // The hint is aria-hidden: the buttons keep their plain names
  expect([screen.getByRole('button', { name: 'enviar' }), screen.getByRole('button', { name: 'adicionar à revisão' })]).toEqual(buttons.slice(0, 2));
  expect(buttons[3]).toHaveClass('ml-auto');
});
