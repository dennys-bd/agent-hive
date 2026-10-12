import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignComments } from '@/components/DesignComments';
import { useDesignComments } from '@/hooks/use-design-comments';
import { useCommentCanvas } from '@/hooks/use-design-pins';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { clockOf } from '@/lib/design-comments';
import { rememberFocus } from '@/lib/session-focus';
import { area, AT, PATH, REVIEW } from './design-review';
import { activityOf, callsTo, fakeHive, type FakeHive, holdRoute, SESSION, SESSIONS, withSessions } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); hive = fakeHive(); hive.review = REVIEW; });
afterEach(() => vi.unstubAllGlobals());

const NO_RECTS = new Map();
function Panel({ activity }: { activity: TaskActivity }) {
  const model = useDesignComments(activity, PATH);
  const canvas = useCommentCanvas(model); // the pane's tab and selection (#114)
  return <DesignComments model={model} tab={canvas.tab} selection={canvas.selection} rects={NO_RECTS} onTab={canvas.setTab} onSelect={canvas.selectItem} onHide={() => undefined} />;
}
const panel = (activity: TaskActivity = activityOf(withSessions())) => render(<Panel activity={activity} />);
// An item by its text, and the words of its buttons
const item = (text: string): HTMLElement => screen.getByText(text).closest('li') as HTMLElement;
const actions = (text: string): string[] => within(item(text)).getAllByRole('button').map((b) => b.textContent ?? '');
const posted = (url: string): unknown[] => callsTo(hive, 'POST', `/tasks/I1/review${url}`).map((c) => c.body);

test('each state shows its word, colour and actions, by pin; the tabs count open and resolved; a click selects an item (#113)', async () => {
  const user = userEvent.setup();
  panel();
  await screen.findByText('a draft');
  expect(screen.getByRole('radio', { name: 'abertos · 4' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getAllByRole('listitem').map((li) => li.textContent?.match(/a question|proposed|with the agent|a draft/)?.[0])).toEqual(['a question', 'proposed', 'with the agent', 'a draft']);
  expect(within(item('a draft')).getByText('rascunho')).toHaveClass('text-muted-foreground');
  expect(within(item('a draft')).getByText('área · 320×180')).toBeInTheDocument();
  expect(actions('a draft')).toEqual(['excluir', 'enviar']);
  expect(within(item('with the agent')).getByText('com o agente · claude abcdef12')).toBeInTheDocument();
  expect(within(item('with the agent')).getByText(clockOf(new Date(AT(1))))).toBeInTheDocument();
  expect(actions('with the agent')).toEqual(['resolver']);
  expect(item('a question')).toHaveClass('bg-waiting/8');
  expect(within(item('a question')).getByText('o agente respondeu')).toBeInTheDocument();
  expect(within(item('a question')).getByText(`claude abcdef12 · ${clockOf(new Date(AT(2)))}`)).toBeInTheDocument();
  expect(within(item('a question')).getByText('which colour?')).toBeInTheDocument();
  expect(actions('a question')).toEqual(['responder', 'resolver']);
  expect(item('proposed')).toHaveClass('bg-approval/8');
  expect(within(item('proposed')).getByText('o agente marcou como resolvido')).toBeInTheDocument();
  expect(actions('proposed')).toEqual(['reabrir', 'confirmar']);
  await user.click(screen.getByText('with the agent'));
  expect(item('with the agent')).toHaveAttribute('aria-current', 'true');
  await user.click(screen.getByRole('radio', { name: 'resolvidos · 2' }));
  expect(within(item('mine')).getByText('resolvido por você')).toBeInTheDocument();
  expect(screen.getByText('mine')).toHaveClass('text-muted-foreground');
  expect(within(item('confirmed')).getByText('resolvido pelo agente · você confirmou')).toBeInTheDocument();
  expect(actions('mine')).toEqual(['reabrir']);
});

test('confirmar and resolver resolve; reabrir empty resolves false, with a note it then replies; esc closes the box (#113)', async () => {
  const user = userEvent.setup();
  panel();
  await screen.findByText('proposed');
  await user.click(within(item('proposed')).getByRole('button', { name: 'confirmar' }));
  await user.click(within(item('with the agent')).getByRole('button', { name: 'resolver' }));
  expect([...posted('/threads/T3/resolve'), ...posted('/threads/T4/resolve')]).toEqual([{ resolved: true }, { resolved: true }]);
  await waitFor(() => expect(within(item('proposed')).getByRole('button', { name: 'reabrir' })).toBeEnabled());
  await user.click(within(item('proposed')).getByRole('button', { name: 'reabrir' }));
  await user.click(within(screen.getByRole('group', { name: 'reabrir' })).getByRole('button', { name: 'reabrir' }));
  await waitFor(() => expect(posted('/threads/T3/resolve')).toEqual([{ resolved: true }, { resolved: false }]));
  expect(posted('/threads/T3/messages')).toEqual([]);
  await user.click(screen.getByRole('radio', { name: 'resolvidos · 2' }));
  await user.click(within(item('mine')).getByRole('button', { name: 'reabrir' }));
  await user.type(screen.getByRole('textbox', { name: 'reabrir' }), 'not yet{Control>}{Enter}{/Control}'); // ⌘↵ off macOS
  await waitFor(() => expect(posted('/threads/T1/messages')).toEqual([{ text: 'not yet' }]));
  expect(hive.calls.filter((c) => c.method === 'POST').map((c) => c.url).slice(-2)).toEqual(['/tasks/I1/review/threads/T1/resolve', '/tasks/I1/review/threads/T1/messages']);
  expect(screen.queryByRole('group', { name: 'reabrir' })).toBeNull();
  await user.click(within(item('mine')).getByRole('button', { name: 'reabrir' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('group', { name: 'reabrir' })).toBeNull();
});

test('responder sends the text to the thread; excluir drops a draft; enviar sends it to the recipient, then drops it (#113)', async () => {
  const user = userEvent.setup();
  hive.answers['POST /tasks/I1/review/threads'] = { thread: 'T7', failed: [] };
  panel();
  await screen.findByText('a question');
  await user.click(within(item('a question')).getByRole('button', { name: 'responder' }));
  const box = screen.getByRole('group', { name: 'responder' });
  expect(within(box).getByRole('button', { name: 'responder' })).toBeDisabled();
  await user.type(within(box).getByRole('textbox'), 'blue');
  await user.click(within(box).getByRole('button', { name: 'responder' }));
  expect(posted('/threads/T2/messages')).toEqual([{ text: 'blue' }]);
  await user.click(within(item('a draft')).getByRole('button', { name: 'excluir' }));
  expect(callsTo(hive, 'DELETE', '/tasks/I1/review/drafts/D5')).toHaveLength(1);
  await waitFor(() => expect(within(item('a draft')).getByRole('button', { name: 'enviar' })).toBeEnabled());
  await user.click(within(item('a draft')).getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(callsTo(hive, 'DELETE', '/tasks/I1/review/drafts/D5')).toHaveLength(2));
  expect(posted('/threads')).toEqual([{ anchor: area(5), text: 'a draft', to: ['new'] }]); // no session in focus yet
});

test('an undelivered message shows não entregue with reenviar, which retries it (#113)', async () => {
  const user = userEvent.setup();
  const [withAgent, ...rest] = REVIEW.threads;
  hive.review = { ...REVIEW, threads: [{ ...withAgent, participants: [], messages: [{ ...withAgent.messages[0], failed: true, pending: [SESSION] }] }, ...rest] };
  panel();
  expect(await within(await screen.findByText('with the agent').then((t) => t.closest('li') as HTMLElement)).findByText('não entregue')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'reenviar' }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/threads/T4/messages/m4/retry')).toHaveLength(1);
});

test('the footer sends every draft of the file with kind, path and the recipient; its line names a new session, the session in focus, or the pick (#113)', async () => {
  const user = userEvent.setup();
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000000';
  panel(activityOf({ records: [{ id: 'a-I1', taskIds: ['I1'], sessions: [...SESSIONS, { ...SESSIONS[0], id: OTHER }] }] }));
  const send = await screen.findByRole('button', { name: 'enviar 1 rascunho' });
  expect(screen.getByText('nenhuma sessão em foco · abre uma sessão nova de claude em #1')).toBeInTheDocument();
  act(() => rememberFocus('I1', SESSION)); // last in the file: the store outlives each test
  expect(screen.getByText('para claude abcdef12 · a sessão em foco')).toBeInTheDocument();
  await user.click(send);
  expect(posted('/submit')).toEqual([{ skip: [], kind: 'design', path: PATH, to: SESSION }]);
  screen.getByRole('button', { name: 'sessão' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: /bbbbbbbb/ }));
  expect(screen.getByText('para claude bbbbbbbb · escolhida')).toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: 'resolvidos · 2' }));
  expect(screen.queryByRole('button', { name: 'enviar 1 rascunho' })).toBeNull();
});

