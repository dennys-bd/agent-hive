// The GitLab provider of the run env seam (#1049): the account of the GitLab host a run's workspace's origin is on, as GITLAB_TOKEN and
// GITLAB_HOST. glab sends an env token only to GITLAB_HOST's host, and a GITLAB_HOST always wins over the remotes, so the pair always names
// the origin's own host. Imports account-error and types only: a runner's module loaded first closes no cycle through the registry.
import { AccountError } from '../account-error.js';
import type { Credentials, Workspace } from '../types.js';

/** Every name glab reads a token or a host from: no child inherits them (withoutHiveEnv), so a run talks to GitLab only as the account the
 * Hive picked, and a GitHub workspace has neither even when the daemon inherited them. */
export const GITLAB_ENV_NAMES = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST'] as const;

/** What the provider reads (AccountEnvDeps' members): the store, and the GitLab host of a workspace's origin, undefined off GitLab. */
export interface GitlabEnvDeps { credentials(): Promise<Credentials>; gitlabOrigin(workspace: Workspace): Promise<string | undefined> }

/** The run's GitLab pair: {} with no workspace, an origin off GitLab or no account for its host. An expired account's token is passed as is:
 * glab gets the 401 and Settings shows the row as expired (#1048). */
export async function gitlabEnv(workspace: Workspace | undefined, deps: GitlabEnvDeps): Promise<Record<string, string>> {
  if (workspace === undefined) return {};
  const host = await deps.gitlabOrigin(workspace);
  if (host === undefined) return {};
  let stored: Credentials;
  try {
    stored = await deps.credentials();
  } catch {
    throw new AccountError('gitlab', 'unreachable'); // never the cause's message: a store's error may quote what it read
  }
  const hosts = stored.gitlab ?? {};
  const account = Object.hasOwn(hosts, host) ? hosts[host] : undefined;
  return account === undefined ? {} : { GITLAB_TOKEN: account.token, GITLAB_HOST: host };
}
