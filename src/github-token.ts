import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Exec } from './types.js';

export const GITHUB_HOST = 'github.com'; // the repository routes know no other host
export const NO_GH_TOKEN_MESSAGE = 'no GitHub token: run gh auth login';
const TOKEN_ARGS = ['auth', 'token', '--hostname', GITHUB_HOST];
const TOKEN_TIMEOUT_MS = 10_000;
const MISSING = -1; // hosts.yml absent: a stat key no real mtime takes
// A header value holds visible ASCII only: fetch would otherwise reject it quoting the whole value, bearer included, into a log line
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
// Inherited credentials would make gh answer for another account than the login that stamps the rows (#180)
const INHERITED_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];
const execFileAsync: Exec = promisify(execFile);

/** gh as the credential only (#503): its github.com login and its token, held in memory once per daemon. */
export interface GhToken { login(): Promise<string>; token(): Promise<string>; invalidate(): void }
export interface GhTokenDeps { exec: Exec; env: NodeJS.ProcessEnv; stat(path: string): Promise<{ mtimeMs: number }>; readFile(path: string): Promise<string> }

/** cli: gh reads as its logged-in account on github.com; an undefined value removes the variable from gh's environment. */
export const cliEnv = (): NodeJS.ProcessEnv => ({ GH_HOST: GITHUB_HOST, ...Object.fromEntries(INHERITED_TOKENS.map((name) => [name, undefined])) });

/** The child's environment: the parent's, then `env` over it; a key set to undefined is removed, not passed on. */
export function childEnv(base: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, value]) => value !== undefined));
}

/** The Authorization value for `token`; a token fetch would refuse throws a message that never quotes it. */
export function bearer(token: string): string {
  if (!TOKEN_CHARS.test(token)) throw new Error('github: malformed token');
  return `Bearer ${token}`;
}

/** gh's own lookup: GH_CONFIG_DIR, else XDG_CONFIG_HOME/gh, else ~/.config/gh. */
export function hostsPath(env: NodeJS.ProcessEnv): string {
  return join(env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh'), 'hosts.yml');
}

/** The github.com block's own `user:` line. The block's first indent is its key level, so the users map's nested names never match. */
export function loginFromHosts(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^github\.com:\s*$/.test(line));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() !== '' && !/^\s/.test(line));
  const block = end < 0 ? rest : rest.slice(0, end);
  const indent = /^(\s+)\S/.exec(block.find((line) => line.trim() !== '') ?? '')?.[1];
  if (indent === undefined) return '';
  const user = block.find((line) => line.startsWith(`${indent}user:`) && !/^\s/.test(line.slice(indent.length)));
  return /^\s*user:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(user ?? '')?.[1] ?? '';
}

/** One holder per daemon: login() is a stat per call and a read only when hosts.yml changed (a logout or a switch rewrites it, and drops
 * the token); token() runs gh once until invalidated. Memory only: the credential store is the api login's. */
export function createGhToken(given: Partial<GhTokenDeps> = {}): GhToken {
  const deps: GhTokenDeps = { exec: execFileAsync, env: process.env, stat: (path) => stat(path), readFile: (path) => readFile(path, 'utf8'), ...given };
  const path = hostsPath(deps.env);
  let seen: number | undefined;
  let login: Promise<string> = Promise.resolve('');
  let held: Promise<string> | undefined;
  const invalidate = (): void => {
    held = undefined;
  };
  const readToken = async (): Promise<string> => {
    // gh's words may echo a request: only the instruction travels
    const { stdout } = await deps.exec('gh', TOKEN_ARGS, { env: childEnv(deps.env, cliEnv()), timeout: TOKEN_TIMEOUT_MS }).catch(() => ({ stdout: '' }));
    const token = stdout.trim();
    if (!TOKEN_CHARS.test(token)) throw new Error(NO_GH_TOKEN_MESSAGE);
    return token;
  };
  const readLogin = async (): Promise<string> => {
    const mtime = await deps.stat(path).then((s) => s.mtimeMs, () => MISSING);
    if (mtime !== seen) {
      seen = mtime;
      invalidate(); // the held token may be another account's now
      login = mtime === MISSING ? Promise.resolve('') : deps.readFile(path).then(loginFromHosts, () => {
        seen = undefined; // a failed read is retried on the next call, not cached until the file changes again
        return '';
      });
    }
    return login;
  };
  return {
    invalidate,
    login: readLogin,
    token: async () => {
      await readLogin(); // a stat: the poll and Settings never call login(), yet must not keep a switched-away account's token
      if (held !== undefined) return held;
      const reading = readToken();
      held = reading;
      reading.catch(() => {
        if (held === reading) held = undefined; // a failure is not held: the next request asks gh again
      });
      return reading;
    },
  };
}
