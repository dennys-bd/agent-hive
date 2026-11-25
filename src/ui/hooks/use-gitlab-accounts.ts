import { useEffect, useState } from 'react';
import { statusOf } from '@/hooks/use-plugins';
import { getJson, postJson, sendJson } from '@/lib/api';
import { GITLAB_ACCOUNT_ERRORS, type GitlabAccountError, type GitlabAccountRow } from '../../types';

export const GITLAB_ACCOUNTS_ROUTE = '/settings/accounts/gitlab'; // #1048: { accounts }
const HTTP_NOT_FOUND = 404;

/** A connect the route refused, by its code; failed when it named none (a write failure, the network). */
export type GitlabRefusal = GitlabAccountError | 'failed';
export type GitlabConnectOutcome = { row: GitlabAccountRow } | { error: GitlabRefusal };
/** The GitLab group's list (#1048), undefined until read and after a failed read, with its connect and remove. */
export interface GitlabAccounts {
  accounts?: GitlabAccountRow[];
  isFailed: boolean;
  refetch(): void;
  connect(host: string, token: string): Promise<GitlabConnectOutcome>;
  remove(host: string): Promise<boolean>; // false: not removed, logged; a 404 is done already
}

const isRow = (value: unknown): value is GitlabAccountRow => {
  if (typeof value !== 'object' || value === null) return false;
  const { host, username, expiresAt } = value as Record<string, unknown>;
  return typeof host === 'string' && typeof username === 'string' && (expiresAt === undefined || typeof expiresAt === 'string');
};
// The answer crosses the network: anything but a list of rows is a failed read, never an empty group
function rowsOf(answer: unknown): GitlabAccountRow[] {
  const list = typeof answer === 'object' && answer !== null ? (answer as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(list) || !list.every(isRow)) throw new Error('the answer holds no accounts list');
  return list;
}
const isAccountError = (value: unknown): value is GitlabAccountError => (GITLAB_ACCOUNT_ERRORS as readonly unknown[]).includes(value);

// A refusal's code is the body's error (parseJson keeps the body on the error); anything else is logged and worded generically
function refusalOf(err: unknown, host: string): GitlabRefusal {
  const code = (err as { body?: { error?: unknown } } | null)?.body?.error;
  if (isAccountError(code)) return code;
  console.error(`accounts: the gitlab account of ${host} was not connected`, err);
  return 'failed';
}

/** GET /settings/accounts/gitlab once per mount and on refetch (#1048); a late answer after unmount is dropped. A failure is logged here and
 * worded by the group: the route's words never reach the screen. The token goes out in the connect's body and is kept nowhere. */
export function useGitlabAccounts(): GitlabAccounts {
  const [accounts, setAccounts] = useState<GitlabAccountRow[]>();
  const [isFailed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0); // refetch's only job: a new value re-runs the read
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the trigger of a new read, not a value it uses
  useEffect(() => {
    let live = true;
    setFailed(false);
    getJson<unknown>(GITLAB_ACCOUNTS_ROUTE).then((answer) => {
      const rows = rowsOf(answer);
      if (live) setAccounts(rows);
    }).catch((err: unknown) => {
      console.error('accounts: the gitlab accounts were not read', err);
      if (!live) return;
      setAccounts(undefined);
      setFailed(true);
    });
    return () => { live = false; };
  }, [attempt]);
  const refetch = (): void => setAttempt((n) => n + 1);
  const connect = async (host: string, token: string): Promise<GitlabConnectOutcome> => {
    let answer: unknown;
    try {
      answer = await postJson<unknown>(GITLAB_ACCOUNTS_ROUTE, { host, token });
    } catch (err) {
      return { error: refusalOf(err, host) };
    }
    refetch();
    return isRow(answer) ? { row: answer } : { error: 'failed' };
  };
  // A 404 is what the click asked for, done elsewhere: re-read, no line
  const remove = async (host: string): Promise<boolean> => {
    try {
      await sendJson<unknown>('DELETE', `${GITLAB_ACCOUNTS_ROUTE}/${encodeURIComponent(host)}`);
    } catch (err) {
      if (statusOf(err) !== HTTP_NOT_FOUND) {
        console.error(`accounts: the gitlab account of ${host} was not removed`, err);
        return false;
      }
    }
    refetch();
    return true;
  };
  return { ...(accounts === undefined ? {} : { accounts }), isFailed, refetch, connect, remove };
}
