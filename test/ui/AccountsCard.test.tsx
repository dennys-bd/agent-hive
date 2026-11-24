import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AccountsCard, accountsEntries } from '@/components/settings/AccountsCard';
import { setLanguage, t } from '@/i18n';
import { draftFrom, type SettingsDraft } from '@/lib/settings-form';
import { removeRoute } from '@/hooks/use-accounts';
import { settingAnchor } from '@/lib/settings-search';
import type { AccountsConfig } from '../../src/types';

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const CLAUDE = { names: ['personal', 'work'] };
const GITHUB = { logins: ['alice', 'gh-user'], machine: 'gh-user' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Reply = () => Response;
// The two list routes, both adds at rest (#965), and any call a test answers itself by `METHOD url`; a number answers that status with a raw
// error the screen must never show
function answer(claude: unknown = CLAUDE, github: unknown = GITHUB, replies: Record<string, Reply> = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = replies[`${init?.method ?? 'GET'} ${url}`];
    if (reply !== undefined) return reply();
    if (url.endsWith('/add')) return json({ state: 'idle' });
    const body = url === '/settings/accounts/claude' ? claude : url === '/settings/github/accounts' ? github : 404;
    return typeof body === 'number' ? json({ error: 'raw route error' }, body) : json(body);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const renderCard = (accounts: Partial<SettingsDraft['accounts']> = {}, saved: AccountsConfig = {}, onChange = vi.fn(), onOpenFlow = vi.fn()) => {
  const draft = draftFrom(undefined);
  return render(<AccountsCard draft={{ ...draft, accounts: { ...draft.accounts, ...accounts } }} saved={saved} onChange={onChange} onOpenFlow={onOpenFlow} />);
};
const group = (name: string): HTMLElement => screen.getByRole('radiogroup', { name });
const names = (name: string): string[] =>
  within(group(name)).getAllByRole('radio').map((radio) => document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent ?? '');
const read = () => screen.findByRole('radio', { name: 'personal' });
const removeOf = (name: string): HTMLElement => screen.getByRole('button', { name: t('settings.accounts.remove.label', { name }) });
const confirmButton = (): HTMLElement | null => screen.queryByRole('button', { name: t('settings.accounts.remove.confirm') });
const deletes = (fetch: ReturnType<typeof answer>, url: string): number => fetch.mock.calls.filter(([called, init]) => called === url && init?.method === 'DELETE').length;

test('three groups in order, claude, copilot and github, and no codex; each lists the machine\'s row first, then its stored accounts; Copilot lists GitHub\'s logins, gh\'s own once, on the machine\'s row (#964)', async () => {
  answer();
  renderCard();
  await read();
  expect(screen.getAllByRole('radiogroup')).toEqual(['claude', 'copilot', 'github'].map(group));
  expect(screen.queryByRole('radiogroup', { name: 'codex' })).toBeNull();
  expect(names('claude')).toEqual([t('settings.accounts.machine'), 'personal', 'work']);
  expect(names('copilot')).toEqual(['gh-user', 'alice']);
  expect(names('github')).toEqual(['gh-user', 'alice']);
  expect(within(group('github')).getByText(t('settings.accounts.machine'))).toBeInTheDocument();
  expect(document.getElementById(settingAnchor('settings.accounts', 'copilot'))?.querySelector('svg[data-icon="copilot"]')).not.toBeNull();
  // GitHub is no agent: no mark in its header (its rows' removes draw an ×, #965)
  expect(document.getElementById(settingAnchor('settings.accounts', 'github'))?.firstElementChild?.querySelector('svg')).toBeNull();
});

test('each group shows the draft\'s choice selected, gh\'s own login on the machine\'s row; picking a row sends accounts with that provider\'s name, the machine\'s as \'\' (#964)', async () => {
  answer();
  const onChange = vi.fn();
  renderCard({ claude: 'work', copilot: 'gh-user' }, { claude: 'work', copilot: 'gh-user' }, onChange);
  await read();
  expect(within(group('claude')).getByRole('radio', { name: 'work' })).toBeChecked();
  expect(within(group('copilot')).getByRole('radio', { name: 'gh-user' })).toBeChecked();
  expect(within(group('github')).getByRole('radio', { name: 'gh-user' })).toBeChecked();
  fireEvent.click(within(group('github')).getByRole('radio', { name: 'alice' }));
  expect(onChange).toHaveBeenLastCalledWith({ accounts: { claude: 'work', copilot: 'gh-user', github: 'alice' } });
  fireEvent.click(within(group('claude')).getByRole('radio', { name: t('settings.accounts.machine') }));
  expect(onChange).toHaveBeenLastCalledWith({ accounts: { claude: '', copilot: 'gh-user', github: '' } });
});

test('a group is one tab stop: tab lands on its add, then its selected row, an arrow moves to the next row and picks it; the rows\' removes follow, then the next group (#964, #965)', async () => {
  answer();
  const user = userEvent.setup();
  const onChange = vi.fn();
  renderCard({}, {}, onChange);
  await read();
  await user.tab();
  expect(screen.getByRole('button', { name: t('settings.accounts.add.claude') })).toHaveFocus();
  await user.tab();
  expect(within(group('claude')).getByRole('radio', { name: t('settings.accounts.machine') })).toHaveFocus();
  // Held, then released: Radix focuses the next row in a timeout and checks it only while an arrow is down, which a real press outlasts
  await user.keyboard('{ArrowDown>}');
  await waitFor(() => expect(within(group('claude')).getByRole('radio', { name: 'personal' })).toHaveFocus());
  await user.keyboard('{/ArrowDown}');
  expect(onChange).toHaveBeenLastCalledWith({ accounts: { claude: 'personal', copilot: '', github: '' } });
  await user.tab();
  expect(removeOf('personal')).toHaveFocus();
  await user.tab();
  expect(removeOf('work')).toHaveFocus();
  await user.tab();
  expect(within(group('copilot')).getByRole('radio', { name: 'gh-user' })).toHaveFocus();
});

test('github\'s group says the selection drives gh and git follows it only through gh\'s credential helper, in mono, and links to fluxo\'s GitHub connection (#964)', async () => {
  answer();
  const onOpenFlow = vi.fn();
  renderCard({}, {}, vi.fn(), onOpenFlow);
  await read();
  const command = screen.getByText('gh auth setup-git');
  expect(command).toHaveClass('font-mono');
  expect(command.parentElement?.textContent).toBe(`${t('settings.accounts.github.hint')} ${t('settings.accounts.github.connection')}`);
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.github.connection') }));
  expect(onOpenFlow).toHaveBeenCalledTimes(1);
});

test('a saved name the store no longer has keeps its row, selected and last, marked as no longer stored (#964)', async () => {
  answer();
  renderCard({ claude: 'old' }, { claude: 'old' });
  await read();
  expect(names('claude')).toEqual([t('settings.accounts.machine'), 'personal', 'work', 'old']);
  const old = within(group('claude')).getByRole('radio', { name: 'old' });
  expect(old).toBeChecked();
  expect(old).toHaveAccessibleDescription(t('settings.accounts.gone'));
  expect(screen.getByText(t('settings.accounts.gone'))).toHaveClass('text-destructive');
});

test('until the lists answer, each group shows its machine\'s row on the generic label and the saved selection, with the reading line (#964)', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  renderCard({ github: 'alice' }, { github: 'alice' });
  expect(names('claude')).toEqual([t('settings.accounts.machine')]);
  expect(names('github')).toEqual([t('settings.accounts.machine'), 'alice']);
  expect(within(group('github')).getByRole('radio', { name: 'alice' })).toBeChecked();
  expect(screen.getAllByText(t('settings.accounts.loading'))).toHaveLength(3);
  expect(screen.queryByText(t('settings.accounts.gone'))).toBeNull();
});

test('a failed GitHub list keeps copilot\'s and github\'s machine row and saved one, says so in both groups and never shows the raw error; try again reads the lists again (#964)', async () => {
  const fetch = answer(CLAUDE, 500);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  renderCard({ github: 'alice' }, { github: 'alice' });
  expect(await screen.findAllByText(t('settings.accounts.failed.github'))).toHaveLength(2);
  expect(names('github')).toEqual([t('settings.accounts.machine'), 'alice']);
  expect(names('copilot')).toEqual([t('settings.accounts.machine')]);
  expect(names('claude')).toEqual([t('settings.accounts.machine'), 'personal', 'work']);
  expect(screen.queryByText(/raw route error/)).toBeNull();
  expect(console.error).toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: t('settings.accounts.retry') })[0]);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/settings/github/accounts')).toHaveLength(2)); // the adds read on mount too (#965)
});

