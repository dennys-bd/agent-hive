import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AccountsCard } from '@/components/settings/AccountsCard';
import { setLanguage, t } from '@/i18n';
import { draftFrom } from '@/lib/settings-form';
import type { ClaudeAddStatus, GithubAddStatus } from '../../src/types';

beforeEach(() => { setLanguage('pt'); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const CLAUDE_ADD = '/settings/accounts/claude/add';
const GITHUB_ADD = '/settings/github/add';
const LINK = 'https://example.com/sign-in';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The daemon as the card sees it: both lists and both adds, which a test changes between ticks. post answers the next POST once, when
// it is not the add's own status; calls and bodies record what the card sent
interface Daemon { claude: string[]; github: string[]; claudeAdd: ClaudeAddStatus; githubAdd: GithubAddStatus; post?: Response; calls: string[]; bodies: unknown[] }
function daemon(): Daemon {
  const d: Daemon = { claude: ['personal'], github: ['alice'], claudeAdd: { state: 'idle' }, githubAdd: { state: 'idle' }, calls: [], bodies: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    d.calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') {
      d.bodies.push(init.body);
      const post = d.post;
      d.post = undefined;
      return post ?? json(url === CLAUDE_ADD ? d.claudeAdd : d.githubAdd, 202);
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const reads: Record<string, unknown> = { '/settings/accounts/claude': { names: d.claude }, '/settings/github/accounts': { logins: d.github }, [CLAUDE_ADD]: d.claudeAdd, [GITHUB_ADD]: d.githubAdd };
    return reads[url] === undefined ? json({ error: 'raw route error' }, 404) : json(reads[url]);
  }));
  return d;
}
const count = (d: Daemon, call: string): number => d.calls.filter((c) => c === call).length;
const tick = (): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
const renderCard = (onChange = vi.fn()) => render(<AccountsCard draft={draftFrom(undefined)} saved={{}} onChange={onChange} onOpenFlow={vi.fn()} />);
const read = () => screen.findByRole('radio', { name: 'personal' });
const radios = (name: string): HTMLElement => screen.getByRole('radiogroup', { name });
const nameField = (): HTMLElement => screen.getByRole('textbox', { name: t('settings.accounts.add.name.label') });
const claudeRow = async (): Promise<HTMLElement> =>
  (await screen.findByText(t('settings.accounts.add.claude.pending'), { exact: false })).closest('[role="status"]') as HTMLElement;
async function startClaude(d: Daemon, name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.claude') }));
  fireEvent.change(nameField(), { target: { value: name } });
  d.claudeAdd = { state: 'pending', name };
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.submit') }));
  return claudeRow();
}

test('claude\'s add: the name, then the wait with the sign-in link once known; connected reads the list again and the new name shows, not chosen, the form untouched (#965)', async () => {
  const d = daemon();
  const onChange = vi.fn();
  renderCard(onChange);
  await read();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.claude') }));
  expect(nameField()).toHaveFocus();
  expect(screen.getByText(t('settings.accounts.add.name.hint'))).toBeInTheDocument();
  fireEvent.change(nameField(), { target: { value: 'work' } });
  d.claudeAdd = { state: 'pending', name: 'work' };
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.submit') }));
  const row = await claudeRow();
  expect(within(row).getByText('work')).toBeInTheDocument();
  expect(within(row).queryByRole('link')).toBeNull();
  expect(d.bodies).toEqual([JSON.stringify({ name: 'work' })]);
  d.claudeAdd = { state: 'pending', name: 'work', url: LINK };
  await tick();
  expect(await within(row).findByRole('link', { name: t('settings.accounts.add.claude.link') })).toHaveAttribute('href', LINK);
  d.claude = ['personal', 'work'];
  d.claudeAdd = { state: 'connected', name: 'work' };
  await tick();
  expect(await within(radios('claude')).findByRole('radio', { name: 'work' })).not.toBeChecked();
  expect(screen.queryByText(t('settings.accounts.add.claude.pending'), { exact: false })).toBeNull();
  expect(screen.getByText(t('settings.accounts.add.done', { name: 'work' }))).toHaveClass('sr-only');
  expect(onChange).not.toHaveBeenCalled();
  const polls = count(d, `GET ${CLAUDE_ADD}`);
  await tick();
  expect(count(d, `GET ${CLAUDE_ADD}`), 'connected is terminal: the poll stopped').toBe(polls);
});

