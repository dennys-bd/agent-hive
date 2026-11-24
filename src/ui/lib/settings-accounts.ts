// Settings › execution › accounts (#964): the draft's account per provider and what the form sends. Out of settings-form.ts, which is near
// 400 lines; the card's rows join it, pure so node:test checks them.
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsConfig } from '../../types.js';

/** One name per provider; '' = the machine's login, which the config writes as a member left out (#952): no sentinel name reaches hive.config.json. */
export type AccountsDraft = Record<AccountProvider, string>;

export const accountsDraft = (saved: AccountsConfig | undefined): AccountsDraft =>
  Object.fromEntries(ACCOUNT_PROVIDERS.map((provider) => [provider, saved?.[provider] ?? ''])) as AccountsDraft;

/** What the form sends: only the providers on a stored account. */
export const accountsFrom = (draft: AccountsDraft): AccountsConfig =>
  Object.fromEntries(ACCOUNT_PROVIDERS.flatMap((provider) => (draft[provider] === '' ? [] : [[provider, draft[provider]]]))) as AccountsConfig;

/** The list route a group reads: Copilot runs on a GitHub login (#962), so its rows are GitHub's. */
export type AccountList = 'claude' | 'github';
/** What the card has read: a list is undefined while it loads or after it failed; machine is gh's login, from GitHub's list. */
export interface AccountLists { claude?: readonly string[]; github?: readonly string[]; machine?: string }
/** A row of a group: value '' is the machine's login (login: gh's, when known); isGone marks a saved name the read list no longer has. */
export interface AccountRow { value: string; login?: string; isGone?: boolean }

export const listOf = (provider: AccountProvider): AccountList => (provider === 'claude' ? 'claude' : 'github');

/** gh's login for GitHub's and Copilot's machine row; none for Claude's, whose machine login no route answers. */
export const machineLogin = (provider: AccountProvider, lists: AccountLists): string | undefined => (provider === 'claude' ? undefined : lists.machine);

/** The value a group shows selected: gh's own login, also stored, is the machine's row (the handoff: one row, the machine's). */
export const shownValue = (provider: AccountProvider, lists: AccountLists, value: string): string =>
  (value !== '' && value === machineLogin(provider, lists) ? '' : value);

/** A group's rows: the machine's first, then each stored account but gh's own, then the saved name when the list lacks it, marked gone once
 * the list answered and kept plain while it loads or failed, so nothing switches in silence. */
export function accountRows(provider: AccountProvider, lists: AccountLists, saved: string | undefined): AccountRow[] {
  const list = lists[listOf(provider)];
  const machine = machineLogin(provider, lists);
  const machineRow: AccountRow = { value: '', ...(machine === undefined ? {} : { login: machine }) };
  const stored = (list ?? []).filter((name) => name !== machine).map((name): AccountRow => ({ value: name }));
  if (saved === undefined || saved === '' || saved === machine || (list ?? []).includes(saved)) return [machineRow, ...stored];
  return [machineRow, ...stored, { value: saved, isGone: list !== undefined }];
}

// The providers whose choice a stored name can be: a GitHub login is also Copilot's (#962)
const SELECTING: Readonly<Record<AccountList, readonly AccountProvider[]>> = { claude: ['claude'], github: ['github', 'copilot'] };

/** Whether a row carries a remove (#965): a stored account of Claude's or GitHub's group, never the machine's row, a name the store lost
 * or Copilot's rows, which are GitHub's logins seen from another group. */
export const hasRemove = (provider: AccountProvider, row: AccountRow): boolean => provider !== 'copilot' && row.value !== '' && row.isGone !== true;

/** Whether a stored name may be removed now: not while the saved selection names it, which the route refuses (409), nor while the draft does,
 * so the draft never points at a removed account. */
export const isRemovable = (list: AccountList, value: string, saved: AccountsConfig, draft: AccountsDraft): boolean =>
  !SELECTING[list].some((provider) => saved[provider] === value || draft[provider] === value);
