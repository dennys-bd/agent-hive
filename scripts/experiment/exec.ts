import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024; // a whole diff, or pnpm install's output

export interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
/** execFile with argv, never a shell string (CLAUDE.md); a cwd, since pnpm and claude run inside a worktree. */
export type Run = (file: string, args: string[], opts?: RunOptions) => Promise<{ stdout: string }>;

// Inherited, these stop a nested claude, misroute a test runner, or point a daemon at another home
const DROPPED_ENV: readonly string[] = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NODE_TEST_CONTEXT', 'HIVE_HOME'];

export function cleanEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !DROPPED_ENV.includes(key))), ...extra };
}

// The run branch's own install, build, test and daemon are its code, not ours: they get the toolchain's variables, so no secret held in
// the user's environment. HOME stays, as git and pnpm need it, so a file under it (a credentials file, ~/.ssh) is still within reach
const BUILD_ENV: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'CI', 'PNPM_HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'npm_config_cache', 'npm_config_store_dir', 'npm_config_registry', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'PLAYWRIGHT_BROWSERS_PATH',
];

export const buildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([key]) => BUILD_ENV.includes(key)));

export const execRun: Run = async (file, args, opts = {}) => {
  const { stdout } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env ?? cleanEnv(process.env), timeout: opts.timeoutMs ?? 0, maxBuffer: MAX_BUFFER, encoding: 'utf8' });
  return { stdout };
};

/** The same runner, each call in `cwd` unless it names its own: the docs clone's git calls go through the one serialGit (#79). */
export const inDir = (run: Run, cwd: string): Run => (file, args, opts = {}) => run(file, args, { ...opts, cwd: opts.cwd ?? cwd });

/** The harness's own git calls, one at a time (#105, the user): both runs of a pair share one repository, so branch, push and worktree
 *  calls must not race. Other commands pass straight through. ponytail: a per-call lock; the daemons' own git relies on git's lock files. */
export function serialGit(run: Run): Run {
  let tail: Promise<unknown> = Promise.resolve();
  return (file, args, opts) => {
    if (file !== 'git') return run(file, args, opts);
    const next = tail.then(() => run(file, args, opts));
    tail = next.catch(() => undefined);
    return next;
  };
}
