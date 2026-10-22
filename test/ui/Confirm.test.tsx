import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, expect, type Mock, test, vi } from 'vitest';
import { Confirm } from '@/components/Confirm';
import { setLanguage } from '@/i18n';

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => setLanguage('pt'));

const dialog = (): HTMLElement => screen.getByRole('alertdialog');
const closeAndCancel = (): HTMLElement[] => within(dialog()).getAllByRole('button', { name: 'cancelar' });
const reopen = (user: User): Promise<void> => user.click(screen.getByRole('button', { name: 'abrir' }));

async function show(user: User, extra: Partial<ComponentProps<typeof Confirm>> = {}): Promise<Mock<() => void>> {
  const onConfirm = vi.fn<() => void>();
  render(<Confirm title="Fechar tarefa" message="fechar essa tarefa?" confirmLabel="fechar" onConfirm={onConfirm} trigger={<button type="button">abrir</button>} {...extra} />);
  await reopen(user);
  return onConfirm;
}

test('the title and the action read their own texts; the message is 13/19, pretty-wrapped, line breaks kept; the × has the focus (#75)', async () => {
  const user = userEvent.setup();
  await show(user);
  expect(dialog()).toHaveAccessibleName('Fechar tarefa');
  expect(within(dialog()).getByRole('button', { name: 'fechar' })).toBeInTheDocument();
  expect(within(dialog()).getByText('fechar essa tarefa?')).toHaveClass('text-[13px]', 'leading-[19px]', 'text-pretty', 'whitespace-pre-wrap');
  expect(closeAndCancel()[0]).toHaveFocus();
});

test('Enter confirms and closes with the focus on the × or on cancelar; Esc cancels (#75)', async () => {
  const user = userEvent.setup();
  const onConfirm = await show(user);
  await user.keyboard('{Enter}');
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await reopen(user);
  closeAndCancel()[1].focus();
  await user.keyboard('{Enter}');
  expect(onConfirm).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await reopen(user);
  await user.keyboard('{Escape}');
  expect(onConfirm).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('Ctrl+Enter (⌘ on macOS) runs the secondary and Enter does not (#75)', async () => {
  const user = userEvent.setup();
  const secondary = vi.fn();
  const onConfirm = await show(user, { secondary: { label: 'sempre', onConfirm: secondary } });
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect([onConfirm.mock.calls.length, secondary.mock.calls.length]).toEqual([0, 1]);
  await reopen(user);
  await user.keyboard('{Enter}');
  expect([onConfirm.mock.calls.length, secondary.mock.calls.length]).toEqual([1, 1]);
});

test('without a secondary, Ctrl+Enter does nothing and the dialog stays (#75)', async () => {
  const user = userEvent.setup();
  const onConfirm = await show(user);
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(onConfirm).not.toHaveBeenCalled();
  expect(dialog()).toBeInTheDocument();
});

test('danger paints the primary red, the destructive variant; without it the primary is the default one (#461)', async () => {
  const user = userEvent.setup();
  await show(user, { danger: true, confirmLabel: 'excluir' });
  expect(within(dialog()).getByRole('button', { name: 'excluir' })).toHaveClass('bg-destructive');
  await user.keyboard('{Escape}');
  await reopen(user);
  expect(within(dialog()).getByRole('button', { name: 'excluir' })).toHaveClass('bg-destructive'); // the same Confirm, still danger
});

test('a plain confirmation keeps the default primary (#461)', async () => {
  const user = userEvent.setup();
  await show(user);
  expect(within(dialog()).getByRole('button', { name: 'fechar' })).not.toHaveClass('bg-destructive');
});
