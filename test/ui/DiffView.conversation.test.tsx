import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import type { ReviewThread } from '../../src/types';
import { emitReviewEvent } from '@/lib/review-events';
import { activityOf, callsTo, task, fakeHive, type FakeHive, holdRoute, LABEL, renderPane, SESSION, SESSIONS, withSessions } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const thread = (extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'T1', anchor: { scope: 'worktree', path: 'src/a.ts', side: 'new', start: 2, end: 2, excerpt: ['2'] }, participants: [SESSION],
  messages: [{ id: 'M1', author: 'user', at: '2026-09-29T10:00:00.000Z', text: 'why?', to: [SESSION] }], ...extra,
});
const section = async (): Promise<HTMLElement> => within(screen.getByRole('region', { name: LABEL })).findByRole('region', { name: 'src/a.ts' });

test('a conversation shows under its line with its messages; ↵ replies, resolver posts, and the list counts it (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, threads: [thread({ messages: [...thread().messages, { id: 'M2', author: { session: SESSION }, at: '2026-09-29T10:01:00.000Z', text: 'because' }] })] };
  renderPane(activityOf(withSessions()));
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  expect(conversation).toHaveTextContent('linha 2');
  expect(within(conversation).getByText('você')).toHaveClass('font-medium');
  const author = within(conversation).getByText('claude');
  expect(author).toHaveClass('font-medium');
  expect(author.querySelector('svg[data-icon="claude"]')).not.toBeNull(); // the agent's icon, no text symbol
  const [, byAgent] = within(conversation).getAllByRole('listitem');
  expect(within(byAgent).getByText(/^abcdef12 · \d{1,2}:\d{2}(\s[AP]M)?$/)).toHaveClass('text-muted-foreground'); // the id muted as the time, a · between
  await user.type(within(conversation).getByRole('textbox', { name: 'responder' }), 'and?{Enter}');
  expect(callsTo(hive, 'POST', '/tasks/I1/review/threads/T1/messages')[0].body).toEqual({ text: 'and?' });
  await user.click(within(conversation).getByRole('button', { name: 'resolver' }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/threads/T1/resolve')[0].body).toEqual({ resolved: true });
  const list = screen.getByRole('navigation', { name: 'arquivos do diff' });
  expect(list).toHaveTextContent('1 comentário');
  expect(within(within(list).getByRole('button', { name: /^a\.ts/ })).getByText('1')).toHaveClass('rounded-full');
});

test('não entregue offers reenviar; a delivered session at work reads respondendo; a resolved one folds to a line that reopens (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, threads: [thread({ messages: [{ ...thread().messages[0], failed: true, pending: ['new'] }] })] };
  const working = activityOf({ ...withSessions(), sessions: [{ run: { ptyId: 'W1', label: 'Claude', kind: 'session' }, status: 'working', session: SESSIONS[0] }] });
  const { unmount } = renderPane(working);
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  expect(conversation).toHaveTextContent('não entregue');
  expect(conversation).toHaveTextContent('claude respondendo');
  await user.click(within(conversation).getByRole('button', { name: 'reenviar' }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/threads/T1/messages/M1/retry')).toHaveLength(1);
  unmount();
  hive.review = { ...hive.review, threads: [thread({ resolved: true })] };
  renderPane(activityOf({ task }));
  await user.click(await within(await section()).findByRole('button', { name: 'reabrir' }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/threads/T1/resolve').at(-1)?.body).toEqual({ resolved: false });
});

test('an anchor whose lines changed shows at the top of its section, desatualizado (#591)', async () => {
  hive.review = { ...hive.review, threads: [thread({ anchor: { ...thread().anchor, excerpt: ['old text'] } })] };
  renderPane(activityOf(withSessions()));
  const s = await section();
  await waitFor(() => expect(within(s).getByText('desatualizado')).toBeInTheDocument());
  expect(within(s).getByRole('group', { name: 'conversa' }).closest('tr')).toBeNull();
});

test('a reply the pane is still sending is not shown não entregue; once its answer is in, a failed one is (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, threads: [thread()] };
  const held = holdRoute('POST', '/tasks/I1/review/threads/T1/messages');
  renderPane(activityOf(withSessions()));
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  await user.type(within(conversation).getByRole('textbox', { name: 'responder' }), 'and?{Enter}');
  const sent = { id: 'M2', author: 'user' as const, at: '2026-09-29T10:02:00.000Z', text: 'and?', failed: true as const, pending: [SESSION] };
  hive.review = { ...hive.review, threads: [thread({ messages: [...thread().messages, sent] })] };
  emitReviewEvent('I1');
  expect(await within(conversation).findByText('and?')).toBeInTheDocument();
  expect(conversation).not.toHaveTextContent('não entregue');
  held.release();
  await waitFor(() => expect(conversation).toHaveTextContent('não entregue'));
});

test('the messages take the box\'s whole width: no cap of their own, so the right inset is the box\'s padding as the left is (#591)', async () => {
  hive.review = { ...hive.review, threads: [thread()] };
  renderPane(activityOf(withSessions()));
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  expect(within(conversation).getByRole('list').className).not.toMatch(/max-w/);
});

test('a message shows its chips where they were written, as the field draws them: the icon, · and 4 characters (#591)', async () => {
  const text = `ask @\u2003·abcd and @\u2003·new now`;
  hive.review = { ...hive.review, threads: [thread({ messages: [{ ...thread().messages[0], text, mentions: [SESSION, 'new'] }] })] };
  renderPane(activityOf(withSessions()));
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  const chips = [...conversation.querySelectorAll('[data-slot="mention-chip"]')];
  expect(chips.map((c) => c.textContent)).toEqual(['@\u2003·abcd', '@\u2003·nova']);
  expect(chips[0].querySelector('svg[data-icon="claude"]')).not.toBeNull();
  expect(within(conversation).getAllByRole('listitem')[0].textContent).toMatch(/ask @\u2003·abcd and @\u2003·nova now$/);
});

test('a reply with a chip posts its text with the chip and the chip as its mention (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, threads: [thread()] };
  renderPane(activityOf(withSessions()));
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  await user.type(within(conversation).getByRole('textbox', { name: 'responder' }), 'and @');
  await user.click(screen.getByRole('option', { name: /abcdef12/ }));
  await user.keyboard('you?{Enter}');
  expect(callsTo(hive, 'POST', '/tasks/I1/review/threads/T1/messages')[0].body).toEqual({ text: 'and @\u2003·abcd you?', mentions: [SESSION] });
});