test('the search lists one entry per group under execução › contas, landing on its group; the agents\' by their name (#964)', () => {
  const entries = accountsEntries();
  expect(entries.map((e) => [e.label, e.anchor])).toEqual([
    [{ raw: 'claude' }, settingAnchor('settings.accounts', 'claude')],
    [{ raw: 'copilot' }, settingAnchor('settings.accounts', 'copilot')],
    ['settings.accounts.github', settingAnchor('settings.accounts', 'github')],
  ]);
  for (const entry of entries) expect([entry.path, entry.view]).toEqual([['settings.section.execution', 'settings.accounts'], { section: 'execution' }]);
});

test('remove takes two clicks: the first puts its confirm in the ×\'s place with focus on it; Escape closes it and puts focus back, a blur closes it; the second click removes the row (#965)', async () => {
  let names = ['personal', 'work'];
  const fetch = answer(CLAUDE, GITHUB, {
    'GET /settings/accounts/claude': () => json({ names }),
    'DELETE /settings/accounts/claude/personal': () => { names = ['work']; return new Response(null, { status: 204 }); },
  });
  renderCard();
  await read();
  fireEvent.click(removeOf('personal'));
  expect(confirmButton()).toHaveFocus();
  expect(screen.getByText(t('settings.accounts.remove.confirmHint'))).toBeInTheDocument();
  fireEvent.keyDown(confirmButton() as HTMLElement, { key: 'Escape' });
  expect(confirmButton()).toBeNull();
  expect(removeOf('personal')).toHaveFocus();
  fireEvent.click(removeOf('personal'));
  fireEvent.blur(confirmButton() as HTMLElement);
  expect(confirmButton()).toBeNull();
  expect(deletes(fetch, '/settings/accounts/claude/personal')).toBe(0);
  fireEvent.click(removeOf('personal'));
  fireEvent.click(confirmButton() as HTMLElement);
  await waitFor(() => expect(within(group('claude')).queryByRole('radio', { name: 'personal' })).toBeNull());
  expect(deletes(fetch, '/settings/accounts/claude/personal')).toBe(1);
  expect(within(group('claude')).getByRole('radio', { name: 'work' })).toBeInTheDocument();
});

