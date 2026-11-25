import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GitlabAccountsGroup } from '@/components/settings/GitlabAccountsGroup';
import { setLanguage, t } from '@/i18n';
import type { GitlabAccountRow } from '../../src/types';

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ROUTE = '/settings/accounts/gitlab';
const COM: GitlabAccountRow = { host: 'gitlab.com', username: 'ana', expiresAt: '2999-12-31' };
const OLD: GitlabAccountRow = { host: 'git.example.com', username: 'ana.work', expiresAt: '2020-01-31' };
const NEVER: GitlabAccountRow = { host: 'code.example.org', username: 'bob' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Reply = () => Response;

// The list route answers the rows as they stand; any other call a test answers itself by `METHOD url`, else a raw 404 the screen never shows
function daemon(rows: GitlabAccountRow[], replies: Record<string, Reply> = {}) {
  const state = { rows };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = replies[`${init?.method ?? 'GET'} ${url}`];
    if (reply !== undefined) return reply();
    return url === ROUTE && init?.method === undefined ? json({ accounts: state.rows }) : json({ error: 'raw route error' }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, fetch };
}
const list = (): HTMLElement => screen.getByRole('list', { name: 'gitlab' });
const removeOf = (name: string): HTMLElement => screen.getByRole('button', { name: t('settings.accounts.remove.label', { name }) });
const confirmRemove = (host: string): void => {
  fireEvent.click(removeOf(host));
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.remove.confirm') }));
};
const deletes = (fetch: ReturnType<typeof daemon>['fetch'], host: string): number =>
  fetch.mock.calls.filter(([url, init]) => url === `${ROUTE}/${host}` && init?.method === 'DELETE').length;

test('a row per account in the route\'s order: the host, the username muted and the expiry note; a past date reads expired in the waiting colour, a token that never expires has none; no radio (#1048)', async () => {
  daemon([OLD, NEVER, COM]);
  render(<GitlabAccountsGroup hosts={[]} />);
  await screen.findByText('gitlab.com');
  expect(within(list()).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
    `git.example.comana.work${t('settings.accounts.gitlab.expired')}`,
    'code.example.orgbob',
    `gitlab.comana${t('settings.accounts.gitlab.expires', { date: '2999-12-31' })}`,
  ]);
  expect(screen.getByText('ana.work')).toHaveClass('text-muted-foreground');
  expect(screen.getByText(t('settings.accounts.gitlab.expired'))).toHaveClass('text-waiting');
  expect(screen.getByText(t('settings.accounts.gitlab.expires', { date: '2999-12-31' }))).toHaveClass('text-muted-foreground');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByText('gitlab', { selector: 'span' })).toHaveClass('font-semibold');
});

test('until the list answers the group shows the reading line; a failed read, or an answer that is no list of rows, says so in our words and try again reads it again (#1048)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const answers = [json({ error: 'raw route error' }, 500), json({ accounts: [{ host: 'gitlab.com' }] }), json({ accounts: [COM] })];
  const { fetch } = daemon([], { [`GET ${ROUTE}`]: () => answers.shift() ?? json({ accounts: [] }) });
  render(<GitlabAccountsGroup hosts={[]} />);
  expect(screen.getByText(t('settings.accounts.loading'))).toBeInTheDocument();
  expect(await screen.findByText(t('settings.accounts.failed.gitlab'))).toBeInTheDocument();
  expect(screen.queryByText(/raw route error/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.retry') }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === ROUTE)).toHaveLength(2));
  expect(await screen.findByText(t('settings.accounts.failed.gitlab'))).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.retry') }));
  expect(await screen.findByText('gitlab.com')).toBeInTheDocument();
  expect(console.error).toHaveBeenCalled();
});

test('remove takes the confirm, deletes by host and re-reads; a 404 re-reads with no line; another failure says so in our words with try again (#1048)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { state, fetch } = daemon([COM, OLD, NEVER], {
    [`DELETE ${ROUTE}/gitlab.com`]: () => { state.rows = state.rows.filter((row) => row.host !== 'gitlab.com'); return new Response(null, { status: 204 }); },
    [`DELETE ${ROUTE}/git.example.com`]: () => { state.rows = state.rows.filter((row) => row.host !== 'git.example.com'); return json({ error: 'unknown' }, 404); },
    [`DELETE ${ROUTE}/code.example.org`]: () => json({ error: 'gitlab account not removed' }, 500),
  });
  render(<GitlabAccountsGroup hosts={[]} />);
  await screen.findByText('gitlab.com');
  confirmRemove('gitlab.com');
  await waitFor(() => expect(screen.queryByText('gitlab.com')).toBeNull());
  confirmRemove('git.example.com');
  await waitFor(() => expect(screen.queryByText('git.example.com')).toBeNull());
  expect(screen.queryByText(t('settings.accounts.remove.failed', { name: 'git.example.com' }))).toBeNull();
  confirmRemove('code.example.org');
  expect(await screen.findByText(t('settings.accounts.remove.failed', { name: 'code.example.org' }))).toBeInTheDocument();
  expect(screen.queryByText(/not removed/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.retry') }));
  await waitFor(() => expect(deletes(fetch, 'code.example.org')).toBe(2));
  expect(deletes(fetch, 'gitlab.com')).toBe(1);
});
