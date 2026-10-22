import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrWithoutActivity } from '@/components/PrWithoutActivity';
import { setLanguage } from '@/i18n';
import type { State, Task } from '../../src/types';
import { fakePrHive, prData, STATE } from './pr-harness';
import type { PrView } from '@/lib/pr-view';

beforeEach(() => { setLanguage('pt'); localStorage.clear(); fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());

const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
const ISSUE = 'https://github.com/acme/app/issues/458';
const TASK458: Task = { item: { itemId: 'I458', id: '458', title: 'The center follows the left tab', body: '', url: ISSUE }, stage: 'dev', boardColumn: 'Ready', auto: true };
const CLOSES = [{ repository: 'acme/app', number: 458, url: ISSUE }, { repository: 'acme/app', number: 460, url: 'https://github.com/acme/app/issues/460' }];
const NOTE = 'criar tarefa liga este PR a uma tarefa nova na source hive, sem sync com o GitHub.';
const follows = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

function renderVariant(pr: PrView, state: State = STATE) {
  const spies = { onReloaded: vi.fn(), onGoTo: vi.fn(), onOpenIssue: vi.fn() };
  return { ...render(<PrWithoutActivity pr={pr} state={state} drafts={0} {...spies} />), ...spies };
}

test('the top: the author\'s initials, PR de {author}, abriu há N · sem atividade no Hive; then the neutral block with its note, este PR and no fluxo, in that order (#68)', () => {
  renderVariant(prData({ author: 'rafa', createdAt: ago(3) }));
  expect(screen.getByTitle('rafa')).toHaveTextContent('RA');
  expect(screen.getByText('PR de rafa')).toHaveClass('font-semibold', 'text-[13px]');
  expect(screen.getByText('abriu há 3 dias · sem atividade no Hive')).toHaveClass('text-muted-foreground');
  const order = [screen.getByText('PR de rafa'), screen.getByText(NOTE), screen.getByRole('region', { name: 'este PR' }), screen.getByRole('region', { name: 'no fluxo' })];
  for (const [i, el] of order.slice(1).entries()) expect(follows(order[i], el), `block ${i + 1}`).toBe(true);
  expect(screen.getByText(NOTE).parentElement).toHaveClass('rounded-lg', 'border');
});

test('the request line shows only with a request of the viewer\'s: ● in waiting, review pedido a você and when, the time left out with no at; without one the buttons and the note stay (#68)', () => {
  const asked = renderVariant(prData({ reviewRequests: [{ reviewer: 'ana', team: false, viewer: true, at: ago(2) }] }));
  const line = screen.getByText('review pedido a você').parentElement as HTMLElement;
  expect(within(line).getByText('●')).toHaveClass('text-waiting');
  expect(within(line).getByText('há 2 dias')).toHaveClass('text-muted-foreground');
  asked.unmount();
  const untimed = renderVariant(prData({ reviewRequests: [{ reviewer: 'ana', team: false, viewer: true }] }));
  expect(screen.getByText('review pedido a você').parentElement).toHaveTextContent(/^●review pedido a você$/);
  untimed.unmount();
  renderVariant(prData({ reviewRequests: [{ reviewer: 'core', team: true, viewer: false }] }));
  expect(screen.queryByText('review pedido a você')).toBeNull();
  expect(screen.getByRole('button', { name: 'revisar' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'criar tarefa…' })).toBeInTheDocument();
  expect(screen.getByText(NOTE)).toHaveClass('text-muted-foreground');
});

test('revisar is a primary button with no chevron that opens the send-review popover; criar tarefa… is outline; a merged PR has no revisar (#68)', async () => {
  const user = userEvent.setup();
  const first = renderVariant(prData());
  const review = screen.getByRole('button', { name: 'revisar' });
  expect(review).toHaveAttribute('data-variant', 'default');
  expect(review.querySelector('svg')).toBeNull();
  expect(screen.getByRole('button', { name: 'criar tarefa…' })).toHaveAttribute('data-variant', 'outline');
  await user.click(review);
  expect(screen.getByRole('heading', { name: 'enviar review' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'resumo da review…' })).toBeInTheDocument();
  first.unmount();
  renderVariant(prData({ state: 'merged' }));
  expect(screen.queryByRole('button', { name: 'revisar' })).toBeNull();
});

test('no fluxo lists each closing issue that is a task with its title, its stage and tarefa ›, which goes to the task; none reads sem tarefa no fluxo (#68)', async () => {
  const user = userEvent.setup();
  const first = renderVariant(prData({ closes: CLOSES }), { ...STATE, tasks: [TASK458] });
  const flow = within(screen.getByRole('region', { name: 'no fluxo' }));
  const rows = flow.getAllByRole('listitem');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent('#458The center follows the left tabdevtarefa ›');
  expect(within(rows[0]).getByText('dev')).toHaveClass('text-muted-foreground');
  await user.click(flow.getByRole('button', { name: 'tarefa ›' }));
  expect(first.onGoTo).toHaveBeenCalledWith('I458');
  first.unmount();
  renderVariant(prData({ closes: CLOSES }));
  expect(within(screen.getByRole('region', { name: 'no fluxo' })).getByText('sem tarefa no fluxo')).toHaveClass('text-muted-foreground');
});