test('a remove the route refuses as in use shows our copy, never its words; a 404 reads the list again with no line; another failure offers try again (#965)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let logins = ['alice', 'bob', 'carol', 'gh-user'];
  const fetch = answer(CLAUDE, GITHUB, {
    'GET /settings/github/accounts': () => json({ logins, machine: 'gh-user' }),
    'DELETE /settings/github/accounts/alice': () => json({ error: '"accounts.github" selects this login' }, 409),
    'DELETE /settings/github/accounts/bob': () => { logins = logins.filter((login) => login !== 'bob'); return json({ error: 'no stored GitHub login by that name' }, 404); },
    'DELETE /settings/github/accounts/carol': () => json({ error: 'github login not removed' }, 500),
  });
  renderCard();
  await within(group('github')).findByRole('radio', { name: 'alice' });
  const confirmRemove = (name: string): void => {
    fireEvent.click(removeOf(name));
    fireEvent.click(confirmButton() as HTMLElement);
  };
  confirmRemove('alice');
  const inUse = await screen.findByText(t('settings.accounts.remove.inUse', { name: 'alice' }));
  expect(inUse.closest('p')).toHaveClass('text-waiting');
  expect(screen.queryByText(/selects this login/)).toBeNull();
  confirmRemove('bob');
  await waitFor(() => expect(within(group('github')).queryByRole('radio', { name: 'bob' })).toBeNull());
  expect(screen.queryByText(t('settings.accounts.remove.inUse', { name: 'alice' }))).toBeNull();
  expect(screen.queryByText(t('settings.accounts.remove.failed', { name: 'bob' }))).toBeNull();
  confirmRemove('carol');
  expect(await screen.findByText(t('settings.accounts.remove.failed', { name: 'carol' }))).toBeInTheDocument();
  expect(screen.queryByText(/not removed/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.retry') }));
  await waitFor(() => expect(deletes(fetch, '/settings/github/accounts/carol')).toBe(2));
});

test('remove is locked, with its hint, on the saved choice and the drafted one, a login copilot uses included; never on the machine\'s row nor in copilot\'s group (#965)', async () => {
  answer(CLAUDE, { logins: ['alice', 'bob', 'carol', 'dave'], machine: 'gh-user' });
  renderCard({ claude: 'work', github: 'bob', copilot: 'carol' }, { claude: 'personal', copilot: 'alice' });
  await read();
  await within(group('github')).findByRole('radio', { name: 'dave' });
  for (const name of ['personal', 'work', 'alice', 'bob', 'carol']) {
    const locked = removeOf(name);
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveAccessibleDescription(t('settings.accounts.remove.locked'));
    fireEvent.click(locked);
    expect(confirmButton()).toBeNull();
  }
  expect(removeOf('dave')).not.toHaveAttribute('aria-disabled');
  expect(within(group('copilot')).queryAllByRole('button')).toEqual([]);
  expect(screen.queryByRole('button', { name: t('settings.accounts.remove.label', { name: 'gh-user' }) })).toBeNull();
  expect(screen.queryByRole('button', { name: t('settings.accounts.remove.label', { name: t('settings.accounts.machine') }) })).toBeNull();
});

test('a remove route encodes every dot, so a name of . or .. reaches its own route (#965)', () => {
  expect(removeRoute('claude', '..')).toBe('/settings/accounts/claude/%2E%2E');
  expect(removeRoute('github', 'a.b/c')).toBe('/settings/github/accounts/a%2Eb%2Fc');
});