test('while an item\'s enviar is in flight the footer and every action are off, so the draft is sent once (#113)', async () => {
  const user = userEvent.setup();
  hive.answers['POST /tasks/I1/review/threads'] = { thread: 'T7', failed: [] };
  const held = holdRoute('POST', '/tasks/I1/review/threads');
  panel();
  await screen.findByText('a draft');
  await user.click(within(item('a draft')).getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(held.count()).toBe(1));
  expect(screen.getByRole('button', { name: 'enviar 1 rascunho' })).toBeDisabled();
  expect(within(item('a question')).getByRole('button', { name: 'resolver' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'enviar 1 rascunho' }));
  expect(posted('/submit')).toEqual([]);
  held.release();
  await waitFor(() => expect(callsTo(hive, 'DELETE', '/tasks/I1/review/drafts/D5')).toHaveLength(1));
  expect(posted('/threads')).toHaveLength(1);
});

test('a refused reply keeps the box and its text; the box closes once the reply is taken (#113)', async () => {
  const user = userEvent.setup();
  const inner = globalThis.fetch;
  let refuse = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    (refuse && String(input) === '/tasks/I1/review/threads/T2/messages' ? new Response(JSON.stringify({ error: 'no' }), { status: 500 }) : inner(input, init))));
  panel();
  await screen.findByText('a question');
  await user.click(within(item('a question')).getByRole('button', { name: 'responder' }));
  await user.type(screen.getByRole('textbox', { name: 'responder' }), 'blue');
  await user.click(within(screen.getByRole('group', { name: 'responder' })).getByRole('button', { name: 'responder' }));
  await waitFor(() => expect(within(item('a question')).getByRole('button', { name: 'resolver' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'responder' })).toHaveValue('blue');
  refuse = false;
  await user.click(within(screen.getByRole('group', { name: 'responder' })).getByRole('button', { name: 'responder' }));
  await waitFor(() => expect(screen.queryByRole('group', { name: 'responder' })).toBeNull());
});
