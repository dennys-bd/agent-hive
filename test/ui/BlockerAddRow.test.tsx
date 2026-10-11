import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { BlockerAddRow, type BlockerAddRowProps } from '@/components/BlockerAddRow';
import { setLanguage } from '@/i18n';
import { findBlockerCandidates } from '@/lib/blockers-api';
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
  render(<BlockerAddRow source="work" itemId="work:PVTI_40" selfId="40" blockers={BLOCKERS} isBusy={false} onAdd={onAdd} onCancel={onCancel} {...props} />);
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
