import { useEffect, useState } from 'react';
import { statusOf } from '@/hooks/use-plugins';
import { getJson, sendJson } from '@/lib/api';
import type { AccountList, AccountLists } from '@/lib/settings-accounts';

export const CLAUDE_ACCOUNTS_ROUTE = '/settings/accounts/claude'; // #955: { names }
export const GITHUB_ACCOUNTS_ROUTE = '/settings/github/accounts'; // #959: GithubLogins
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** What a remove answers its row (#965): gone, refused because a saved selection names it, or failed for another reason. */
export type RemoveOutcome = 'removed' | 'in-use' | 'failed';
/** The lists the accounts card reads, which list failed, a re-read (#965 calls it after an add) and a remove. */
export interface Accounts extends AccountLists {
  errors: Readonly<Record<AccountList, boolean>>;
  refetch(): void;
  remove(list: AccountList, name: string): Promise<RemoveOutcome>;
}
type AccountsRead = Omit<Accounts, 'refetch' | 'remove'>;

const NO_ERRORS: AccountsRead['errors'] = { claude: false, github: false };
const NOTHING_READ: AccountsRead = { errors: NO_ERRORS };

/** One stored name's remove route, the name encoded: Express decodes :name and :login. */
export const removeRoute = (list: AccountList, name: string): string =>
  `${list === 'claude' ? CLAUDE_ACCOUNTS_ROUTE : GITHUB_ACCOUNTS_ROUTE}/${encodeURIComponent(name)}`;

// The answer crosses the network: anything but a list of names is a failed read, never an empty group
function namesOf(answer: unknown, key: 'names' | 'logins'): string[] {
  const list = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(list) || !list.every((name) => typeof name === 'string')) throw new Error(`the answer holds no ${key} list`);
  return list;
}
const machineOf = (answer: unknown): string | undefined => {
  const machine = (answer as { machine?: unknown }).machine;
  return typeof machine === 'string' && machine !== '' ? machine : undefined;
};
// A failed list shows none of its rows: the group falls back to the machine's row (generic, since gh's login came with it) and the saved one
const withFailure = (read: AccountsRead, list: AccountList): AccountsRead => (list === 'claude'
  ? { ...read, claude: undefined, errors: { ...read.errors, claude: true } }
  : { ...read, github: undefined, machine: undefined, errors: { ...read.errors, github: true } });

/** Both list routes, once per mount and on refetch (#964). A re-read keeps the shown lists until its answers replace them; a late answer
 * after unmount is dropped. A failure is logged here and worded by the card: the route's words never reach the screen. */
export function useAccounts(): Accounts {
  const [read, setRead] = useState<AccountsRead>(NOTHING_READ);
  const [attempt, setAttempt] = useState(0); // refetch's only job: a new value re-runs both reads
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the trigger of a new read, not a value it uses
  useEffect(() => {
    let live = true;
    setRead((shown) => ({ ...shown, errors: NO_ERRORS }));
    const failed = (list: AccountList) => (err: unknown): void => {
      console.error(`accounts: the ${list} accounts were not read`, err);
      if (live) setRead((shown) => withFailure(shown, list));
    };
    getJson<unknown>(CLAUDE_ACCOUNTS_ROUTE).then((answer) => {
      const claude = namesOf(answer, 'names');
      if (live) setRead((shown) => ({ ...shown, claude }));
    }).catch(failed('claude'));
    getJson<unknown>(GITHUB_ACCOUNTS_ROUTE).then((answer) => {
      const github = namesOf(answer, 'logins');
      const machine = machineOf(answer);
      if (live) setRead((shown) => ({ ...shown, github, machine }));
    }).catch(failed('github'));
    return () => { live = false; };
  }, [attempt]);
  const refetch = (): void => setAttempt((n) => n + 1);
  // #965: a 404 is what the click asked for, already done elsewhere: re-read, no line. Any other failure is logged with the route's words and
  // worded by the card; a 409's body is a config path, never copy
  const remove = async (list: AccountList, name: string): Promise<RemoveOutcome> => {
    try {
      await sendJson<unknown>('DELETE', removeRoute(list, name));
    } catch (err) {
      const status = statusOf(err);
      if (status !== HTTP_NOT_FOUND) {
        console.error(`accounts: the ${list} account ${name} was not removed`, err);
        return status === HTTP_CONFLICT ? 'in-use' : 'failed';
      }
    }
    refetch();
    return 'removed';
  };
  return { ...read, refetch, remove };
}
