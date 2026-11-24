import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveExec } from '../exec-path.js';
import { defaultGithubToken, refusalOf, unauthorized, type GhEnv, type SelectedGithub } from '../github-account.js';
import { bearer, type GhToken } from '../github-token.js';
import type { Logger } from '../log.js';
import type { GithubAuth, Gql } from '../types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const API_URL = 'https://api.github.com/graphql';
const FETCH_TIMEOUT_MS = 10_000;
const QUERY_MAX = 200; // the GraphQL query is long; the head names the call, the rest is noise
export { NO_TOKEN_MESSAGE } from '../github-account.js'; // #959: moved beside the rule; fork.ts's tests import it from here

/** The `gh` runner: argv, and what goes to its stdin (#592), → stdout. cliGql and cliGqlJson use it. */
export type Exec = (args: string[], input?: string) => Promise<string>;

/** The tests' seams: the lookup's env (default: the daemon's, read on each call) and a fake file system. */
export interface GhLookup { env?: NodeJS.ProcessEnv; isFile?: (file: string) => boolean }

/** The `gh` runner of `platform` (#633): gh resolved on every call, by its full path on win32, so a gh installed while the Hive runs is found.
 *  A gh found nowhere fails like any failed gh, with the resolver's `gh was not found`. It pipes stdin itself, so it keeps its own execFile. */
export const ghExecFor = (platform: NodeJS.Platform, lookup: GhLookup = {}): Exec => async (args, input) => {
  try {
    const env = lookup.env ?? process.env;
    const gh = resolveExec('gh', args, { platform, env, isFile: lookup.isFile });
    // a lookup env is gh's own (#961: the selected login's GH_TOKEN); the .cmd runner's lines (no bare name looked up in the cwd) go over it. Neither: gh inherits the daemon's, as today
    const childEnv = lookup.env === undefined && gh.env === undefined ? {} : { env: { ...env, ...gh.env } };
    const run = execFileAsync(gh.file, [...gh.args], { maxBuffer: GH_MAX_BUFFER, windowsVerbatimArguments: gh.windowsVerbatimArguments, ...childEnv });
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

export const ghExec: Exec = ghExecFor(process.platform);

/** gh as the selected login (#961), read per call: a named login's env over the daemon's; the machine's login runs ghExecFor as today. */
export const selectedGhExec = (ghEnv: GhEnv, platform: NodeJS.Platform = process.platform): Exec => async (args, input) => {
  const env = await ghEnv();
  return ghExecFor(platform, Object.keys(env).length === 0 ? {} : { env: { ...process.env, ...env } })(args, input);
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

const UNAUTHORIZED = 401;

export interface ApiGqlDeps {
  fetch?: typeof fetch;
  readToken?: () => Promise<string>; // the login binds a token it has not stored yet
  env?: NodeJS.ProcessEnv;
  onUnauthorized?: () => void; // cli (#503): a 401 drops the held token; the next poll reads it again
  refusal?: () => Promise<string | undefined>; // #959: why a stored login's 401 happened, named in the rejection
}

/**
 * The Hive's own transport. The token is read per call and exists only inside it: no log line, no error message and no
 * rejection value ever carries it, and a non-2xx rejects with the status alone, never with the body.
 */
export function apiGql(deps: ApiGqlDeps = {}): Gql {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const readToken = deps.readToken ?? (() => defaultGithubToken(deps.env));
  return async (query, variables) => {
    const token = await readToken();
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: { Authorization: bearer(token), Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next poll is the retry
      redirect: 'manual', // the bearer never follows a redirect off the fixed host
    });
    if (res.status === UNAUTHORIZED) await unauthorized(deps, 'github api');
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

export interface GqlForOptions { log?: Logger; ghToken?: GhToken | SelectedGithub; fetch?: typeof fetch }

// #959: with the account's holder both transports read as its login over HTTP, a stored login's 401 naming it. Without one (a caller that
// was not handed it) cli stays on gh and api reads the only stored login
function transportOf(auth: GithubAuth, { ghToken, fetch }: GqlForOptions): Gql {
  if (ghToken !== undefined) return apiGql({ fetch, readToken: ghToken.token, onUnauthorized: ghToken.invalidate, refusal: refusalOf(ghToken) });
  return auth === 'api' ? apiGql({ fetch }) : cliGql();
}

/** The transport `auth.github` names, logged when the caller has a logger. The one place the choice is made. */
export function gqlFor(auth: GithubAuth, options: GqlForOptions = {}): Gql {
  const gql = transportOf(auth, options);
  return options.log ? loggedGql(gql, options.log) : gql;
}
