import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hiveHome } from './home.js';
import { replaceFile } from './replace-file.js';
import type { Credentials } from './types.js';

const FILE_NAME = 'credentials.json';
const DIR_MODE = 0o700; // same protection `gh` uses by default: per user, outside the workspace tree and outside git
const FILE_MODE = 0o600;

/** `<hiveHome>/credentials.json`. Per user, so one login serves every workspace; hiveHome owns the XDG rule. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hiveHome(env), FILE_NAME);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// #333: an external server's header value by server name; an entry whose value is not a string is dropped, as a malformed github is: it
// would reach a header as [object Object]. A map that is no object is dropped whole.
function mcpValues(raw: unknown): Record<string, { value: string }> | undefined {
  if (!isRecord(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).flatMap(([name, entry]) => (isRecord(entry) && typeof entry.value === 'string' ? [[name, { value: entry.value }]] : [])));
}

export type JiraCredential = NonNullable<Credentials['jira']>[string];

// #816: a site's login by host; an entry with a non-string field is dropped, as a malformed github is: it would reach the Basic header as
// [object Object]. A map that is no object is dropped whole. A displayName that is no string is dropped with the login kept (#820): it is
// only what @me reads.
function jiraEntries(raw: unknown): Record<string, JiraCredential> | undefined {
  if (!isRecord(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw).flatMap(([site, e]) =>
      isRecord(e) && typeof e.email === 'string' && typeof e.token === 'string' && typeof e.accountId === 'string'
        ? [[site, { email: e.email, token: e.token, accountId: e.accountId, ...(typeof e.displayName === 'string' ? { displayName: e.displayName } : {}) }]]
        : [],
    ),
  );
}

export type ClaudeCredential = NonNullable<Credentials['claude']>[string];

// #952, #959: a token by account name (claude) or by login (github); an entry whose token is not a string is dropped: it would reach an env var
// or a header as [object Object]. A map that is no object is dropped whole, and the single github entry of before #959 reads as {}.
function tokenEntries(raw: unknown): Record<string, ClaudeCredential> | undefined {
  if (!isRecord(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).flatMap(([name, e]) => (isRecord(e) && typeof e.token === 'string' ? [[name, { token: e.token }]] : [])));
}

export type GitlabCredential = NonNullable<Credentials['gitlab']>[string];

// #1048: an account by bare host; an entry whose token or username is no string is dropped, as a malformed github is: it would reach the
// Authorization header or the card as [object Object]. An expiresAt that is no string is dropped with the account kept: only the row reads it.
function gitlabEntries(raw: unknown): Record<string, GitlabCredential> | undefined {
  if (!isRecord(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw).flatMap(([host, e]) =>
      isRecord(e) && typeof e.token === 'string' && typeof e.username === 'string'
        ? [[host, { token: e.token, username: e.username, ...(typeof e.expiresAt === 'string' ? { expiresAt: e.expiresAt } : {}) }]]
        : [],
    ),
  );
}

/**
 * What is stored, `{}` when nothing is. A missing, unreadable or corrupt file reads as "not logged in", never as a
 * boot failure. A `github` or `claude` map keeps each well-formed entry (as `mcp` and `jira` do), and: every other
 * top-level key (a sibling provider's, once one exists) is kept, since `writeCredentials({ ...await readCredentials(),
 * github }, …)` is the write pattern every login uses — losing a sibling here would silently erase it on the next one.
 */
export async function readCredentials(env?: NodeJS.ProcessEnv): Promise<Credentials> {
  const text = await readFile(credentialsPath(env), 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const { github, mcp, jira, claude, gitlab, ...rest } = parsed as { github?: unknown; mcp?: unknown; jira?: unknown; claude?: unknown; gitlab?: unknown } & Record<string, unknown>;
    const values = mcpValues(mcp);
    const sites = jiraEntries(jira);
    const logins = tokenEntries(github);
    const accounts = tokenEntries(claude);
    const hosts = gitlabEntries(gitlab);
    return {
      ...rest, ...(logins ? { github: logins } : {}), ...(values ? { mcp: values } : {}), ...(sites ? { jira: sites } : {}), ...(accounts ? { claude: accounts } : {}),
      ...(hosts ? { gitlab: hosts } : {}),
    } as Credentials;
  } catch {
    return {};
  }
}

/**
 * Replaces the whole file: the same atomic write (temp + rename) hive.config.json uses, with owner-only modes.
 * The temp name is unique and `wx` refuses to write through a file already sitting at that path (planted or a
 * symlink) instead of silently inheriting its mode or target on rename.
 */
