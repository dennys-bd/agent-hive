import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrPage } from '@/components/PrPage';
import { setLanguage } from '@/i18n';
import type { State } from '../../src/types';
import { slot } from './detail-slot-harness';
import { AT, fakePrHive, type FakePrHive, PR, PR2, PRS, prCalls, prData, renderPage, STATE, thread, WITH_TASK } from './pr-harness';

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

test('a PR without a task fills the slot with the PR without activity: PR de {author}, the neutral block, este PR and no fluxo; no title, repository grid or task\'s other PRs; no task #N (#68)', async () => {
  renderPage(STATE, {}, { slotted: true });
  expect(await slot().findByText('PR de bia')).toBeInTheDocument();
  expect(slot().getByRole('button', { name: 'criar tarefa…' })).toBeInTheDocument();
  expect(within(slot().getByRole('region', { name: 'este PR' })).getByText('branch', { selector: 'dt' })).toBeInTheDocument();
  expect(slot().getByRole('region', { name: 'no fluxo' })).toBeInTheDocument();
  expect(slot().queryByRole('heading', { name: 'The PR' })).toBeNull(); // the author's top replaces the title
  expect(slot().queryByText('acme/app')).toBeNull(); // no repository grid
  expect(slot().queryByText('hive')).toBeNull(); // no workspace row
  expect(slot().queryByRole('region', { name: 'outros PRs da tarefa' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^tarefa/ })).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
});

test('a task\'s PR fills the slot with este PR and the task\'s other PRs, never the issue\'s fields, on both tabs; a closing issue and another PR open through the page (#64, #66)', async () => {
  const user = userEvent.setup();
  hive.pr = prData({ closes: [{ repository: 'acme/app', number: 1, url: 'https://github.com/acme/app/issues/1' }] });
  const state = { ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs: [...PRS, { url: PR2, state: 'open' as const }] }] };
  const { props } = renderPage(state, {}, { slotted: true });
  expect(await slot().findByRole('region', { name: 'este PR' })).toBeInTheDocument();
  expect(slot().queryByRole('heading')).toBeNull(); // the title is the panel's
  expect(slot().queryByText('acme/app')).toBeNull(); // no repository block: #68 removed it
  expect(slot().queryByRole('button', { name: 'etapa' })).toBeNull(); // the issue's fields live on the issue page (#65)
  await user.click(slot().getByRole('button', { name: '#1' }));
  expect(props.onOpenIssue).toHaveBeenCalledWith('https://github.com/acme/app/issues/1');
  await user.click(within(slot().getByRole('region', { name: 'outros PRs da tarefa' })).getByRole('button', { name: 'abrir' }));
  expect(props.onOpenPr).toHaveBeenCalledWith(PR2);
  await user.click(screen.getByRole('tab', { name: 'arquivos 1' }));
  expect(slot().getByRole('region', { name: 'este PR' })).toBeInTheDocument();
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

test('criar tarefa… in the slot creates the hive task linked to the PR; once the state holds it, the page shows the task PR with its stack and no PR without activity (#68)', async () => {
  const user = userEvent.setup();
  const { props, rerender } = renderPage(STATE, {}, { slotted: true });
  await user.click(await slot().findByRole('button', { name: 'criar tarefa…' }));
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(prCalls(hive, 'POST', '/tasks')[0]?.body).toEqual({ title: 'The PR', stage: 'dev', auto: false, pr: PR, source: 'hive' }));
  const held: State = { ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs: [
    { url: 'https://github.com/acme/app/pull/6', state: 'merged', slice: { k: 1, type: 'stacked' } }, { url: PR, state: 'open', slice: { k: 2, type: 'stacked' } },
  ] }] };
  rerender(<PrPage {...props} state={held} />);
  expect(await screen.findByRole('button', { name: 'tarefa #1 · app' })).toBeInTheDocument();
  expect(within(slot().getByRole('region', { name: 'este PR' })).getByText('#7 · 2/2 da pilha')).toBeInTheDocument();
  expect(slot().queryByText('PR de bia')).toBeNull();
});

test('with no task the tab bar names the issues the PR closes, each opening its page, in task #N\'s place; with none, nothing; no via sessão on a PR no task holds (#68, #62)', async () => {
  const user = userEvent.setup();
  hive.pr = prData({ closes: [
    { repository: 'acme/app', number: 458, url: 'https://github.com/acme/app/issues/458' }, { repository: 'acme/docs', number: 3, url: 'https://github.com/acme/docs/issues/3' },
  ] });
  const first = renderPage();
  const closes = await screen.findByText(/^fecha /);
  expect(closes).toHaveTextContent('fecha #458, acme/docs#3');
  expect(closes).toHaveClass('text-muted-foreground');
  await user.click(within(closes).getByRole('button', { name: 'acme/docs#3' }));
  expect(first.props.onOpenIssue).toHaveBeenCalledWith('https://github.com/acme/docs/issues/3');
  expect(screen.queryByRole('button', { name: /^tarefa/ })).toBeNull();
  expect(screen.queryByText(/via sessão/)).toBeNull();
  first.unmount();
  hive.pr = prData();
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  expect(screen.queryByText(/^fecha /)).toBeNull();
});

test('the header gets the PR\'s GitHub URL from the first frame, with /files while the files tab is open (#352)', async () => {
  const user = userEvent.setup();
  renderPage(STATE, { header: (_reload, github) => <p>{`github ${github}`}</p> });
  expect(screen.getByText(`github ${PR}`)).toBeInTheDocument(); // before the read: prLink(ref)
  await screen.findByRole('heading', { name: 'The PR' });
  await user.click(screen.getByRole('tab', { name: 'arquivos 1' }));
  expect(screen.getByText(`github ${PR}/files`)).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: /^conversa/ }));
  expect(screen.getByText(`github ${PR}`)).toBeInTheDocument();
});
