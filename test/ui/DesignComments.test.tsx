import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignComments } from '@/components/DesignComments';
import { useDesignComments } from '@/hooks/use-design-comments';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { clockOf } from '@/lib/design-comments';
import { area, AT, PATH, REVIEW } from './design-review';
import { activityOf, callsTo, fakeHive, type FakeHive, SESSION, withSessions } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); hive = fakeHive(); hive.review = REVIEW; });
afterEach(() => vi.unstubAllGlobals());

function Panel({ activity }: { activity: TaskActivity }) {
  const model = useDesignComments(activity, PATH);
  return <DesignComments model={model} onHide={() => undefined} />;
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
