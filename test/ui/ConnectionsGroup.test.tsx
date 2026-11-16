import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConnectionsGroup } from '@/components/settings/ConnectionsGroup';
import { JIRA_FORM_KEYS, REFUSAL_KEY, REFUSAL_RECONNECT_KEY, STATE_KEY } from '@/components/settings/JiraConnections';
import { setLanguage, t } from '@/i18n';
import type { JiraConnectError, JiraSiteStatus } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const SITE = 'acme.atlassian.net';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let listed: JiraSiteStatus[];
let refusal: JiraConnectError | undefined;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (init?.method === 'POST') {
    if (refusal) return json({ error: refusal }, 400);
    listed = [{ site: SITE, state: 'connected', name: 'Ana' }];
    return json(listed[0]);
  }
  if (init?.method === 'DELETE') {
    listed = listed.filter((s) => url !== `/settings/jira/sites/${encodeURIComponent(s.site)}`);
    return new Response(null, { status: 204 });
  }
  return json(listed);
});

beforeEach(() => { setLanguage('pt'); listed = []; refusal = undefined; fetchMock.mockClear(); vi.mocked(toast.error).mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

type User = ReturnType<typeof userEvent.setup>;

const fillAndSubmit = async (user: User, submit: string): Promise<void> => {
  const site = screen.getByLabelText(t(JIRA_FORM_KEYS.site));
  if (!(site as HTMLInputElement).readOnly) await user.type(site, 'https://Acme.atlassian.net/');
  await user.type(screen.getByLabelText(t(JIRA_FORM_KEYS.email)), 'ana@example.com');
  await user.type(screen.getByLabelText(t(JIRA_FORM_KEYS.token)), 'fake-token-817');
  await user.click(screen.getByRole('button', { name: submit }));
};

const openAndFill = async (user: User): Promise<void> => {
  await user.click(screen.getByRole('button', { name: t('settings.connections.add') }));
  await fillAndSubmit(user, t(JIRA_FORM_KEYS.submit));
};

test('the card renders with no GitHub source: no GitHub row, + conexão enabled, the empty line once no site is listed (#817)', async () => {
  render(<ConnectionsGroup />);
  expect(screen.getByRole('heading', { level: 2, name: t('settings.connections') })).toBeInTheDocument();
  expect(screen.queryByTestId('connection-row')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.connections.add') })).toBeEnabled();
  expect(await screen.findByText(t('settings.connections.empty'))).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/jira/sites'));
});

test('+ conexão opens the form; the empty line gives way and the token field is a password input (#817)', async () => {
  const user = userEvent.setup();
  render(<ConnectionsGroup />);
  await screen.findByText(t('settings.connections.empty'));
  await user.click(screen.getByRole('button', { name: t('settings.connections.add') }));
  expect(screen.getByLabelText(t(JIRA_FORM_KEYS.token))).toHaveAttribute('type', 'password');
  expect(screen.getByRole('link', { name: t(JIRA_FORM_KEYS.tokenLink) })).toHaveAttribute('href', 'https://id.atlassian.com/manage-profile/security/api-tokens');
  expect(screen.queryByText(t('settings.connections.empty'))).not.toBeInTheDocument();
});

test('each listed site shows its state: a connected one with the account name (#817)', async () => {
  listed = [{ site: SITE, state: 'connected', name: 'Ana' }, { site: 'gone.atlassian.net', state: 'refused' }, { site: 'down.atlassian.net', state: 'unreachable' }];
  render(<ConnectionsGroup />);
  const sites = await screen.findAllByTestId('jira-site');
  expect(sites).toHaveLength(3);
  expect(within(sites[0]).getByText(SITE, { exact: false })).toBeInTheDocument();
  expect(within(sites[0]).getByText(t(STATE_KEY.connected, { name: 'Ana' }), { exact: false })).toBeInTheDocument();
  expect(within(sites[1]).getByText(t(STATE_KEY.refused), { exact: false })).toHaveClass('text-destructive');
  expect(within(sites[2]).getByText(t(STATE_KEY.unreachable), { exact: false })).toHaveClass('text-waiting');
  expect(within(sites[2]).getByText(t('settings.connections.jira.loginKept'), { exact: false })).toBeInTheDocument();
});

test('connecting adds the site; each refusal code shows its own copy inline, with no toast (#817)', async () => {
  const user = userEvent.setup();
  render(<ConnectionsGroup />);
  for (const code of ['invalid-site', 'refused', 'unreachable'] as const) {
    refusal = code;
    await openAndFill(user);
    expect(await screen.findByText(t(REFUSAL_KEY[code]))).toBeInTheDocument();
    if (code === 'invalid-site') expect(screen.getByLabelText(t(JIRA_FORM_KEYS.site))).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: t(JIRA_FORM_KEYS.cancel) }));
  }
  expect(toast.error).not.toHaveBeenCalled();
  refusal = undefined;
  await openAndFill(user);
  expect(await screen.findByText(t(STATE_KEY.connected, { name: 'Ana' }), { exact: false })).toBeInTheDocument();
  expect(screen.queryByLabelText(t(JIRA_FORM_KEYS.token))).not.toBeInTheDocument(); // the form closed
  expect(screen.queryByDisplayValue('fake-token-817')).not.toBeInTheDocument();
});

test('invalid-site points the site field at its message (#817)', async () => {
  const user = userEvent.setup();
  refusal = 'invalid-site';
  render(<ConnectionsGroup />);
  await openAndFill(user);
  const message = await screen.findByText(t(REFUSAL_KEY['invalid-site']));
  expect(screen.getByLabelText(t(JIRA_FORM_KEYS.site))).toHaveAttribute('aria-describedby', message.parentElement?.id);
});

test('reconnect opens the form in place of the row, site read-only, and a refusal says the login stays (#817)', async () => {
  const user = userEvent.setup();
  listed = [{ site: SITE, state: 'refused' }];
  render(<ConnectionsGroup />);
  await user.click(within(await screen.findByTestId('jira-site')).getByRole('button', { name: t(JIRA_FORM_KEYS.reconnect) }));
  expect(screen.queryByTestId('jira-site')).not.toBeInTheDocument();
  expect(screen.getByLabelText(t(JIRA_FORM_KEYS.site))).toHaveValue(SITE);
  expect(screen.getByLabelText(t(JIRA_FORM_KEYS.site))).toHaveAttribute('readonly');
  refusal = 'refused';
  await fillAndSubmit(user, t(JIRA_FORM_KEYS.reconnect));
  expect(await screen.findByText(t(REFUSAL_RECONNECT_KEY.refused))).toBeInTheDocument();
});

test('disconnect asks with the dialog, calls DELETE, and the site goes away (#817)', async () => {
  const user = userEvent.setup();
  listed = [{ site: SITE, state: 'connected', name: 'Ana' }];
  render(<ConnectionsGroup />);
  await user.click(within(await screen.findByTestId('jira-site')).getByRole('button', { name: t(JIRA_FORM_KEYS.disconnect) }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText(t('settings.connections.jira.offTitle', { site: SITE }))).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining(SITE), expect.objectContaining({ method: 'DELETE' }));
  await user.click(within(dialog).getByRole('button', { name: t(JIRA_FORM_KEYS.disconnect) }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/settings/jira/sites/${encodeURIComponent(SITE)}`, expect.objectContaining({ method: 'DELETE' })));
  await waitFor(() => expect(screen.queryByTestId('jira-site')).not.toBeInTheDocument());
});
