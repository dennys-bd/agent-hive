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
const box = (path: string): HTMLElement => within(list()).getByRole('checkbox', { name: `marcar ${path} como revisado` });

test('marking a file posts its hash, fades its row, collapses its section and opens the next unreviewed file (#591)', async () => {
  const user = userEvent.setup();
  renderPane();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  hive.review = { ...hive.review, reviewed: [{ scope: 'worktree', path: 'src/a.ts', hash: H(0) }] };
  await user.click(box('src/a.ts'));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/reviewed')[0].body).toEqual({ scope: 'worktree', path: 'src/a.ts', hash: H(0), reviewed: true });
  await waitFor(() => expect(box('src/a.ts')).toBeChecked());
  expect(box('src/a.ts').closest('li')).toHaveClass('opacity-55');
  const section = within(pane()).getByRole('region', { name: 'src/a.ts' });
  expect(within(section).getByRole('button', { name: 'expandir arquivo' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'ocultar revisados' })).not.toBeChecked();
  expect(within(list()).getByRole('button', { name: /b\.ts/ })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('toolbar', { name: 'barra do diff' })).toHaveTextContent('1/3 revisados');
});

test('the header\'s revisado unmarks and reopens the section; a mark with another hash shows unreviewed (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, reviewed: [{ scope: 'worktree', path: 'src/a.ts', hash: H(0) }, { scope: 'worktree', path: 'b.ts', hash: 'f'.repeat(64) }] };
  renderPane();
  await waitFor(() => expect(box('src/a.ts')).toBeChecked());
  expect(box('b.ts')).not.toBeChecked();
  const section = within(pane()).getByRole('region', { name: 'src/a.ts' });
  await user.click(within(section).getByRole('button', { name: 'revisado' }));
  expect(callsTo(hive, 'POST', '/tasks/I1/review/reviewed')[0].body).toMatchObject({ path: 'src/a.ts', reviewed: false });
  expect(within(section).getByRole('button', { name: 'recolher arquivo' })).toBeInTheDocument();
});

test('ocultar revisados hides reviewed sections from the body while checked; the list keeps every file (#591)', async () => {
  const user = userEvent.setup();
  hive.review = { ...hive.review, reviewed: [{ scope: 'worktree', path: 'src/a.ts', hash: H(0) }] };
  renderPane();
  await waitFor(() => expect(box('src/a.ts')).toBeChecked());
  expect(within(pane()).getByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'ocultar revisados' }));
  expect(box('src/a.ts')).toBeChecked();
  expect(within(pane()).queryByRole('region', { name: 'src/a.ts' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'ocultar revisados' }));
  expect(within(pane()).getByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
});
