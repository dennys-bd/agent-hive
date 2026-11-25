// A GitLab account (#1048): what a token is (its user, its scopes, its expiry) before it is stored, and the client a later leaf takes for a
// host. Both go through gitlabApi, the only code that sends a GitLab token (#1047).
import { gitlabCredential } from '../credentials.js';
import { SourceNotConnectedError } from '../source-errors.js';
import type { GitlabAccountError } from '../types.js';
import { type GitlabApi, GitlabHttpError, gitlabApi } from './api.js';

// The later leaves merge, comment and review, and a worker's glab (#1049) runs on the same token: a read-only one would fail there, later
const REQUIRED_SCOPE = 'api';
const HTTP_NOT_FOUND = 404;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface VerifiedGitlabToken { username: string; expiresAt?: string }
type VerifyError = Extract<GitlabAccountError, 'refused' | 'scope' | 'unverifiable' | 'unreachable'>;
export type GitlabVerdict = VerifiedGitlabToken | { error: VerifyError };

type Read = { ok: true; body: unknown } | { ok: false; error: unknown };
const read = (api: GitlabApi, path: string): Promise<Read> =>
  api.get(path).then((answer): Read => ({ ok: true, body: answer.body }), (error: unknown): Read => ({ ok: false, error }));
const field = (body: unknown, name: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined);

// A 404 on /self is a GitLab before 15.5 or a token that is no access token: its scopes cannot be read, so the api rule cannot hold
function errorOf(err: unknown, isSelf: boolean): VerifyError {
  if (err instanceof SourceNotConnectedError) return 'refused';
  return isSelf && err instanceof GitlabHttpError && err.status === HTTP_NOT_FOUND ? 'unverifiable' : 'unreachable';
}

// An answer of the wrong shape is no answer GitLab gives: unreachable, never a guess at the user
function verdictOf(user: unknown, self: unknown): GitlabVerdict {
  const username = field(user, 'username');
  const scopes = field(self, 'scopes');
  if (typeof username !== 'string' || username === '' || !Array.isArray(scopes)) return { error: 'unreachable' };
  if (!scopes.includes(REQUIRED_SCOPE)) return { error: 'scope' };
  const expiresAt = field(self, 'expires_at');
  return { username, ...(typeof expiresAt === 'string' && ISO_DATE.test(expiresAt) ? { expiresAt } : {}) };
}

/** #1048: the submitted token's user and expiry, or why it is refused. Nothing is stored here; the route stores what this answers. */
export async function verifyGitlabToken(host: string, token: string, fetch?: typeof globalThis.fetch): Promise<GitlabVerdict> {
  let api: GitlabApi;
  try {
    api = gitlabApi({ host, token: async () => token, ...(fetch === undefined ? {} : { fetch }) });
  } catch {
    return { error: 'unreachable' }; // a host the client refuses; the route has already checked it is a GitLab host
  }
  const user = await read(api, 'user');
  if (!user.ok) return { error: errorOf(user.error, false) };
  const self = await read(api, 'personal_access_tokens/self');
  if (!self.ok) return { error: errorOf(self.error, true) };
  return verdictOf(user.body, self.body);
}

/** #1048: the client of a host's stored account, undefined when it has none. Its token is read from the store at every call, so a reconnect
 * takes effect with no restart and a remove makes the next call throw SourceNotConnectedError. tests inject fetch. */
export async function gitlabAccess(host: string, env?: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch): Promise<GitlabApi | undefined> {
  if ((await gitlabCredential(host, env)) === undefined) return undefined;
  const token = async (): Promise<string> => {
    const cred = await gitlabCredential(host, env);
    if (cred === undefined) throw new SourceNotConnectedError(`gitlab ${host}`);
    return cred.token;
  };
  return gitlabApi({ host, token, ...(fetch === undefined ? {} : { fetch }) });
}
