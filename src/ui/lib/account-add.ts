// The accounts card's add flows (#965): their routes, the guard of the status the routes answer, what a refused start means and the copy each
// answer maps to. Pure, so node:test checks them; use-account-add makes the calls.
import type { ClaudeAccountError, ClaudeAddStatus, GithubAddStatus } from '../../types.js';
import type { MessageKey } from '../i18n.js';
import type { AccountList } from './settings-accounts.js';

/** A second is short next to a browser sign-in, and both routes answer process state cheaply (the spec). */
export const ADD_POLL_MS = 1000;
export const IDLE = { state: 'idle' } as const;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

export type AddStatus = ClaudeAddStatus | GithubAddStatus;
export type FailedAdd = Extract<AddStatus, { state: 'failed' }>;
export type NameRefusal = Extract<ClaudeAccountError, `name-${string}`>;
export type StartFailure = { kind: 'refused'; refusal: NameRefusal } | { kind: 'pending' } | { kind: 'failed' };

const NAME_REFUSALS: readonly NameRefusal[] = ['name-empty', 'name-too-long', 'name-taken'];
const CLAUDE_REASONS: readonly Extract<ClaudeAddStatus, { state: 'failed' }>['reason'][] = ['exited', 'timeout', 'store'];
const GITHUB_REASONS: readonly Extract<GithubAddStatus, { state: 'failed' }>['reason'][] = ['exited', 'token', 'store', 'timeout'];

export const REFUSAL_KEY: Readonly<Record<NameRefusal, MessageKey>> = {
  'name-empty': 'settings.accounts.add.refused.name-empty',
  'name-too-long': 'settings.accounts.add.refused.name-too-long',
  'name-taken': 'settings.accounts.add.refused.name-taken', // the reserved name add answers this too (#955)
};
const CLAUDE_FAILED: Readonly<Record<(typeof CLAUDE_REASONS)[number], MessageKey>> = {
  exited: 'settings.accounts.add.failed.exited', timeout: 'settings.accounts.add.failed.timeout', store: 'settings.accounts.add.failed.store',
};
const GITHUB_FAILED: Readonly<Record<(typeof GITHUB_REASONS)[number], MessageKey>> = {
  exited: 'settings.accounts.add.failed.ghExited', token: 'settings.accounts.add.failed.token', store: 'settings.accounts.add.failed.store',
  timeout: 'settings.accounts.add.failed.timeout',
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
// A link lands in an href: only https, so no answer can put another scheme in the page
const httpsUrl = (value: unknown): string | undefined => (typeof value === 'string' && value.startsWith('https://') ? value : undefined);

/** #955 and #960 keep each add outside the accounts routes: `add` is a valid name there. */
export const addRoute = (list: AccountList): string => (list === 'claude' ? '/settings/accounts/claude/add' : '/settings/github/add');

/** Claude's add as the network answered it; undefined for anything else, which the hook reads as a failed read. */
export function claudeAddStatus(answer: unknown): ClaudeAddStatus | undefined {
  if (!isObject(answer)) return undefined;
  const { state, name, url, reason } = answer;
  if (state === 'idle') return IDLE;
  if (!isText(name)) return undefined;
  if (state === 'pending') {
    const link = httpsUrl(url);
    return link === undefined ? { state, name } : { state, name, url: link };
  }
  if (state === 'connected') return { state, name };
  if (state === 'cancelled') return { state, name };
  return state === 'failed' && isOneOf(CLAUDE_REASONS, reason) ? { state, name, reason } : undefined;
}

/** GitHub's add as the network answered it: the code and the link each once gh printed them. */
export function githubAddStatus(answer: unknown): GithubAddStatus | undefined {
  if (!isObject(answer)) return undefined;
  const { state, code, url, login, reason } = answer;
  if (state === 'idle') return IDLE;
  if (state === 'cancelled') return { state };
  if (state === 'pending') {
    const link = httpsUrl(url);
    return { state, ...(isText(code) ? { code } : {}), ...(link === undefined ? {} : { url: link }) };
  }
  if (state === 'connected') return isText(login) ? { state, login } : undefined;
  return state === 'failed' && isOneOf(GITHUB_REASONS, reason) ? { state, reason } : undefined;
}

export const addStatusFrom = (list: AccountList, answer: unknown): AddStatus | undefined => (list === 'claude' ? claudeAddStatus(answer) : githubAddStatus(answer));

/** What the group shows: connected and cancelled put it at rest, the new row being the news. */
export const shownStatus = (status: AddStatus): AddStatus => (status.state === 'connected' || status.state === 'cancelled' ? IDLE : status);

/** The name or login a connected add stored, for the screen reader's status. */
export function addedName(status: AddStatus): string | undefined {
  if (status.state !== 'connected') return undefined;
  return 'name' in status ? status.name : status.login;
}

/** What a refused start means. The routes answer their code as `{ error }`, which parseJson makes the error's message. */
export function startFailure(err: unknown): StartFailure {
  const status = err instanceof Error && 'status' in err && typeof err.status === 'number' ? err.status : 0;
  const code = err instanceof Error ? err.message : '';
  if (status === HTTP_CONFLICT && code === 'add-pending') return { kind: 'pending' }; // the daemon holds one add per provider: this same flow
  if (status === HTTP_BAD_REQUEST && isOneOf(NAME_REFUSALS, code)) return { kind: 'refused', refusal: code };
  return { kind: 'failed' };
}

/** A start that failed with no status to show: the failed state in our words, Claude's keeping the typed name. */
export const failedStatus = (list: AccountList, name: string): AddStatus => (list === 'claude' ? { state: 'failed', name, reason: 'exited' } : { state: 'failed', reason: 'exited' });

export const failedKey = (status: FailedAdd): MessageKey => ('name' in status ? CLAUDE_FAILED[status.reason] : GITHUB_FAILED[status.reason]);
