import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApprovalActions, FeedbackBox, requestFeedback, takeFeedbackRequest } from '@/components/ApprovalActions';
import { setLanguage } from '@/i18n';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { Task, TaskApproval } from '../../src/types';

// The feedback box's keys (#446), through the box itself (the task menu's dialog is the same FeedbackBox: TaskMenu.feedback.test.tsx).
// jsdom's platform is not macOS: CmdOrCtrl is Ctrl.
const START = '{Control>}{Enter}{/Control}';
const QUEUE = '{Control>}{Shift>}{Enter}{/Shift}{/Control}';
const TASK: Task = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true,
};
// The task's live activity (#629), handed to the box by its caller: its approval, and the id its routes post under
const HELD = { id: 'a-I1', approval: { since: '2026-09-27T10:00:00.000Z', until: '2026-09-27T10:05:00.000Z' } satisfies TaskApproval };
const NO_SESSION = { id: 'a-I1', approval: { since: '2026-09-27T10:00:00.000Z' } satisfies TaskApproval };
const posted = (body: unknown) => expect.objectContaining({ method: 'POST', body: JSON.stringify(body) });
const box = (): HTMLElement => screen.getByLabelText('Feedback');
// fireEvent answers dispatchEvent: false when a handler called preventDefault
const keyTaken = (shift: boolean): boolean => !fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: shift });

const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); setShortcuts({}); });

test('Ctrl+Enter sends and starts now and Ctrl+Shift+Enter sends in order; with blank text neither sends, yet both keys are taken (#446)', async () => {
  const user = userEvent.setup();
  render(<FeedbackBox activity={NO_SESSION} />);
  expect(keyTaken(false)).toBe(true);
  expect(keyTaken(true)).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  await user.type(box(), 'split the spec');
  await user.keyboard(START);
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'split the spec', start: true }));
  await user.keyboard(QUEUE);
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'split the spec', start: false }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('on a held session Ctrl+Enter sends like Enviar and Ctrl+Shift+Enter does nothing, leaving the key to the textarea: a live session has no queue (#446)', async () => {
  const user = userEvent.setup();
  render(<FeedbackBox activity={HELD} />);
  await user.type(box(), 'split the spec');
  await user.keyboard(START);
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'split the spec', start: true }));
  expect(keyTaken(true)).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('a rebound feedback shortcut fires on its new key and not the old one, and one turned off never fires (#446)', async () => {
  const user = userEvent.setup();
  setShortcuts({ confirm: 'Alt+Enter', feedbackQueue: null });
  render(<FeedbackBox activity={NO_SESSION} />);
  await user.type(box(), 'add tests');
  await user.keyboard('{Alt>}{Enter}{/Alt}');
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'add tests', start: true }));
  await user.keyboard(START);
  await user.keyboard(QUEUE);
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('each send button shows its shortcut beside its text, left out of its name, and none while that shortcut is off (#446)', () => {
  const button = (name: string): HTMLElement => screen.getByRole('button', { name });
  const { rerender } = render(<FeedbackBox activity={NO_SESSION} />);
  expect(button('começar agora')).toHaveTextContent('começar agoraCtrl+Enter');
  expect(button('na ordem')).toHaveTextContent('na ordemCtrl+Shift+Enter');
  rerender(<FeedbackBox activity={HELD} />);
  expect(button('enviar')).toHaveTextContent('enviarCtrl+Enter');
  setShortcuts({ confirm: null });
  rerender(<FeedbackBox activity={NO_SESSION} />);
  expect(button('começar agora')).toHaveTextContent(/^começar agora$/);
  expect(button('na ordem')).toHaveTextContent('na ordemCtrl+Shift+Enter');
});

test('with the user\'s own session open on the feedback session the box shows only enviar, which sends now, and the queue key stays the textarea\'s (#483)', async () => {
  const user = userEvent.setup();
  render(<FeedbackBox activity={NO_SESSION} openSession />);
  expect(screen.queryByRole('button', { name: 'começar agora' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'na ordem' })).toBeNull();
  await user.type(box(), 'split the spec');
  await user.click(screen.getByRole('button', { name: 'enviar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'split the spec', start: true }));
  expect(keyTaken(true)).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
});

// Whether `a` comes before `b` in the document: the box sits under the button row
const isBefore = (a: HTMLElement, b: HTMLElement): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

test('the status box shows aprovar and, under it, the feedback box at once, with its hint, without taking the focus; Escape only leaves the field; no estender without a held session (#268, #685)', async () => {
  const user = userEvent.setup();
  render(<ApprovalActions task={TASK} activity={NO_SESSION} />);
  expect(box()).not.toHaveFocus();
  expect(isBefore(screen.getByRole('button', { name: 'aprovar' }), box())).toBe(true);
  expect(screen.queryByRole('button', { name: 'enviar feedback…' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'estender' })).toBeNull();
  expect(screen.getByText('começar agora retoma a sessão da tarefa. na ordem, a tarefa espera um worker livre.')).toBeInTheDocument();
  expect(screen.queryByText('esc para cancelar')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'aprovar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approve', expect.objectContaining({ method: 'POST' }));
  await user.type(box(), 'split the spec');
  await user.keyboard('{Escape}');
  expect(box()).toHaveValue('split the spec'); // nothing to go back to: the box stays with its text
  expect(box()).not.toHaveFocus(); // the next Escape is the panel's
  await user.click(screen.getByRole('button', { name: 'na ordem' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'split the spec', start: false }));
});

test('a held session shows its time left, aprovar and estender above a box with only enviar and no hint (#268, #685)', async () => {
  const user = userEvent.setup();
  render(<ApprovalActions task={TASK} activity={HELD} />);
  expect(screen.getByText(/^resta/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'estender' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approval/extend', expect.objectContaining({ method: 'POST' }));
  expect(isBefore(screen.getByRole('button', { name: 'estender' }), box())).toBe(true);
  expect(screen.getByRole('button', { name: 'enviar' })).toBeDisabled();
  expect(screen.queryByText(/a tarefa espera um worker/)).toBeNull();
});

test('a feedback request from the flow\'s F key puts the cursor in the box, whether it comes before or after the band mounts (#585, #685)', () => {
  requestFeedback('I1');
  const { unmount } = render(<ApprovalActions task={TASK} activity={NO_SESSION} />);
  expect(box()).toHaveFocus();
  expect(takeFeedbackRequest('I1')).toBe(false); // the band took it
  unmount();
  render(<ApprovalActions task={TASK} activity={NO_SESSION} />);
  expect(box()).not.toHaveFocus();
  act(() => requestFeedback('I1'));
  expect(box()).toHaveFocus();
});
