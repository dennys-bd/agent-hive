import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TaskPrList } from '@/components/TaskPrList';
import { setLanguage } from '@/i18n';
import type { PrChecks, State, TaskPr } from '../../src/types';
import { WITH_TASK } from './pr-harness';

const APP = 'https://github.com/acme/app/pull/';
const DOCS = 'https://github.com/acme/docs/pull/88';
const AT = '2026-10-05T09:00:00Z';
const withPrs = (prs: TaskPr[]): State => ({ ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs }] });
// A stack of three in acme/app, arriving out of merge order, the first merged; then one PR in acme/docs
const PRS: TaskPr[] = [
  { url: `${APP}9`, state: 'open', slice: { k: 3, type: 'stacked' } }, { url: `${APP}6`, state: 'merged', slice: { k: 1, type: 'stacked' } },
  { url: `${APP}7`, state: 'open', slice: { k: 2, type: 'stacked' } }, { url: DOCS, state: 'open' },
];
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const read = (state: PrChecks['state']) => ({ checks: { state, items: [] }, mergeState: 'clean', updatedAt: AT });
// #7 passes, #9 fails; acme/docs is no listed repository: its checks route answers 404
const answer = async (input: RequestInfo | URL): Promise<Response> => {
  if (String(input) === '/repositories/acme/app/pulls/7/checks') return jsonRes(read('success'));
  if (String(input) === '/repositories/acme/app/pulls/9/checks') return jsonRes(read('failure'));
  return jsonRes({ error: 'Not Found' }, 404);
};
const fetchMock = vi.fn(answer);
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderList = (state: State = withPrs(PRS)) => {
  const onOpenPr = vi.fn();
  const view = render(<TaskPrList task={WITH_TASK.tasks[0]} state={state} onOpenPr={onOpenPr} />);
  return { ...view, onOpenPr };
};
const lines = (): HTMLElement[] => within(screen.getByRole('region', { name: 'PRs' })).getAllByRole('listitem');

test('the PRs list: the own repository\'s PRs in merge order with k/n, the number and the state, then another repository\'s "fora da pilha"; abrir only on an open PR, handing its url to onOpenPr (#65)', async () => {
  const user = userEvent.setup();
  const { onOpenPr } = renderList();
  expect(lines().map((li) => li.firstElementChild?.textContent)).toEqual(['1/3 #6 mergeado', '2/3 #7 aberto', '3/3 #9 aberto', '#88 docs · fora da pilha · aberto']);
  expect(within(lines()[0]).queryByRole('button', { name: 'abrir' })).not.toBeInTheDocument();
  await user.click(within(lines()[2]).getByRole('button', { name: 'abrir' }));
  await user.click(within(lines()[3]).getByRole('button', { name: 'abrir' }));
  expect(onOpenPr.mock.calls).toEqual([[`${APP}9`], [DOCS]]);
});

test('each open PR\'s checks are read once: ✓ in green on success, ✗ in red on failure; none for a merged PR or a failed read (#65)', async () => {
  renderList();
  const passed = await within(lines()[1]).findByTitle('checks passaram');
  expect(passed).toHaveTextContent('✓');
  expect(passed).toHaveClass('text-working');
  expect(await within(lines()[2]).findByTitle('checks falharam')).toHaveClass('text-destructive');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
    '/repositories/acme/app/pulls/7/checks', '/repositories/acme/app/pulls/9/checks', '/repositories/acme/docs/pulls/88/checks',
  ]);
  expect(within(lines()[0]).queryByTitle(/^checks/)).toBeNull();
  expect(within(lines()[3]).queryByTitle(/^checks/)).toBeNull();
});

test('a task with no PR renders nothing (#65)', () => {
  const { container } = renderList(withPrs([]));
  expect(container).toBeEmptyDOMElement();
  expect(fetchMock).not.toHaveBeenCalled();
});
