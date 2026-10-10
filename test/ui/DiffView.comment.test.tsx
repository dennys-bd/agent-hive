import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { activityOf, callsTo, fakeHive, type FakeHive, LABEL, renderPane, SESSION, withSessions } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const section = async (): Promise<HTMLElement> => within(screen.getByRole('region', { name: LABEL })).findByRole('region', { name: 'src/a.ts' });
// The selection bar has no role: it is marked by its data-slot, in the new number cell like the +, beside the body
const barOf = (row: HTMLElement): Element | null => within(row).getAllByRole('cell')[1].querySelector('[data-slot="selection-bar"]');
const plusOf = (row: HTMLElement, name: string): HTMLElement => within(row).getByRole('button', { name });
const posted = (): unknown[] => callsTo(hive, 'POST', '/tasks/I1/review/threads').map((c) => c.body);

test('a click on a line\'s + opens the box under it; enviar posts the anchor, the text and the default session (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  await user.click(within(await section()).getByRole('button', { name: 'comentar linha 2' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  await user.type(within(box).getByRole('textbox', { name: 'comentário' }), 'why?');
  const picker = within(box).getByRole('button', { name: 'sessão' });
  expect(picker).toHaveTextContent('claude abcdef12');
  expect(picker.querySelector('svg[data-icon="claude"]')).not.toBeNull(); // the agent's icon, no text symbol
  await user.click(within(box).getByRole('button', { name: 'enviar' }));
  expect(posted()).toEqual([{ anchor: { scope: 'worktree', path: 'src/a.ts', side: 'new', start: 2, end: 2, excerpt: ['2'] }, text: 'why?', to: [SESSION] }]);
  expect(screen.queryByRole('group', { name: 'linha 2' })).toBeNull();
});

test('a drag from + selects a range in one hunk; a deleted-only selection anchors on the old side; Esc and cancelar close (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  const s = await section();
  const rows = within(s).getAllByRole('row');
  fireEvent.pointerDown(within(rows[1]).getByRole('button', { name: 'comentar linha 1' }));
  fireEvent.pointerEnter(rows[3]);
  // Mid-drag: the + stays where the drag started, the others do not follow the pointer, and the bar runs below it at the +'s x
  expect(plusOf(rows[1], 'comentar linha 1').className.split(' ')).toContain('visible');
  expect(plusOf(rows[3], 'comentar linha 2').className.split(' ')).not.toContain('group-hover:visible');
  expect(barOf(rows[1])).toBeNull();
  for (const row of rows.slice(2, 4)) expect(barOf(row)?.className.split(' ')).toEqual(expect.arrayContaining(['right-0', 'translate-x-1/2', 'bg-ring']));
  fireEvent.pointerUp(window);
  const box = await screen.findByRole('group', { name: 'linhas 1–2' });
  expect(barOf(rows[2])).not.toBeNull();
  expect(s.querySelector('td[class*="shadow-"]')).toBeNull(); // no longer an inset shadow on the cell's edge
  await user.type(within(box).getByRole('textbox'), '{Escape}');
  expect(screen.queryByRole('group', { name: 'linhas 1–2' })).toBeNull();
  expect(s.querySelector('[data-slot="selection-bar"]')).toBeNull(); // Esc drops the selection with the box
  fireEvent.pointerDown(within(rows[2]).getByRole('button', { name: 'comentar linha 2 (antiga)' }));
  fireEvent.pointerUp(window);
  await user.type(within(await screen.findByRole('group', { name: 'linha 2' })).getByRole('textbox'), 'gone{Control>}{Enter}{/Control}');
  expect(posted()[0]).toMatchObject({ anchor: { side: 'old', start: 2, end: 2, excerpt: ['two'] }, text: 'gone' });
});

