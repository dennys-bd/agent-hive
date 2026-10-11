import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { PrBlock } from '@/components/PrBlock';
import { setLanguage } from '@/i18n';
import { rememberMethod } from '@/lib/merge-method';
import type { PrData, PrReviewEvent, State, TaskPr } from '../../src/types';
import { AT, PR, prData, thread, WITH_TASK } from './pr-harness';

const APP = 'https://github.com/acme/app/pull/';
beforeEach(() => { setLanguage('pt'); localStorage.clear(); });
// task I1's PRs: #512 and #515 before this page's #7, in a stack of three
const withPrs = (prs: TaskPr[]): State => ({ ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs }] });
const stack = (second: TaskPr['state']): State => withPrs([
  { url: `${APP}512`, state: 'merged', slice: { k: 1, type: 'stacked' } }, { url: `${APP}515`, state: second, slice: { k: 2, type: 'stacked' } },
  { url: PR, state: 'open', slice: { k: 3, type: 'stacked' } },
]);
const CLOSES = [
  { repository: 'acme/app', number: 458, url: 'https://github.com/acme/app/issues/458' }, { repository: 'acme/docs', number: 3, url: 'https://github.com/acme/docs/issues/3' },
];
function renderBlock(pr: PrData, state: State = WITH_TASK) {
  const onOpenIssue = vi.fn();
  const view = render(<PrBlock pr={pr} task={state.tasks[0]} state={state} onOpenIssue={onOpenIssue} />);
  return { ...view, onOpenIssue };
}
const box = (): HTMLElement => screen.getByRole('region', { name: 'este PR' });
const labels = (): string[] => [...box().querySelectorAll('dt')].map((dt) => dt.textContent ?? '');
// A row's value: the dd after its label
const cell = (label: string): HTMLElement => within(box()).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
const review = (author: string, kind: PrReviewEvent['kind']): PrReviewEvent => ({ id: author, author, at: AT, kind, text: '' });

test('the box is headed este PR with #N · k/n da pilha on a slice, #N alone otherwise; its rows run review, checks, merge, base, fecha, checks and fecha left out when empty (#66)', () => {
  const checks = { state: 'success' as const, items: [{ name: 'test', state: 'success' as const }] };
  const first = renderBlock(prData({ checks, closes: CLOSES }), stack('merged'));
  expect(within(box()).getByText('este PR')).toHaveClass('font-medium');
  expect(within(box()).getByText('#7 · 3/3 da pilha')).toHaveClass('text-muted-foreground');
  expect(labels()).toEqual(['review', 'checks', 'merge', 'base', 'fecha']);
  expect(box()).toHaveClass('rounded-lg', 'border');
  first.unmount();
  renderBlock(prData());
  expect(within(box()).getByText('#7')).toHaveClass('text-muted-foreground');
  expect(labels()).toEqual(['review', 'merge', 'base']);
});

test('review lists the requests first, a team by its slug with no avatar, then each reviewer\'s latest review in its colour; nobody reads nenhum (#66)', () => {
  const pr = prData({
    reviewRequests: [{ reviewer: 'core', team: true, viewer: false }],
    reviews: [review('caio', 'approved'), review('bia', 'changes'), review('eva', 'changes'), review('dan', 'commented')],
    threads: [thread({ resolved: true })], // bia's only thread, resolved
  });
  const { unmount } = renderBlock(pr);
  const rows = within(cell('review')).getAllByRole('listitem');
  expect(rows.map((li) => li.querySelector('.truncate')?.textContent)).toEqual(['core', 'caio', 'bia', 'eva', 'dan']);
  expect(within(rows[0]).getByText('time')).toHaveClass('text-muted-foreground');
  expect(within(rows[0]).getByText('pedido')).toHaveClass('text-waiting');
  expect(within(rows[0]).queryByTitle('core')).toBeNull(); // a team has no avatar
  expect(within(rows[1]).getByTitle('caio')).toBeInTheDocument();
  expect(within(rows[1]).getByText('aprovou')).toHaveClass('text-working');
  expect(within(rows[2]).getByText('mudanças resolvidas')).toHaveClass('text-muted-foreground');
  expect(within(rows[3]).getByText('pediu mudanças')).toHaveClass('text-destructive');
  expect(within(rows[4]).getByText('comentou')).toHaveClass('text-muted-foreground');
  unmount();
  renderBlock(prData());
  expect(within(cell('review')).getByText('nenhum')).toHaveClass('text-muted-foreground');
});