test('a refused name shows its copy at the field, marks it invalid and keeps what was typed (#965)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = daemon();
  renderCard();
  await read();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.claude') }));
  const refusals = [
    ['', 'name-empty', t('settings.accounts.add.refused.name-empty')],
    ['x'.repeat(41), 'name-too-long', t('settings.accounts.add.refused.name-too-long', { max: 40 })],
    ['Personal', 'name-taken', t('settings.accounts.add.refused.name-taken')],
  ] as const;
  for (const [typed, refusal, copy] of refusals) {
    fireEvent.change(nameField(), { target: { value: typed } });
    d.post = json({ error: refusal }, 400);
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.submit') }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(copy));
    expect((nameField() as HTMLInputElement).value).toBe(typed);
    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
  }
  expect(screen.getByRole('alert')).not.toHaveTextContent('name-taken');
});

test('a failed claude add says why in our words, never the route\'s, keeps the name, and try again posts it again (#965)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = daemon();
  renderCard();
  await read();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.claude') }));
  fireEvent.change(nameField(), { target: { value: 'work' } });
  d.post = json({ error: 'raw route error' }, 500);
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.submit') }));
  expect(await screen.findByText(t('settings.accounts.add.failed.exited'))).toBeInTheDocument();
  expect(screen.queryByText(/raw route error/)).toBeNull();
  expect(nameField()).toHaveValue('work');
  expect(screen.queryByText(t('settings.accounts.add.name.hint'))).toBeNull();
  d.claudeAdd = { state: 'pending', name: 'work' };
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.retry') }));
  await claudeRow();
  d.claudeAdd = { state: 'failed', name: 'work', reason: 'timeout' };
  await tick();
  expect(await screen.findByText(t('settings.accounts.add.failed.timeout'))).toBeInTheDocument();
  expect(nameField()).toHaveValue('work');
  d.claudeAdd = { state: 'pending', name: 'work' };
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.retry') }));
  await claudeRow();
  expect(d.bodies).toEqual([1, 2, 3].map(() => JSON.stringify({ name: 'work' })));
});

test('cancel calls DELETE …/add, stops the poll and puts the group at rest; a cancelled status read later does too (#965)', async () => {
  const d = daemon();
  renderCard();
  await read();
  const row = await startClaude(d, 'work');
  fireEvent.click(within(row).getByRole('button', { name: t('settings.accounts.add.cancel') }));
  expect(screen.queryByText(t('settings.accounts.add.claude.pending'), { exact: false })).toBeNull();
  await waitFor(() => expect(d.calls).toContain(`DELETE ${CLAUDE_ADD}`));
  const polls = count(d, `GET ${CLAUDE_ADD}`);
  await tick();
  await tick();
  expect(count(d, `GET ${CLAUDE_ADD}`)).toBe(polls);
  expect(screen.getByRole('button', { name: t('settings.accounts.add.claude') })).not.toHaveClass('invisible');
  await startClaude(d, 'work');
  expect(screen.getByRole('button', { name: t('settings.accounts.add.claude') })).toHaveClass('invisible');
  d.claudeAdd = { state: 'cancelled', name: 'work' };
  await tick();
  await waitFor(() => expect(screen.queryByText(t('settings.accounts.add.claude.pending'), { exact: false })).toBeNull());
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('mounting with an add pending resumes the wait with its name and link; a connected or failed one from an earlier visit leaves the group at rest (#965)', async () => {
  const d = daemon();
  d.claudeAdd = { state: 'pending', name: 'work', url: LINK };
  const first = renderCard();
  const row = await claudeRow();
  expect(within(row).getByText('work')).toBeInTheDocument();
  expect(within(row).getByRole('link', { name: t('settings.accounts.add.claude.link') })).toHaveAttribute('href', LINK);
  first.unmount();
  const stale: readonly ClaudeAddStatus[] = [{ state: 'connected', name: 'work' }, { state: 'failed', name: 'work', reason: 'store' }];
  for (const status of stale) {
    d.claudeAdd = status;
    const shown = renderCard();
    await read();
    await tick();
    expect(screen.queryByText(t('settings.accounts.add.failed.store'))).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(t('settings.accounts.add.done', { name: 'work' }))).toBeNull();
    shown.unmount();
  }
});

test('a 409 add-pending resumes the add the daemon already holds instead of showing an error (#965)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = daemon();
  renderCard();
  await read();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.claude') }));
  fireEvent.change(nameField(), { target: { value: 'work' } });
  d.post = json({ error: 'add-pending' }, 409);
  d.claudeAdd = { state: 'pending', name: 'home' };
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.add.submit') }));
  expect(within(await claudeRow()).getByText('home')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(t('settings.accounts.add.failed.exited'))).toBeNull();
});
