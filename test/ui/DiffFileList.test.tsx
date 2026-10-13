import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { DiffFileList } from '@/components/DiffFileList';
import { setLanguage } from '@/i18n';
import type { DiffLine, FileDiff } from '../../src/types';

beforeEach(() => setLanguage('pt'));
const add = (n: number): DiffLine => ({ kind: 'add', text: `l${n}`, new: n });
const del = (n: number): DiffLine => ({ kind: 'del', text: `l${n}`, old: n });
const file = (path: string, status: FileDiff['status'] = 'modified', lines: DiffLine[] = []): FileDiff =>
  ({ path, status, hash: 'a'.repeat(64), hunks: lines.length === 0 ? [] : [{ header: '@@ -1 +1 @@', lines }] });
const FILES: FileDiff[] = [
  file('src/ui/Card.tsx'), file('src/ui/Pager.tsx', 'added', [add(1), add(2)]), file('src/ui/Old.tsx', 'deleted', [del(1)]),
  file('src/daemon.ts'), file('CHANGELOG.md'),
];
const list = (): HTMLElement => screen.getByRole('navigation', { name: /^(arquivos do diff|files in the diff)$/ });
const items = (): string[] => within(list()).getAllByRole('listitem').map((li) => li.textContent ?? '');
const row = (name: RegExp): HTMLElement => within(list()).getByRole('button', { name });
type Props = Parameters<typeof DiffFileList>[0];
function renderList(extra: Partial<Props> = {}) {
  const onOpen = vi.fn();
  render(<DiffFileList files={FILES} open="src/ui/Card.tsx" isReviewed={(f) => f.path === 'src/daemon.ts'} onOpen={onOpen} comments={(path) => (path === 'src/ui/Card.tsx' ? 2 : 0)} {...extra} />);
  return { onOpen };
}

test('a folder row heads each folder once, in the files\' order; a root file has none; a file shows its name alone (#853)', () => {
  renderList();
  expect(items()).toEqual(['⌄src/ui', 'Card.tsxmodificado2', 'Pager.tsxadicionado+2', 'Old.tsxremovido−1', '⌄src', 'daemon.tsmodificado, revisado✓', 'CHANGELOG.mdmodificado']);
  expect(within(list()).getByText('src/ui').closest('li')).toHaveClass('h-[26px]', 'text-muted-foreground', 'text-xs');
  expect(within(list()).getByText('src/ui').closest('li')?.querySelector('button')).toBeNull();
  expect(within(list()).queryByRole('checkbox')).toBeNull();
});

test('the name takes the status colour, a deleted one struck through, a reviewed one muted with ✓; the status word is the row\'s title (#853)', () => {
  renderList();
  expect(within(list()).getByText('Pager.tsx')).toHaveClass('text-working');
  expect(within(list()).getByText('Old.tsx')).toHaveClass('text-destructive', 'line-through');
  expect(within(list()).getByText('Card.tsx')).toHaveClass('text-foreground');
  expect(within(list()).getByText('daemon.ts')).toHaveClass('text-muted-foreground');
  expect(row(/^daemon\.ts/)).toHaveTextContent(/✓$/);
  expect(row(/^Card\.tsx/)).not.toHaveTextContent('✓');
  expect(row(/^Pager\.tsx/)).toHaveAttribute('title', 'adicionado');
});

test('rows are 28px with radius 4px, indented 22px under a folder and 8px at the root; the open row is on muted with a 2px inset and aria-current (#853)', () => {
  renderList();
  expect(row(/^Card\.tsx/)).toHaveClass('h-7', 'rounded-sm', 'pl-[22px]', 'bg-muted', 'shadow-[inset_2px_0_0_var(--foreground)]');
  expect(row(/^Card\.tsx/)).toHaveAttribute('aria-current', 'true');
  expect(row(/^CHANGELOG\.md/)).toHaveClass('pl-2');
  expect(row(/^CHANGELOG\.md/)).not.toHaveClass('bg-muted');
  expect(row(/^CHANGELOG\.md/)).not.toHaveAttribute('aria-current');
});

test('counts are 11px tabular figures and leave a zero side out; a click opens the file (#853)', async () => {
  const { onOpen } = renderList();
  expect(row(/^Pager\.tsx/)).not.toHaveTextContent('−');
  expect(within(row(/^Pager\.tsx/)).getByText('+2').parentElement).toHaveClass('text-[11px]', 'tabular-nums');
  expect(row(/^Old\.tsx/)).not.toHaveTextContent('+');
  await userEvent.setup().click(row(/^Pager\.tsx/));
  expect(onOpen).toHaveBeenCalledWith('src/ui/Pager.tsx');
});

test('the head reads x of y reviewed with the comment count at its end, a progress bar, and the filter with ⌕, in both languages (#853)', () => {
  renderList();
  expect(within(list()).getByText('1 de 5 revisados')).toHaveClass('font-medium', 'text-foreground');
  expect(list()).toHaveTextContent('2 comentários');
  expect(within(list()).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  expect(within(list()).getByText('⌕')).toHaveAttribute('aria-hidden', 'true');
  document.body.innerHTML = '';
  setLanguage('en');
  renderList({ comments: (path) => (path === 'src/daemon.ts' ? 1 : 0) });
  expect(list()).toHaveTextContent('1 of 5 reviewed');
  expect(list()).toHaveTextContent('1 comment');
});

test('the filter narrows the rows, any case, and drops a folder it leaves empty (#853)', async () => {
  const user = userEvent.setup();
  renderList();
  const filter = within(list()).getByRole('textbox', { name: 'filtrar arquivos' });
  await user.type(filter, 'DAEMON');
  expect(items()).toEqual(['⌄src', 'daemon.tsmodificado, revisado✓']);
  await user.clear(filter);
  await user.type(filter, 'change');
  expect(items()).toEqual(['CHANGELOG.mdmodificado']);
});
