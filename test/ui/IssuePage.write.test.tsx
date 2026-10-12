import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IssuePage } from '@/components/IssuePage';
import { setLanguage } from '@/i18n';
import { WithSlot } from './detail-slot-harness';
import type { IssuePage as Issue, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const ISSUE: Issue = {
  repository: 'acme/site', number: 12, title: 'Pager breaks', url: 'https://github.com/acme/site/issues/12', labels: ['bug'], assignees: [], updatedAt: '2026-10-05T09:00:00Z',
  body: 'b', author: 'bia', createdAt: '2026-10-01T09:00:00Z', pullRequests: [], comments: [], commentCount: 0,
};
const STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: {}, prompt: 'x' }], tasks: [], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const ROUTE = '/repositories/acme/site/issues/12';
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (init?.method === 'POST') return jsonRes({ ok: true });
  return jsonRes(String(input) === '/repositories/acme/site/labels' ? ['bug', 'docs', 'ui'] : ISSUE);
};
const fetchMock = vi.fn(answer);
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// Beside the details panel's slot (#64): the labels are the properties' and render there
const renderPage = () => render(
  <IssuePage state={STATE} issue={{ repository: 'acme/site', number: 12 }} meta="acme/site" workspace="site" header={() => null} onGoTo={vi.fn()} onOpenPr={vi.fn()} />,
  { wrapper: WithSlot },
);
const posted = (path: string): unknown[] => fetchMock.mock.calls.filter(([input, init]) => String(input) === path && init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));
const reads = (): number => fetchMock.mock.calls.filter(([input, init]) => String(input) === ROUTE && init?.method !== 'POST').length;

test('the labels: + lists the repository\'s as checkboxes, a toggle posts at once and the page reads again; a chip\'s × removes it (#757)', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('button', { name: 'adicionar label' }); // the page's title and the slot's both read Pager breaks: an issue out of the flow
  await user.click(screen.getByRole('button', { name: 'adicionar label' }));
  expect(await screen.findByRole('checkbox', { name: 'bug' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'docs' })).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'docs' }));
  await waitFor(() => expect(posted(`${ROUTE}/labels`)).toEqual([{ add: ['docs'], remove: [] }]));
  await waitFor(() => expect(reads()).toBe(2));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'remover bug' }));
  await waitFor(() => expect(posted(`${ROUTE}/labels`)).toEqual([{ add: ['docs'], remove: [] }, { add: [], remove: ['bug'] }]));
});

test('a comment posts to the issue, clears the box and reads the page again; comentar waits for a body (#757)', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('button', { name: 'adicionar label' }); // the page's title and the slot's both read Pager breaks: an issue out of the flow
  expect(screen.getByText('publica em acme/site · github')).toBeInTheDocument();
  const send = screen.getByRole('button', { name: /^comentar/ });
  expect(send).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'comentar na issue…' }), 'Looks good');
  await user.click(send);
  await waitFor(() => expect(posted(`${ROUTE}/comments`)).toEqual([{ body: 'Looks good' }]));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'comentar na issue…' })).toHaveValue(''));
  expect(reads()).toBe(2);
});

test('a failed labels read shows a muted error line instead of reading… forever (#757)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (input) => (String(input) === '/repositories/acme/site/labels' ? jsonRes({ error: 'boom' }, 502) : jsonRes(ISSUE)));
  renderPage();
  await screen.findByRole('button', { name: 'adicionar label' }); // the page's title and the slot's both read Pager breaks: an issue out of the flow
  await user.click(screen.getByRole('button', { name: 'adicionar label' }));
  expect(await screen.findByText('não foi possível ler as labels')).toBeInTheDocument();
  expect(screen.queryByText('lendo…')).not.toBeInTheDocument();
});
