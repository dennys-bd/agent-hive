import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AccountsCard, accountsEntries } from '@/components/settings/AccountsCard';
import { setLanguage, t } from '@/i18n';
import { draftFrom, type SettingsDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import type { AccountsConfig } from '../../src/types';

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const CLAUDE = { names: ['personal', 'work'] };
const GITHUB = { logins: ['alice', 'gh-user'], machine: 'gh-user' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The two list routes; a number answers that status with a raw error the screen must never show
function answer(claude: unknown = CLAUDE, github: unknown = GITHUB) {
  const fetch = vi.fn(async (url: string) => {
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
  expect(document.getElementById(settingAnchor('settings.accounts', 'github'))?.querySelector('svg')).toBeNull(); // GitHub is no agent: no mark
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

test('a group is one tab stop: tab lands on its selected row, an arrow moves to the next row and picks it, and tab leaves for the next group (#964)', async () => {
  answer();
  const user = userEvent.setup();
  const onChange = vi.fn();
  renderCard({}, {}, onChange);
  await read();
  await user.tab();
  expect(within(group('claude')).getByRole('radio', { name: t('settings.accounts.machine') })).toHaveFocus();
  // Held, then released: Radix focuses the next row in a timeout and checks it only while an arrow is down, which a real press outlasts
  await user.keyboard('{ArrowDown>}');
  await waitFor(() => expect(within(group('claude')).getByRole('radio', { name: 'personal' })).toHaveFocus());
  await user.keyboard('{/ArrowDown}');
  expect(onChange).toHaveBeenLastCalledWith({ accounts: { claude: 'personal', copilot: '', github: '' } });
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
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
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