test('cancelar closes the box and clears the selection bar (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  const s = await section();
  fireEvent.pointerDown(within(s).getByRole('button', { name: 'comentar linha 1' }));
  fireEvent.pointerEnter(within(s).getAllByRole('row')[3]);
  fireEvent.pointerUp(window);
  expect(s.querySelector('[data-slot="selection-bar"]')).not.toBeNull();
  await user.click(within(await screen.findByRole('group', { name: 'linhas 1–2' })).getByRole('button', { name: 'cancelar' }));
  expect(screen.queryByRole('group', { name: 'linhas 1–2' })).toBeNull();
  expect(s.querySelector('[data-slot="selection-bar"]')).toBeNull();
});

test('side by side, a paired row has a + on each half: the old one comments the deleted line (#591)', async () => {
  const user = userEvent.setup();
  localStorage.setItem('hive.diffLayout', 'split');
  renderPane(activityOf(withSessions()));
  const rows = within(await section()).getAllByRole('row');
  expect(within(rows[1]).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['comentar linha 1']);
  expect(within(rows[2]).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['comentar linha 2 (antiga)', 'comentar linha 2']);
  await user.click(within(rows[2]).getByRole('button', { name: 'comentar linha 2 (antiga)' }));
  const box = await screen.findByRole('group', { name: 'linha 2' });
  expect(within(await section()).getAllByRole('row')).toHaveLength(4); // the box's row under the pair, once
  await user.type(within(box).getByRole('textbox'), 'old{Control>}{Enter}{/Control}');
  expect(posted()[0]).toMatchObject({ anchor: { side: 'old', start: 2, end: 2, excerpt: ['two'] }, text: 'old' });
});

test('the session picker lists the task\'s sessions and nova sessão; C comments the selected line (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  const rows = within(await section()).getAllByRole('row');
  await user.click(within(rows[1]).getAllByRole('cell')[3]);
  await user.keyboard('c');
  const box = await screen.findByRole('group', { name: 'linha 1' });
  within(box).getByRole('button', { name: 'sessão' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.getByText('sessões de #1 Task 1')).toBeInTheDocument();
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['claude abcdef12', 'nova sessão ›']);
  expect(items[0].querySelector('svg[data-icon="claude"]')).not.toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'nova sessão ›' }));
  await user.type(within(box).getByRole('textbox'), 'x');
  await user.click(within(box).getByRole('button', { name: 'enviar' }));
  expect(posted()[0]).toMatchObject({ to: ['new'] });
});

test('a chip in the box overrides the session picker (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  await user.click(within(await section()).getByRole('button', { name: 'comentar linha 2' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  await user.type(within(box).getByRole('textbox'), 'hey @');
  await user.click(screen.getByRole('option', { name: /nova sessão/ }));
  await user.click(within(box).getByRole('button', { name: 'enviar' }));
  // Stored with its chip where it was written, a new session's as "new" whatever the language; the chips are its mentions
  expect(posted()[0]).toEqual(expect.objectContaining({ text: 'hey @\u2003·new', mentions: ['new'] }));
  expect(posted()[0]).not.toHaveProperty('to');
});

test('with two chips adicionar à revisão is disabled; with one the draft goes to that chip\'s session (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  await user.click(within(await section()).getByRole('button', { name: 'comentar linha 2' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  const field = within(box).getByRole('textbox');
  await user.type(field, 'look @');
  await user.click(screen.getByRole('option', { name: /nova sessão/ }));
  const add = within(box).getByRole('button', { name: 'adicionar à revisão' });
  expect(add).toBeEnabled();
  await user.type(field, '@');
  await user.click(screen.getByRole('option', { name: /abcdef12/ }));
  expect(add).toBeDisabled();
  await user.type(field, '{Alt>}{Enter}{/Alt}');
  expect(callsTo(hive, 'POST', '/tasks/I1/review/drafts')).toHaveLength(0);
  await user.type(field, '{Backspace}{Backspace}{Alt>}{Enter}{/Alt}'); // the space after the last chip, then the chip
  expect(callsTo(hive, 'POST', '/tasks/I1/review/drafts')[0].body).toMatchObject({ text: 'look @\u2003·new', session: 'new' });
});
