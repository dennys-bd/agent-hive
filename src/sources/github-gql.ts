import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCredentials } from '../credentials.js';
import type { Logger } from '../log.js';
import type { GithubAuth, Gql } from '../types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const API_URL = 'https://api.github.com/graphql';
const FETCH_TIMEOUT_MS = 10_000;
const QUERY_MAX = 200; // the GraphQL query is long; the head names the call, the rest is noise
export const NO_TOKEN_MESSAGE = 'no GitHub token: run `hive login` or connect in settings';

/** The `gh` runner: argv, and what goes to its stdin (#592), → stdout. cliGql and cliGqlJson use it. */
export type Exec = (args: string[], input?: string) => Promise<string>;

export const ghExec: Exec = async (args, input) => {
  try {
    const run = execFileAsync('gh', args, { maxBuffer: GH_MAX_BUFFER });
    if (input !== undefined) {
      // gh exiting before it reads the body is an EPIPE here; its exit status already carries the failure, and an unhandled one would kill the server
      run.child.stdin?.on('error', () => undefined);
      run.child.stdin?.end(input); // --input -: the request body, never an argv value (#592)
    }
    const { stdout } = await run;
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${(e.stderr ?? '').trim() || e.message}`);
  }
};

interface GqlBody { data?: unknown; errors?: { message?: string }[] }

// Errors win over data: GitHub answering partial data beside an errors array is a failed call, exactly as a failed gh call is.
function unwrap(body: unknown): unknown {
  const { data, errors } = (body ?? {}) as GqlBody;
  if (Array.isArray(errors) && errors.length > 0) throw new Error(errors[0]?.message ?? 'github graphql: unknown error');
  return data;
}

/** `gh api graphql`: the query as -f query=, one flag per variable (-F for a number or a boolean, so gh sends it as JSON, not as a string). */
export function cliGql(exec: Exec = ghExec): Gql {
  return async (query, variables) => {
    const flags = Object.entries(variables ?? {}).flatMap(([name, value]) => [typeof value === 'number' || typeof value === 'boolean' ? '-F' : '-f', `${name}=${value}`]);
    return unwrap(JSON.parse(await exec(['api', 'graphql', '-f', `query=${query}`, ...flags])));
  };
}

/** One GraphQL call whose variables may be lists and objects (#592): addPullRequestReview's threads. */
export type GqlJson = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/** `gh api graphql --input -` (#592): `{ query, variables }` as JSON on stdin, so a list of objects and free text travel as JSON values, never
 * as flags. The answer is unwrapped as cliGql's. */
export function cliGqlJson(exec: Exec = ghExec): GqlJson {
  return async (query, variables) => unwrap(JSON.parse(await exec(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }))));
}

/** The stored GitHub account, or undefined when nobody logged in. Kept private: `storedToken` is the only reason to
 * hold the token, and a type-level guarantee beats trusting every future caller to destructure `login` only. */
async function readGithubCredentials(env?: NodeJS.ProcessEnv): Promise<{ token: string; login: string } | undefined> {
  const { github } = await readCredentials(env);
  return github?.token ? github : undefined;
}

/** The stored GitHub account's name, or undefined when nobody logged in. What GET /settings/github/auth reports: never the token. */
export async function githubLoginName(env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await readGithubCredentials(env))?.login;
}

export interface ApiGqlDeps {
  fetch?: typeof fetch;
  readToken?: () => Promise<string>; // the login binds a token it has not stored yet
  env?: NodeJS.ProcessEnv;
}

async function storedToken(env?: NodeJS.ProcessEnv): Promise<string> {
  const stored = await readGithubCredentials(env);
  if (!stored) throw new Error(NO_TOKEN_MESSAGE); // makes resolveFields fail on boot, which reopens setup with the reason
  return stored.token;
}

/**
 * The Hive's own transport. The token is read per call and exists only inside it: no log line, no error message and no
 * rejection value ever carries it, and a non-2xx rejects with the status alone, never with the body.
 */
export function apiGql(deps: ApiGqlDeps = {}): Gql {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const readToken = deps.readToken ?? (() => storedToken(deps.env));
  return async (query, variables) => {
    const token = await readToken();
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next poll is the retry
      redirect: 'manual', // the bearer never follows a redirect off the fixed host
    });
    if (!res.ok) throw new Error(`github api: HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => {
      throw new Error('github api: invalid JSON body'); // res.json() would quote the body
    });
    return unwrap(body);
  };
}

const cut = (text: string): string => (text.length > QUERY_MAX ? `${text.slice(0, QUERY_MAX)}…` : text);
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/** Wraps a Gql so every call leaves a debug line with its variables, its query and the duration; data is never logged. */
export function loggedGql(gql: Gql, log: Logger): Gql {
  return async (query, variables) => {
    // variables are scalars from the config and the source; the token is a header, never a variable, so nothing secret is here
    const head = cut(`${JSON.stringify(variables ?? {})} ${query.replace(/\s+/g, ' ').trim()}`);
    const started = Date.now();
    try {
      const data = await gql(query, variables);
      log.debug(`graphql ${head} ${Date.now() - started}ms ok`);
      return data;
    } catch (err) {
      log.debug(`graphql ${head} ${Date.now() - started}ms error: ${firstLine(err)}`);
      throw err;
    }
  };
}

/** The transport `auth.github` names, logged when the caller has a logger. The one place the choice is made. */
export function gqlFor(auth: GithubAuth, log?: Logger): Gql {
  const gql = auth === 'cli' ? cliGql() : apiGql();
  return log ? loggedGql(gql, log) : gql;
}
