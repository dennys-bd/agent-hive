import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { BlockerAddRow, type BlockerAddRowProps } from '@/components/BlockerAddRow';
import { setLanguage } from '@/i18n';
import { findBlockerCandidates } from '@/lib/blockers-api';
import { REF_GRAMMARS, type RefGrammar } from '../../src/blocker-refs';
import type { BlockerRef, ItemBlockers } from '../../src/types';

vi.mock('@/lib/blockers-api', () => ({ findBlockerCandidates: vi.fn() }));
const find = vi.mocked(findBlockerCandidates);

// Issue #40 of source work, already blocked by #7; the search finds the item itself, #7, #31 and an issue of another repository
const BLOCKERS: ItemBlockers = { blockedBy: [{ id: '7', title: 'Old', state: 'open' }], blocking: [] };
const ref = (id: string, title: string): BlockerRef => ({ id, title, state: 'open' });
const FOUND: BlockerRef[] = [ref('40', 'Itself'), ref('7', 'Old'), ref('31', 'Pager'), ref('other/lib#3', 'Pager lib')];
const FIELD = '#número ou título…';

function setup(props: Partial<BlockerAddRowProps> = {}) {
  const user = userEvent.setup();
  const onAdd = vi.fn();
  const onCancel = vi.fn();
  render(<BlockerAddRow source="work" itemId="work:PVTI_40" selfId="40" blockers={BLOCKERS} isBusy={false} grammar={REF_GRAMMARS.github} onAdd={onAdd} onCancel={onCancel} {...props} />);
  return { user, onAdd, onCancel, field: screen.getByRole('combobox', { name: FIELD }) };
}
const options = (): (string | null)[] =>
  within(screen.getByRole('listbox', { name: 'sugestões' })).getAllByRole('option').map((o) => o.textContent);

beforeEach(() => {
  setLanguage('pt');
  find.mockReset();
  find.mockResolvedValue(FOUND);
});

test('the row opens on bloqueada por with the field focused and searches nothing while the field is empty (#57)', () => {
  const { field } = setup();
  expect(field).toHaveFocus();
  expect(screen.getByRole('combobox', { name: 'tipo' })).toHaveTextContent('bloqueada por');
  expect(screen.queryByRole('listbox', { name: 'sugestões' })).not.toBeInTheDocument();
  expect(find).not.toHaveBeenCalled();
});

test('a typed text searches once after the pause and lists the finds, the item itself and the refs already in the list left out (#57)', async () => {
  const { user, field } = setup();
  await user.type(field, 'pag');
  expect(find).not.toHaveBeenCalled();
  await screen.findByRole('option', { name: /#31/ });
  expect(find).toHaveBeenCalledOnce();
  expect(find).toHaveBeenCalledWith('work', 'work:PVTI_40', 'pag', expect.any(AbortSignal));
  expect(options()).toEqual(['#31Pager', 'other/lib#3Pager lib']);
});

test('bloqueia, then ↓ and ↵ on a find adds it as blocking; #7 is offered there since it only blocks this one (#57)', async () => {
  const { user, onAdd } = setup();
  screen.getByRole('combobox', { name: 'tipo' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: 'bloqueia' }));
  await user.click(screen.getByRole('combobox', { name: FIELD }));
  await user.keyboard('pag');
  await screen.findByRole('option', { name: /#31/ });
  expect(options()).toEqual(['#7Old', '#31Pager', 'other/lib#3Pager lib']);
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(onAdd).toHaveBeenCalledWith('blocking', '31');
});

test('a typed #12 is offered first as adicionar #12 and ↵ with nothing highlighted sends it as 12 (#57)', async () => {
  find.mockResolvedValue([]);
  const { user, onAdd } = setup();
  await user.keyboard('#12');
  expect(options()).toEqual(['adicionar #12']);
  await user.keyboard('{Enter}');
  expect(onAdd).toHaveBeenCalledWith('blockedBy', '12');
});

test('Escape closes the row without an add, and is prevented so the details panel does not close too (#57)', () => {
  const { field, onAdd, onCancel } = setup();
  expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onAdd).not.toHaveBeenCalled();
});

test('a search answer that lands after ↓ keeps the highlight on the same find, so ↵ adds what was highlighted (#57)', async () => {
  const { user, onAdd, field } = setup();
  await user.type(field, 'pag');
  await screen.findByRole('option', { name: /#31/ });
  find.mockResolvedValue([ref('other/lib#3', 'Pager lib'), ref('55', 'Pagination')]);
  await user.type(field, 'e');
  await user.keyboard('{ArrowDown}{ArrowDown}'); // still the old list: other/lib#3, the second
  await screen.findByRole('option', { name: /#55/ }); // the new list puts it first
  await user.keyboard('{Enter}');
  expect(onAdd).toHaveBeenCalledWith('blockedBy', 'other/lib#3');
});

test('a fixed kind renders no kind select and adds as that kind (#61)', async () => {
  find.mockResolvedValue([]);
  const { user, onAdd } = setup({ kind: 'blocking' });
  expect(screen.queryByRole('combobox', { name: 'tipo' })).not.toBeInTheDocument();
  await user.keyboard('#12{Enter}');
  expect(onAdd).toHaveBeenCalledWith('blocking', '12');
});

// A source type whose refs read ABC-12 and none of them short (#810)
const ABC: RefGrammar = { refOf: (text) => (/^ABC-\d+$/.test(text) ? text : undefined), isShort: () => false, forms: 'ABC-12' };

test('the row reads the refs of its item\'s source type: ABC-12 under a grammar that reads it, and never GitHub\'s 12 there (#810)', async () => {
  find.mockResolvedValue([]);
  const { user, onAdd, field } = setup({ grammar: ABC });
  await user.keyboard('ABC-12');
  expect(options()).toEqual(['adicionar ABC-12']);
  await user.keyboard('{Enter}');
  expect(onAdd).toHaveBeenCalledWith('blockedBy', 'ABC-12');
  await user.clear(field);
  await user.keyboard('12');
  expect(screen.queryByRole('listbox', { name: 'sugestões' })).not.toBeInTheDocument();
});

test('↵ with nothing highlighted and no ref the type reads sends nothing and names its forms under the field, finds listed or not; typing clears it (#810)', async () => {
  const { user, onAdd, field } = setup();
  await user.keyboard('acme/r12{Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('escreva 12, #12, owner/repo#12 ou o id de uma tarefa');
  await user.type(field, 'x');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await screen.findByRole('option', { name: /#31/ }); // the finds listed, none highlighted
  await user.keyboard('{Enter}');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(onAdd).not.toHaveBeenCalled();
});

test('on a hive task, with no grammar, ↵ on 12 says to write a task id, and a task id is still offered (#810)', async () => {
  find.mockResolvedValue([]);
  const { user, onAdd, field } = setup({ source: 'hive', itemId: 'local:1', selfId: 'HIVE-1', grammar: undefined });
  await user.keyboard('12{Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent(/^escreva o id de uma tarefa$/);
  await user.clear(field);
  await user.keyboard('HIVE-3{Enter}');
  expect(onAdd).toHaveBeenCalledWith('blockedBy', 'HIVE-3');
});
