import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IssuePage } from '@/components/IssuePage';
import { setLanguage } from '@/i18n';
import type { IssuePage as Issue, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const U1 = '2026-10-05T09:00:00Z';
const U2 = '2026-10-06T10:00:00Z';
const ISSUE: Issue = {
  repository: 'acme/site', number: 12, title: 'Pager breaks', url: 'https://github.com/acme/site/issues/12', labels: [], assignees: [], updatedAt: U1,
  body: 'The pager breaks', author: 'bia', createdAt: '2026-10-01T09:00:00Z', pullRequests: [], comments: [], commentCount: 0,
};
const STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: {}, prompt: 'x' }], tasks: [], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['site'], sourceWorkspaces: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const CHANGED = 'a issue mudou no GitHub; recarregada. seu rascunho continua no campo.';
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let reads = 0;
let refusals = 0; // how many POSTs answer 409 before GitHub takes one
const answer = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (init?.method === 'POST') {
    if (refusals === 0) return jsonRes({ ok: true });
    refusals -= 1;
    return jsonRes({ error: 'the issue changed on GitHub since it was read' }, 409);
  }
  reads += 1;
  return jsonRes(reads === 1 ? ISSUE : { ...ISSUE, title: 'Pager breaks on GitHub', updatedAt: U2 });
};
const fetchMock = vi.fn(answer);
beforeEach(() => {
  setLanguage('pt');
  reads = 0;
  refusals = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(
  <IssuePage state={STATE} issue={{ repository: 'acme/site', number: 12 }} meta="acme/site" workspace="site" header={() => null} onGoTo={vi.fn()} onOpenPr={vi.fn()} />,
);
const posts = (): unknown[] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));

test('a title edit posts with the updatedAt read; a 409 says so, reloads, keeps the draft, and the next save sends the reloaded updatedAt (#757)', async () => {
  const user = userEvent.setup();
  refusals = 1;
  renderPage();
  await screen.findByRole('heading', { name: 'Pager breaks' });
  await user.click(screen.getAllByRole('button', { name: 'editar' })[0]);
  const field = screen.getByRole('textbox', { name: 'título' });
  await user.clear(field);
  await user.type(field, 'Pager fixed');
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  expect(await screen.findByText(CHANGED)).toBeInTheDocument();
  expect(toast.error).toHaveBeenCalledWith(CHANGED);
  expect(screen.getByRole('textbox', { name: 'título' })).toHaveValue('Pager fixed');
  expect(posts()).toEqual([{ title: 'Pager fixed', updatedAt: U1 }]);
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/issues/12', expect.objectContaining({ method: 'POST' }));
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'título' })).not.toBeInTheDocument());
  expect(posts()).toEqual([{ title: 'Pager fixed', updatedAt: U1 }, { title: 'Pager fixed', updatedAt: U2 }]);
});

test('the description edits in place: Esc cancels and posts nothing, ⌘↵ saves and the page reads the issue again (#757)', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('heading', { name: 'Pager breaks' });
  await user.click(screen.getAllByRole('button', { name: 'editar' })[1]);
  await user.type(screen.getByRole('textbox', { name: 'descrição' }), ' now');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('textbox', { name: 'descrição' })).not.toBeInTheDocument();
  expect(posts()).toEqual([]);
  await user.click(screen.getAllByRole('button', { name: 'editar' })[1]);
  expect(screen.getByRole('textbox', { name: 'descrição' })).toHaveValue('The pager breaks');
  await user.type(screen.getByRole('textbox', { name: 'descrição' }), ' now');
  await user.keyboard('{Meta>}{Enter}{/Meta}');
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'descrição' })).not.toBeInTheDocument());
  expect(posts()).toEqual([{ body: 'The pager breaks now', updatedAt: U1 }]);
  expect(reads).toBe(2);
});
