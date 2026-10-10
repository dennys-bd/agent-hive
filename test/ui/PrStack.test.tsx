import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { PrStack } from '@/components/PrStack';
import { setLanguage } from '@/i18n';
import type { State, TaskPr } from '../../src/types';
import { prData, WITH_TASK } from './pr-harness';

const APP = 'https://github.com/acme/app/pull/';
const DOCS = 'https://github.com/acme/docs/pull/88';
beforeEach(() => setLanguage('pt'));
// task I1's PRs: a stack of three in acme/app, this page's #7 second, and one PR in acme/docs
const withPrs = (prs: TaskPr[]): State => ({ ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs }] });
const stack = (first: TaskPr['state']): TaskPr[] => [
  { url: `${APP}6`, state: first, slice: { k: 1, type: 'stacked' } }, { url: `${APP}7`, state: 'open', slice: { k: 2, type: 'stacked' } },
  { url: `${APP}9`, state: 'open', slice: { k: 3, type: 'stacked' } }, { url: DOCS, state: 'open' },
];
const renderStack = (state: State) => {
  const onOpenPr = vi.fn();
  render(<PrStack pr={prData()} task={state.tasks[0]} state={state} onOpenPr={onOpenPr} />);
  return onOpenPr;
};

test('the stack lists the task\'s PRs in this repository by k, this PR in foreground, then the other repositories\' after a divider; a part opens its page (#758)', async () => {
  const user = userEvent.setup();
  const onOpenPr = renderStack(withPrs(stack('merged')));
  const region = within(screen.getByRole('region', { name: 'pilha' }));
  expect(region.getByRole('button', { name: '1/3 #6 mergeado' })).toBeInTheDocument();
  expect(region.getByText('este PR').parentElement).toHaveClass('text-foreground');
  expect(region.queryByRole('button', { name: /#7/ })).toBeNull();
  expect(region.getByText('fora da pilha')).toBeInTheDocument();
  expect(region.queryByText(/^base/)).toBeNull(); // #7's base, #6, is merged
  await user.click(region.getByRole('button', { name: '3/3 #9 aberto' }));
  await user.click(region.getByRole('button', { name: '#88 docs' }));
  expect(onOpenPr.mock.calls).toEqual([[`${APP}9`], [DOCS]]);
  expect(region.getByText('#88')).toHaveClass('text-review');
});

test('base #N shows while this PR\'s base PR is open; a task with one PR has no stack (#758)', () => {
  renderStack(withPrs(stack('open')));
  expect(within(screen.getByRole('region', { name: 'pilha' })).getByText('base #6')).toBeInTheDocument();
});

test('a task that holds this PR alone shows no stack (#758)', () => {
  renderStack(WITH_TASK);
  expect(screen.queryByRole('region', { name: 'pilha' })).toBeNull();
});
