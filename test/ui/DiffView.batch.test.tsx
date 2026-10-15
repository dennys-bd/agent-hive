import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { emitReviewEvent, taskReview } from '@/lib/review-events';
import { activityOf, callsTo, fakeHive, type FakeHive, holdRoute, LABEL, renderPane, SESSION, withSessions } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const ANCHOR = { scope: 'worktree' as const, path: 'src/a.ts', side: 'new' as const, start: 2, end: 2, excerpt: ['2'] };
const footer = (): HTMLElement => screen.getByRole('group', { name: 'revisão' });
const section = async (): Promise<HTMLElement> => within(screen.getByRole('region', { name: LABEL })).findByRole('region', { name: 'src/a.ts' });

test('adicionar à revisão posts a draft; the footer counts it and enviar revisão is off with none (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  await user.click(within(await section()).getByRole('button', { name: 'comentar linha 2' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  await user.type(within(box).getByRole('textbox'), 'later');
  await user.click(within(box).getByRole('button', { name: 'adicionar à revisão' }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/drafts')[0].body).toEqual({ anchor: ANCHOR, text: 'later', session: SESSION });
  expect(footer()).toHaveTextContent('revisão · 0 comentários · 0 conversas abertas');
  expect(within(footer()).getByRole('button', { name: /enviar revisão/ })).toBeDisabled();
  expect(footer()).toHaveTextContent('] próximo arquivo · [ anterior · C comentar · V revisado');
});

test('a draft shows on its line with na revisão and editar; editing saves with PUT on ⌥↵; enviar revisão posts submit and names a failed session (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, drafts: [{ id: 'D1', anchor: ANCHOR, session: SESSION, text: 'later' }], threads: [] };
  hive.answers['POST /tasks/I1/review/submit'] = { failed: [SESSION] };
  renderPane(activityOf(withSessions()));
  const s = await section();
  expect(await within(s).findByText('na revisão')).toHaveClass('text-waiting');
  expect(footer()).toHaveTextContent('1 comentário');
  await user.click(within(s).getByRole('button', { name: 'editar' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  await user.type(within(box).getByRole('textbox'), '!{Alt>}{Enter}{/Alt}');
  expect(callsTo(hive, 'PUT', '/tasks/I1/review/drafts/D1')[0].body).toEqual({ text: 'later!', session: SESSION });
  await user.click(within(footer()).getByRole('button', { name: /enviar revisão/ }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/submit')).toHaveLength(1);
  expect(await within(footer()).findByRole('alert')).toHaveTextContent('não entregue a claude abcdef12');
  expect(within(footer()).getByRole('button', { name: 'sessão' }).querySelector('svg[data-icon="claude"]')).not.toBeNull(); // sessão padrão
});

test('the footer\'s sessão padrão saves the pick (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  await section();
  within(footer()).getByRole('button', { name: 'sessão' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'nova sessão ›' }));
  expect(callsTo(hive, 'PUT', '/tasks/I1/review/default-session')[0].body).toEqual({ session: 'new' });
});

test('enviar revisão is off while its submit is in flight, and ⌃⇧↵ then sends nothing more (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, drafts: [{ id: 'D1', anchor: ANCHOR, session: SESSION, text: 'later' }] };
  const held = holdRoute('POST', '/tasks/I1/review/submit');
  renderPane(activityOf(withSessions()));
  await within(await section()).findByText('na revisão');
  const button = within(footer()).getByRole('button', { name: /enviar revisão/ });
  await user.click(button);
  expect(button).toBeDisabled();
  await user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
  expect(held.count()).toBe(1);
  held.release();
  await waitFor(() => expect(button).toBeEnabled());
});

test('a batch delivered but not saved is named in the footer, and its drafts stay out of the next submit until they change (#591)', async () => {
  const user = userEvent.setup();
  const mine = { id: 'D1', anchor: ANCHOR, session: SESSION, text: 'later' };
  hive.review = { ...hive.review, drafts: [mine, { id: 'D2', anchor: ANCHOR, session: 'new', text: 'more' }] };
  hive.answers['POST /tasks/I1/review/submit'] = { failed: [], unsaved: [SESSION] };
  renderPane(activityOf(withSessions()));
  await within(await section()).findAllByText('na revisão');
  await user.click(within(footer()).getByRole('button', { name: /enviar revisão/ }));
  expect(await within(footer()).findByRole('alert')).toHaveTextContent('entregue a claude abcdef12, mas não salvo: os rascunhos continuam');
  hive.answers['POST /tasks/I1/review/submit'] = { failed: [] };
  await user.click(within(footer()).getByRole('button', { name: /enviar revisão/ }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/submit').map((c) => c.body)).toEqual([{ skip: [] }, { skip: [SESSION] }]);
  hive.review = { ...hive.review, drafts: [mine] };
  emitReviewEvent(taskReview('I1'));
  await waitFor(() => expect(within(footer()).getByRole('button', { name: /enviar revisão/ })).toBeDisabled());
  hive.review = { ...hive.review, drafts: [{ ...mine, text: 'later, edited' }] };
  emitReviewEvent(taskReview('I1'));
  await waitFor(() => expect(within(footer()).queryByRole('alert')).toBeNull());
  expect(within(footer()).getByRole('button', { name: /enviar revisão/ })).toBeEnabled();
});

test('editar reopens a draft with its chip as a chip, in the field\'s language (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, drafts: [{ id: 'D1', anchor: ANCHOR, session: 'new', text: 'look @\u2003·new' }], threads: [] };
  renderPane(activityOf(withSessions()));
  await user.click(within(await section()).getByRole('button', { name: 'editar' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  expect(within(box).getByRole('textbox')).toHaveValue('look @\u2003·nova');
  expect(box.querySelector('[data-slot="mention-chip"]')?.textContent).toBe('@\u2003·nova');
  await user.type(within(box).getByRole('textbox'), '{Alt>}{Enter}{/Alt}');
  expect(callsTo(hive, 'PUT', '/tasks/I1/review/drafts/D1')[0].body).toEqual({ text: 'look @\u2003·new', session: 'new' });
});