test('checks reads the worst mark, n de m passed and when they completed; workflows awaiting approval with no run read ◷ aguarda aprovação (#66)', () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const items = ['a', 'b', 'c', 'd'].map((name) => ({ name, state: 'success' as const }));
  const passing = renderBlock(prData({ checks: { state: 'success', at, items } }));
  expect(within(cell('checks')).getByText('4 de 4 · há 5 min')).toBeInTheDocument();
  expect(within(cell('checks')).getByText('✓')).toHaveClass('text-working');
  passing.unmount();
  const failing = renderBlock(prData({ checks: { state: 'failure', items: [...items.slice(1), { name: 'e', state: 'failure' }] } }));
  expect(within(cell('checks')).getByText('3 de 4')).toBeInTheDocument();
  expect(within(cell('checks')).getByText('✕')).toHaveClass('text-destructive');
  failing.unmount();
  renderBlock(prData({ checks: { state: 'pending', items: [], awaiting: ['CI'] } }));
  expect(within(cell('checks')).getByText('◷ aguarda aprovação')).toHaveClass('text-muted-foreground');
});

test('merge reads ● pronto · {the remembered method} in working, ● conflitos in destructive, GitHub\'s blocker in waiting, ● sem permissão in muted; merged and closed read their state (#66)', () => {
  const cases: [Partial<PrData>, string, string][] = [
    [{}, '● pronto · squash', 'text-working'],
    [{ mergeState: 'conflicts' }, '● conflitos', 'text-destructive'],
    [{ mergeState: 'blocked' }, '● bloqueado pelas regras do repositório', 'text-waiting'],
    [{ canPush: false }, '● sem permissão', 'text-muted-foreground'],
    [{ state: 'merged' }, 'mergeado', 'text-review'],
    [{ state: 'closed' }, 'fechado', 'text-muted-foreground'],
  ];
  for (const [extra, text, tone] of cases) {
    const { unmount } = renderBlock(prData(extra));
    expect(within(cell('merge')).getByText(text)).toHaveClass(tone);
    unmount();
  }
  rememberMethod(PR, 'merge');
  renderBlock(prData());
  expect(within(cell('merge')).getByText('● pronto · merge commit')).toHaveClass('text-working');
});

test('base reads the base branch, then the slices before this one that merged, and the first open one it waits for, which also holds the merge; a PR with no slice reads its base alone (#66)', () => {
  const merged = renderBlock(prData(), stack('merged'));
  expect(within(cell('base')).getByText('main')).toHaveClass('font-mono');
  expect(within(cell('base')).getByText('· #512 e #515 mergeados')).toHaveClass('text-muted-foreground');
  expect(within(cell('base')).queryByText(/aguarda/)).toBeNull();
  merged.unmount();
  const waiting = renderBlock(prData(), stack('open'));
  expect(within(cell('base')).getByText('· #512 mergeado')).toBeInTheDocument();
  expect(within(cell('base')).getByText('· aguarda #515')).toHaveClass('text-waiting');
  expect(within(cell('merge')).getByText('● mergeie #515 antes')).toHaveClass('text-waiting');
  waiting.unmount();
  renderBlock(prData());
  expect(cell('base')).toHaveTextContent(/^main$/);
});

test('fecha lists each closing issue, #N in this repository and owner/repo#N in another, then ao fazer merge while open; a click opens it through onOpenIssue (#66)', async () => {
  const user = userEvent.setup();
  const { onOpenIssue, unmount } = renderBlock(prData({ closes: CLOSES }));
  await user.click(within(cell('fecha')).getByRole('button', { name: '#458' }));
  await user.click(within(cell('fecha')).getByRole('button', { name: 'acme/docs#3' }));
  expect(onOpenIssue.mock.calls).toEqual([[CLOSES[0].url], [CLOSES[1].url]]);
  expect(within(cell('fecha')).getByText('ao fazer merge')).toHaveClass('text-muted-foreground');
  unmount();
  renderBlock(prData({ closes: CLOSES, state: 'merged' }));
  expect(within(cell('fecha')).queryByText('ao fazer merge')).toBeNull();
});