export async function writeCredentials(next: Credentials, env?: NodeJS.ProcessEnv): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
    await replaceFile(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// One read-modify-write at a time in this process: a background name renewal (#820) racing a reconnect or a GitHub login would otherwise
// write its older snapshot over the newer token. ponytail: in-process only; a second Hive process on the same home is not serialized
let pending: Promise<unknown> = Promise.resolve();

/** Reads the file, applies `change`, writes what it answers; undefined writes nothing. Serialized with every other update. */
export function updateCredentials(change: (current: Credentials) => Credentials | undefined, env?: NodeJS.ProcessEnv): Promise<void> {
  const run = pending.then(async () => {
    const next = change(await readCredentials(env));
    if (next !== undefined) await writeCredentials(next, env);
  });
  pending = run.catch(() => undefined); // one failed write never blocks the next
  return run;
}

export async function jiraCredential(site: string, env?: NodeJS.ProcessEnv): Promise<JiraCredential | undefined> {
  const { jira } = await readCredentials(env);
  return jira !== undefined && Object.hasOwn(jira, site) ? jira[site] : undefined;
}

export async function saveJiraCredential(site: string, cred: JiraCredential, env?: NodeJS.ProcessEnv): Promise<void> {
  await updateCredentials((current) => ({ ...current, jira: { ...current.jira, [site]: cred } }), env);
}

export async function removeJiraCredential(site: string, env?: NodeJS.ProcessEnv): Promise<void> {
  // nothing to remove, nothing written: an unreadable file reads as {} and a rewrite would drop every other login
  await updateCredentials((current) => {
    if (current.jira === undefined || !Object.hasOwn(current.jira, site)) return undefined;
    const { [site]: _gone, ...left } = current.jira;
    return { ...current, jira: left };
  }, env);
}

/** #820: the account's name as /myself answers it. Written only when the site has a login and the name changed, so a resolve that finds
 * nothing new never rewrites the file. */
export async function renewJiraName(site: string, name: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await updateCredentials((current) => {
    const entry = current.jira !== undefined && Object.hasOwn(current.jira, site) ? current.jira[site] : undefined;
    if (entry === undefined || entry.displayName === name) return undefined;
    return { ...current, jira: { ...current.jira, [site]: { ...entry, displayName: name } } };
  }, env);
}

export async function claudeCredential(name: string, env?: NodeJS.ProcessEnv): Promise<ClaudeCredential | undefined> {
  const { claude } = await readCredentials(env);
  return claude !== undefined && Object.hasOwn(claude, name) ? claude[name] : undefined;
}

export async function saveClaudeCredential(name: string, cred: ClaudeCredential, env?: NodeJS.ProcessEnv): Promise<void> {
  await updateCredentials((current) => ({ ...current, claude: { ...current.claude, [name]: cred } }), env);
}

export async function removeClaudeCredential(name: string, env?: NodeJS.ProcessEnv): Promise<void> {
  // nothing to remove, nothing written: an unreadable file reads as {} and a rewrite would drop every other login
  await updateCredentials((current) => {
    if (current.claude === undefined || !Object.hasOwn(current.claude, name)) return undefined;
    const { [name]: _gone, ...left } = current.claude;
    return { ...current, claude: left };
  }, env);
}

export type GithubCredential = NonNullable<Credentials['github']>[string];

/** #959: the stored logins, sorted: never a token. */
export async function githubLoginsStored(env?: NodeJS.ProcessEnv): Promise<string[]> {
  return Object.keys((await readCredentials(env)).github ?? {}).sort();
}

/** #959: a second save of a login replaces its token; another login adds an entry. */
export async function saveGithubCredential(login: string, cred: GithubCredential, env?: NodeJS.ProcessEnv): Promise<void> {
  await updateCredentials((current) => ({ ...current, github: { ...current.github, [login]: cred } }), env);
}

/** #959: false, with nothing written, when the login is not stored (own entries only); an unreadable file is never rewritten. */
export async function removeGithubCredential(login: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  let removed = false;
  await updateCredentials((current) => {
    if (current.github === undefined || !Object.hasOwn(current.github, login)) return undefined;
    removed = true;
    const { [login]: _gone, ...left } = current.github;
    return { ...current, github: left };
  }, env);
  return removed;
}

export async function gitlabCredential(host: string, env?: NodeJS.ProcessEnv): Promise<GitlabCredential | undefined> {
  const { gitlab } = await readCredentials(env);
  return gitlab !== undefined && Object.hasOwn(gitlab, host) ? gitlab[host] : undefined;
}

/** #1048: a second save of a host replaces its whole entry (token, username, expiry): the reconnect after a token expires or is rotated. */
export async function saveGitlabCredential(host: string, cred: GitlabCredential, env?: NodeJS.ProcessEnv): Promise<void> {
  await updateCredentials((current) => ({ ...current, gitlab: { ...current.gitlab, [host]: cred } }), env);
}

/** #1048: false, with nothing written, when the host has no account (own entries only); an unreadable file is never rewritten. */
export async function removeGitlabCredential(host: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  let removed = false;
  await updateCredentials((current) => {
    if (current.gitlab === undefined || !Object.hasOwn(current.gitlab, host)) return undefined;
    removed = true;
    const { [host]: _gone, ...left } = current.gitlab;
    return { ...current, gitlab: left };
  }, env);
  return removed;
}
