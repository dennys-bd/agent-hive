import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { AT, fakePrHive, type FakePrHive, prData, renderPage, thread, WITH_TASK } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());

test('the page reads the PR: its title, its line, conversation N and files N; files draws the diff with the bar\'s counts (#758)', async () => {
  const user = userEvent.setup();
  hive.pr = prData({ threads: [thread()], reviews: [{ id: 'R1', author: 'caio', at: AT, kind: 'approved', text: 'ok' }] });
  renderPage();
  expect(await screen.findByRole('heading', { name: 'The PR' })).toBeInTheDocument();
  const line = within(screen.getByText('feature').closest('p') as HTMLElement);
  expect(line.getByText('aberto')).toHaveClass('text-review');
  expect(line.getByText('main')).toHaveClass('font-mono');
  expect(line.getByText('· 2 commits ·')).toBeInTheDocument();
  expect(line.getByText('+1')).toHaveClass('text-working');
  expect(line.getByText('−1')).toHaveClass('text-destructive');
  expect(screen.getByRole('tab', { name: 'conversa 2' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('tab', { name: 'arquivos 1' }));
  expect(await screen.findByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
  expect(screen.getByRole('toolbar', { name: 'arquivos' })).toHaveTextContent('1 arquivo · +1 −1');
});

test('a merged PR says it is read only (#758)', async () => {
  hive.pr = prData({ state: 'merged' });
  renderPage();
  expect(await screen.findByText('mergeado: só leitura')).toBeInTheDocument();
});

test('task #N shows on a task\'s PR and opens its issue\'s page (#758)', async () => {
  const user = userEvent.setup();
  const { props } = renderPage(WITH_TASK);
  await user.click(await screen.findByRole('button', { name: 'tarefa #1 · app' }));
  expect(props.onOpenIssue).toHaveBeenCalledWith('https://github.com/acme/app/issues/1');
});

test('a PR without a task has no task #N, and its properties are its repository and workspace (#758)', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  expect(screen.queryByRole('button', { name: /^tarefa/ })).toBeNull();
  const props = within(screen.getByRole('complementary', { name: 'propriedades' }));
  expect(props.getByText('acme/app')).toBeInTheDocument();
  expect(props.getByText('hive')).toBeInTheDocument();
});

test('files keeps its footer\'s counts and key hint, with no enviar revisão and no general comment: the review popover sends the review (#758)', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('tab', { name: 'arquivos 1' }));
  const footer = await screen.findByRole('group', { name: 'revisão do PR' });
  expect(footer).toHaveTextContent('revisão do PR · 0 comentários · 1 conversa aberta');
  expect(within(footer).queryByRole('button', { name: /enviar revisão/ })).toBeNull();
  expect(within(footer).queryByRole('textbox')).toBeNull();
});
