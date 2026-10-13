import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { callsTo, fakeHive, type FakeHive, H, LABEL, renderPane } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const pane = (): HTMLElement => screen.getByRole('region', { name: LABEL });
const list = (): HTMLElement => screen.getByRole('navigation', { name: 'arquivos do diff' });
const section = (path: string): HTMLElement => within(pane()).getByRole('region', { name: path });
const reviewed = (path: string): HTMLElement => within(section(path)).getByRole('button', { name: 'revisado' });
const row = (name: RegExp): HTMLElement => within(list()).getByRole('button', { name });

test('marking a file from its card posts its hash, puts ✓ on its row, collapses its card and opens the next unreviewed file (#591, #853)', async () => {
  const user = userEvent.setup();
  renderPane();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  expect(within(list()).queryByRole('checkbox')).toBeNull();
  hive.review = { ...hive.review, reviewed: [{ scope: 'worktree', path: 'src/a.ts', hash: H(0) }] };
  await user.click(reviewed('src/a.ts'));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/reviewed')[0].body).toEqual({ scope: 'worktree', path: 'src/a.ts', hash: H(0), reviewed: true });
  await waitFor(() => expect(row(/^a\.ts/)).toHaveTextContent(/✓$/));
  expect(within(list()).getByText('a.ts')).toHaveClass('text-muted-foreground');
  expect(reviewed('src/a.ts')).toHaveAttribute('aria-pressed', 'true');
  expect(within(section('src/a.ts')).getByRole('button', { name: 'expandir arquivo' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'ocultar revisados' })).not.toBeChecked();
  expect(row(/^b\.ts/)).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('toolbar', { name: 'barra do diff' })).toHaveTextContent('1/3 revisados');
  expect(list()).toHaveTextContent('1 de 3 revisados');
});

test('the card\'s revisado unmarks and reopens the card; a mark with another hash shows unreviewed (#591, #853)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, reviewed: [{ scope: 'worktree', path: 'src/a.ts', hash: H(0) }, { scope: 'worktree', path: 'b.ts', hash: 'f'.repeat(64) }] };
  renderPane();
  await waitFor(() => expect(reviewed('src/a.ts')).toHaveAttribute('aria-pressed', 'true'));
  expect(row(/^a\.ts/)).toHaveTextContent(/✓$/);
  expect(row(/^b\.ts/)).not.toHaveTextContent('✓');
  expect(reviewed('b.ts')).toHaveAttribute('aria-pressed', 'false');
  await user.click(reviewed('src/a.ts'));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/reviewed')[0].body).toMatchObject({ path: 'src/a.ts', reviewed: false });
  expect(within(section('src/a.ts')).getByRole('button', { name: 'recolher arquivo' })).toBeInTheDocument();
});

test('ocultar revisados hides reviewed cards from the body while checked; the list keeps every file (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, reviewed: [{ scope: 'worktree', path: 'src/a.ts', hash: H(0) }] };
  renderPane();
  await waitFor(() => expect(row(/^a\.ts/)).toHaveTextContent(/✓$/));
  expect(within(pane()).getByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'ocultar revisados' }));
  expect(row(/^a\.ts/)).toHaveTextContent(/✓$/);
  expect(within(pane()).queryByRole('region', { name: 'src/a.ts' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'ocultar revisados' }));
  expect(within(pane()).getByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
});
