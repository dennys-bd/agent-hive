import { randomUUID } from 'node:crypto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GitlabAccountsGroup } from '@/components/settings/GitlabAccountsGroup';
import { GITLAB_REFUSAL_KEY } from '@/components/settings/GitlabConnectForm';
import { setLanguage, t } from '@/i18n';
import { GITLAB_ACCOUNT_ERRORS, type GitlabAccountRow } from '../../src/types';

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ROUTE = '/settings/accounts/gitlab';
const TOKEN = `glpat-test-${randomUUID()}`; // built at runtime: no token in a fixture
const COM: GitlabAccountRow = { host: 'gitlab.com', username: 'ana', expiresAt: '2999-12-31' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type User = ReturnType<typeof userEvent.setup>;

// The list answers the rows as they stand; the connect answers what the test's `post` gives
function daemon(post: () => Response) {
  const state = { rows: [] as GitlabAccountRow[] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === ROUTE && init?.method === 'POST') return post();
    return url === ROUTE ? json({ accounts: state.rows }) : json({ error: 'raw route error' }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, fetch };
}
const addButton = (): HTMLElement => screen.getByRole('button', { name: t('settings.accounts.add.gitlab.name') });
const tokenField = (): HTMLElement => screen.getByLabelText(t('settings.accounts.gitlab.token'));
const hostSelect = (): HTMLElement => screen.getByRole('combobox', { name: t('settings.accounts.gitlab.host') });
const connectButton = (): HTMLElement => screen.getByRole('button', { name: t('settings.accounts.gitlab.connect') });
async function openForm(user: User): Promise<void> {
  await waitFor(() => expect(screen.queryByText(t('settings.accounts.loading'))).toBeNull());
  await user.click(addButton());
}
async function pick(user: User, host: string): Promise<void> {
  await user.click(hostSelect());
  await user.click(screen.getByRole('option', { name: host }));
}

test('the host select offers gitlab.com, then the saved GitLab hosts; the hint links to the chosen host\'s token page with name and api prefilled; the token field is a password (#1048)', async () => {
  const user = userEvent.setup();
  daemon(() => json(COM));
  render(<GitlabAccountsGroup hosts={['git.example.com', 'code.example.org']} />);
  await openForm(user);
  const link = screen.getByRole('link', { name: t('settings.accounts.gitlab.tokenLink') });
  expect(link).toHaveAttribute('href', 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Agent%20Hive&scopes=api');
  expect(link).toHaveAttribute('target', '_blank');
  await user.click(hostSelect());
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['gitlab.com', 'git.example.com', 'code.example.org']);
  await user.click(screen.getByRole('option', { name: 'git.example.com' }));
  expect(link).toHaveAttribute('href', 'https://git.example.com/-/user_settings/personal_access_tokens?name=Agent%20Hive&scopes=api');
  expect(tokenField()).toHaveAttribute('type', 'password');
});

test('a connect posts the host and the token, closes the form, re-reads the list and announces the account; the token is gone from the page (#1048)', async () => {
  const user = userEvent.setup();
  const harness = daemon(() => { harness.state.rows = [COM]; return json(COM); });
  render(<GitlabAccountsGroup hosts={[]} />);
  await openForm(user);
  await user.type(tokenField(), TOKEN);
  await user.click(connectButton());
  expect(await within(await screen.findByRole('list', { name: 'gitlab' })).findByText('gitlab.com')).toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.accounts.gitlab.token'))).toBeNull();
  expect(screen.getByText(t('settings.accounts.add.done', { name: 'ana · gitlab.com' }))).toHaveClass('sr-only');
  const post = harness.fetch.mock.calls.find(([url, init]) => url === ROUTE && init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ host: 'gitlab.com', token: TOKEN });
  expect(document.body.innerHTML).not.toContain(TOKEN);
});

test('each refusal shows in our words; the form stays open on the host chosen, with the token cleared; a failure with no code of ours reads as failed, never the route\'s words (#1048)', async () => {
  const user = userEvent.setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let answer = json({ error: 'host' }, 400);
  daemon(() => answer);
  render(<GitlabAccountsGroup hosts={['git.example.com']} />);
  await openForm(user);
  await pick(user, 'git.example.com');
  for (const code of GITLAB_ACCOUNT_ERRORS) {
    answer = json({ error: code }, 422);
    await user.type(tokenField(), TOKEN);
    await user.click(connectButton());
    expect(await screen.findByText(t(GITLAB_REFUSAL_KEY[code]))).toBeInTheDocument();
    expect(tokenField()).toHaveValue('');
    expect(hostSelect()).toHaveTextContent('git.example.com');
  }
  answer = json({ error: 'gitlab account not stored' }, 500);
  await user.type(tokenField(), TOKEN);
  await user.click(connectButton());
  expect(await screen.findByText(t(GITLAB_REFUSAL_KEY.failed))).toBeInTheDocument();
  expect(screen.queryByText(/not stored/)).toBeNull();
  expect(document.body.innerHTML).not.toContain(TOKEN);
});

test('the header\'s add is hidden in place while the form is open; cancel and Escape close it (#1048)', async () => {
  const user = userEvent.setup();
  daemon(() => json(COM));
  render(<GitlabAccountsGroup hosts={[]} />);
  await openForm(user);
  expect(addButton()).toHaveClass('invisible');
  await user.click(screen.getByRole('button', { name: t('settings.accounts.add.cancel') }));
  expect(screen.queryByLabelText(t('settings.accounts.gitlab.token'))).toBeNull();
  expect(addButton()).not.toHaveClass('invisible');
  await user.click(addButton());
  fireEvent.keyDown(tokenField(), { key: 'Escape' });
  expect(screen.queryByLabelText(t('settings.accounts.gitlab.token'))).toBeNull();
});
