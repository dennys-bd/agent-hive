import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { slot } from './detail-slot-harness';
import { AT, fakePrHive, type FakePrHive, PR, PR2, PRS, prData, renderPage, STATE, thread, WITH_TASK } from './pr-harness';

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

test('a PR without a task has no task #N and no column of its own; its title, repository and workspace go to the panel\'s slot (#758, #64)', async () => {
  renderPage(STATE, {}, { slotted: true });
  expect(await slot().findByRole('heading', { name: 'The PR' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^tarefa/ })).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(slot().getByText('acme/app')).toBeInTheDocument();
  expect(slot().getByText('hive')).toBeInTheDocument();
});

test('a task\'s PR leaves the title to the panel, and its slot block stays on the files tab (#64)', async () => {
  const user = userEvent.setup();
  renderPage(WITH_TASK, {}, { slotted: true });
  expect(await slot().findByText('acme/app')).toBeInTheDocument(); // the Hive lists no repository here: the task's issue cannot be read
  expect(slot().queryByRole('heading')).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'arquivos 1' }));
  expect(slot().getByText('acme/app')).toBeInTheDocument();
});

test('while the PR is read the slot shows the same read line as the page (#64)', () => {
  renderPage(STATE, {}, { slotted: true });
  expect(slot().getByText('carregando…')).toBeInTheDocument();
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

// Whether `b` comes after `a` in the document
const follows = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

test('the conversation reads stack, description, timeline, comment box, checks and the merge box last, and scrolls with no visible bar (#62)', async () => {
  hive.pr = prData({ checks: { state: 'success', items: [{ name: 'test', state: 'success' }] } });
  renderPage({ ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs: [...PRS, { url: PR2, state: 'open' }] }] });
  await screen.findByRole('heading', { name: 'The PR' });
  const order = [
    screen.getByRole('region', { name: 'pilha' }),
    screen.getByRole('region', { name: 'descrição' }),
    screen.getByRole('region', { name: 'conversa' }),
    screen.getByRole('textbox', { name: 'comentar no PR…' }),
    screen.getByRole('region', { name: 'checks' }),
    screen.getByRole('region', { name: 'mergear' }),
  ];
  for (const [i, section] of order.slice(1).entries()) expect(follows(order[i], section), `section ${i + 1}`).toBe(true);
  expect(order[0].parentElement).toHaveClass('scrollbar-none', 'overflow-y-auto');
});

test('a task\'s PR reads the session that opened it from the task\'s records, not another PR\'s (#62)', async () => {
  renderPage({
    ...WITH_TASK,
    activityRecords: [{ ...WITH_TASK.activityRecords[0], prs: [{ url: PR, state: 'open', sessionId: 'f9f0456a-1b2c-4d5e-8f90-123456789abc' }, { url: PR2, state: 'open', sessionId: '0badc0de-1b2c-4d5e-8f90-123456789abc' }] }],
  });
  expect(await screen.findByText('f9f0456a')).toHaveClass('font-mono');
  expect(screen.queryByText('0badc0de')).toBeNull();
});
