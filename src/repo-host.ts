// The host of a remote and of a PR link (#1044): GitHub or GitLab, and the repository and number they name. Pure and Node-free, so the UI may
// bundle it, and the only code that matches a repository host name. The GitLab hosts are always the caller's, read from the live config.
import { isTrustedHost } from './trusted-hosts.js';

export type HostKind = 'github' | 'gitlab';
/** A remote's host and repository: owner/name on GitHub, the project's full path on GitLab. */
export interface RemoteRepository { kind: HostKind; host: string; repository: string }
/** A PR link's parts: a GitHub pull request, or a GitLab merge request, whose number is its iid. */
export interface PrLink { host: string; repository: string; number: number }

export const GITHUB_HOST = 'github.com';
export const GITLAB_HOST = 'gitlab.com';

/** GitHub, GitLab or none for a host name (decision 2). Exact names only: a host kind picks where a token goes, so it is never widened by suffix. */
export function hostKind(host: string, gitlabHosts: readonly string[]): HostKind | undefined {
  const name = host.toLowerCase();
  if (name === GITHUB_HOST) return 'github';
  return name === GITLAB_HOST || gitlabHosts.includes(name) ? 'gitlab' : undefined;
}

const HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?';
// https (a token in it included; userinfo never takes ? # \\ or a space, where git would end the authority and reach another host), git@ or ssh://git@, then the path: a port, a query or a fragment never gets past the host and path classes
const REMOTE = new RegExp(`^(?:https://(?:[^@/?#\\\\\\s]+@)?(${HOST})/|git@(${HOST}):|ssh://git@(${HOST})/)([\\w./-]+)$`);
// GitHub's owner/name under the rules from before #1044: neither part made only of dots, .git and a trailing / dropped
const GITHUB_PATH = /^((?!\.+\/)[\w.-]+\/(?!\.+(?:\.git)?\/?$)[\w.-]+?)(?:\.git)?\/?$/;
// GitLab's full path: two or more segments (nested groups), .git and a trailing / dropped from the last
const GITLAB_PATH = /^((?:[\w.-]+\/)+[\w.-]+?)(?:\.git)?\/?$/;
// A segment of only dots, or GitLab's own - separator, which no project path holds
const NOT_A_SEGMENT = /^(?:\.+|-)$/;
// The GitHub link as isPrUrl took it before #1044; a leading zero is refused so buildPrLink gives every accepted link back
const GITHUB_PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/;
const GITLAB_MR = /^https:\/\/([^/]+)\/([\w./-]+?)\/-\/merge_requests\/([1-9]\d*)$/;

// A GitLab path none of whose segments is only dots or the - separator
function gitlabPath(path: string): string | undefined {
  const repository = GITLAB_PATH.exec(path)?.[1];
  return repository === undefined || repository.split('/').some((segment) => NOT_A_SEGMENT.test(segment)) ? undefined : repository;
}

const repositoryOn = (kind: HostKind, path: string): string | undefined => (kind === 'github' ? GITHUB_PATH.exec(path)?.[1] : gitlabPath(path));

/** The host and repository of a remote URL (decision 3), or none: a host of no kind, or a path its host cannot hold. */
export function remoteRepository(remote: string, gitlabHosts: readonly string[]): RemoteRepository | undefined {
  const match = REMOTE.exec(remote);
  if (match === null) return undefined;
  const host = (match[1] ?? match[2] ?? match[3]).toLowerCase();
  const kind = hostKind(host, gitlabHosts);
  if (kind === undefined) return undefined;
  const repository = repositoryOn(kind, match[4]);
  return repository === undefined ? undefined : { kind, host, repository };
}

// A number past what a JS number holds exactly would not build back to its link
function linkOf(host: string, repository: string, digits: string): PrLink | undefined {
  const number = Number(digits);
  return Number.isSafeInteger(number) ? { host, repository, number } : undefined;
}

/** A PR link's host, repository and number (decision 5), by its shape alone and anchored: GitHub's /pull/ on github.com, GitLab's
 * /-/merge_requests/ on any other bare host name. Whether that host is a GitLab one is the caller's check, against the list. */
export function parsePrLink(url: string): PrLink | undefined {
  const github = GITHUB_PR.exec(url);
  if (github !== null) return linkOf(GITHUB_HOST, github[1], github[2]);
  const gitlab = GITLAB_MR.exec(url);
  if (gitlab === null || gitlab[1] === GITHUB_HOST || !isTrustedHost(gitlab[1])) return undefined;
  // the path exactly as written: a .git or a dots-only segment gives none, so the build never differs from the link
  return gitlabPath(gitlab[2]) === gitlab[2] ? linkOf(gitlab[1], gitlab[2], gitlab[3]) : undefined;
}

/** parsePrLink's inverse (decision 5): the /pull/ form on github.com, the /-/merge_requests/ form on any other host. */
export const buildPrLink = ({ host, repository, number }: PrLink): string =>
  (host === GITHUB_HOST ? `https://${GITHUB_HOST}/${repository}/pull/${number}` : `https://${host}/${repository}/-/merge_requests/${number}`);

/** hive_pr's url and a stored PR's (decision 6): a link parsePrLink reads, a GitHub PR or an MR on any host name. */
export const isPrUrl = (url: string): boolean => parsePrLink(url) !== undefined;

/** What hive_pr and a task made from a PR take until the host check against gitlabHosts reaches them (#1051 to #1053): a GitHub PR link
 * only, since every reader of a stored link still calls GitHub with its path. */
export const isGithubPrUrl = (url: string): boolean => parsePrLink(url)?.host === GITHUB_HOST;
