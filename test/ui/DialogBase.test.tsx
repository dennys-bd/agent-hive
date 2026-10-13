import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DialogBase } from '@/components/DialogBase';
import { AlertDialogDescription } from '@/components/ui/alert-dialog';
import { setLanguage } from '@/i18n';

type User = ReturnType<typeof userEvent.setup>;
type Props = Omit<ComponentProps<typeof DialogBase>, 'title' | 'children' | 'trigger'>;

beforeEach(() => setLanguage('pt'));

const dialog = (): HTMLElement => screen.getByRole('alertdialog');
// The × and the footer's cancel share the cancel text; the × comes first, in the header
const closeAndCancel = (): HTMLElement[] => within(dialog()).getAllByRole('button', { name: 'cancelar' });

async function show(user: User, props: Props, body: ReactNode = <AlertDialogDescription>corpo</AlertDialogDescription>) {
  const view = render(<DialogBase title="Título" trigger={<button type="button">abrir</button>} {...props}>{body}</DialogBase>);
  await user.click(screen.getByRole('button', { name: 'abrir' }));
  return view;
}

test('the defaults: the title names the dialog, a × and cancelar both close it, and the × holds the focus on open (#75)', async () => {
  const user = userEvent.setup();
  await show(user, { primary: { label: 'ação', onConfirm: vi.fn() } });
  expect(screen.getByRole('alertdialog', { name: 'Título' })).toHaveTextContent('corpo');
  const [close, cancel] = closeAndCancel();
  expect(close).toHaveFocus();
  expect(close.textContent).toBe('');
  expect(cancel).toHaveTextContent('cancelar');
  await user.click(close);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('each default is overridable: the cancel text, no ×, the focus on the primary, a context line, the small size (#75)', async () => {
  const user = userEvent.setup();
  await show(user, { primary: { label: 'ação', onConfirm: vi.fn() }, cancelLabel: 'voltar', closeButton: false, initialFocus: 'primary', context: 'contexto', size: 'sm' });
  expect(within(dialog()).getAllByRole('button').map((b) => b.textContent)).toEqual(['voltar', 'ação']);
  expect(within(dialog()).getByRole('button', { name: 'ação' })).toHaveFocus();
  expect(within(dialog()).getByText('contexto')).toHaveClass('text-[13px]', 'text-muted-foreground');
  expect(dialog()).toHaveAttribute('data-size', 'sm');
});

test('initialFocus none leaves every button of the dialog unfocused (#75)', async () => {
  const user = userEvent.setup();
  await show(user, { primary: { label: 'ação', onConfirm: vi.fn() }, initialFocus: 'none' });
  expect(within(dialog()).getAllByRole('button')).not.toContain(document.activeElement);
});

test('the footer reads cancel, tertiary, secondary, primary; ⌥+Enter runs the tertiary and closes (#75)', async () => {
  const user = userEvent.setup();
  const [primary, secondary, tertiary] = [vi.fn(), vi.fn(), vi.fn()];
  await show(user, { primary: { label: 'p', onConfirm: primary }, secondary: { label: 's', onConfirm: secondary }, tertiary: { label: 't', onConfirm: tertiary } });
  expect(within(dialog()).getAllByRole('button').map((b) => b.textContent)).toEqual(['', 'cancelar', 't', 's', 'p']);
  expect(within(dialog()).getByRole('button', { name: 'p' })).toHaveAttribute('data-variant', 'default');
  expect(within(dialog()).getByRole('button', { name: 's' })).toHaveAttribute('data-variant', 'outline');
  await user.keyboard('{Alt>}{Enter}{/Alt}');
  expect([primary, secondary, tertiary].map((f) => f.mock.calls.length)).toEqual([0, 0, 1]);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('Enter does nothing while the primary is disabled, and inside a textarea it stays a newline (#75)', async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const { unmount } = await show(user, { primary: { label: 'p', onConfirm, disabled: true } });
  await user.keyboard('{Enter}');
  expect(onConfirm).not.toHaveBeenCalled();
  expect(dialog()).toBeInTheDocument();
  unmount();
  await show(user, { primary: { label: 'p', onConfirm } }, <><AlertDialogDescription>corpo</AlertDialogDescription><textarea aria-label="nota" /></>);
  await user.type(screen.getByRole('textbox', { name: 'nota' }), 'a{Enter}b');
  expect(screen.getByRole('textbox', { name: 'nota' })).toHaveValue('a\nb');
  expect(onConfirm).not.toHaveBeenCalled();
});

test('an action closes once its promise resolves and runs once however often Enter is pressed meanwhile; a rejected one keeps the dialog open with the error (#75)', async () => {
  const user = userEvent.setup();
  let resolve = (): void => undefined;
  const slow = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  const { unmount } = await show(user, { primary: { label: 'p', onConfirm: slow } });
  await user.keyboard('{Enter}{Enter}');
  expect(slow).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeInTheDocument();
  await act(async () => resolve());
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  unmount();
  const failing = vi.fn(async () => { throw new Error('recusado'); });
  await show(user, { primary: { label: 'p', onConfirm: failing }, error: 'recusado' });
  await user.keyboard('{Enter}');
  await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
  expect(dialog()).toBeInTheDocument();
  expect(within(dialog()).getByRole('alert')).toHaveTextContent('recusado');
});
