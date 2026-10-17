import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/** Where the worktree setup copies the workers' sandbox from (`COPY` reads the main checkout): a project-local settings file, since a
 *  second `--settings` beside the Hive's own hooks.json would void both. */
export const SANDBOX_FILE = '.claude/settings.local.json';
// What a worker's Bash must never read: the user's keys and logins, and the experiment's own folder (it names the arms)
const SECRET_READS = ['~/.ssh', '~/.aws', '~/.config/gh', '~/.gnupg'];
// pnpm install runs in the setup, outside the sandbox; the registry is for a worker adding a package, localhost for the Hive's own tests
const ALLOWED_DOMAINS = ['registry.npmjs.org', 'localhost', '127.0.0.1'];

/** A clone the workers commit into: its git folder and its origin. */
export interface RepoPaths { gitDir: string; origin: string }
// repos: the code clone and the docs clone (#79). plugins: each open run's <home>/plugins/<workspace>, re-allowed by exact path (a glob in allowRead
// does not take) inside the denied state folder
export interface SandboxPaths { repos: readonly RepoPaths[]; state: string; plugins?: readonly string[] }

/** Claude Code's Bash sandbox for every worker of both arms: commands inside it run without a prompt, none may run outside it, and the
 *  session stops if it cannot start. Writes reach the worktree (the sandbox's default, its docs worktree included), each clone's git folder
 *  (a worktree's commits land there) and a local origin (the Merge push); nothing else. */
export function sandboxSettings(p: SandboxPaths): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      filesystem: {
        allowWrite: p.repos.flatMap((r) => [r.gitDir, ...(isAbsolute(r.origin) ? [r.origin] : [])]), denyRead: [...SECRET_READS, p.state],
        ...(p.plugins && p.plugins.length > 0 ? { allowRead: [...p.plugins] } : {}),
      },
      network: { allowedDomains: ALLOWED_DOMAINS, allowLocalBinding: true }, // the Hive's own tests listen on localhost ports
    },
  };
}

/** Written once per night into the main checkout, and listed in the clone's own exclude file so no worker commits it. */
export async function installSandbox(root: string, gitCommonDir: string, settings: Record<string, unknown>): Promise<void> {
  const file = join(root, SANDBOX_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  const exclude = join(gitCommonDir, 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  if (current.split('\n').includes(SANDBOX_FILE)) return;
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(exclude, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${SANDBOX_FILE}\n`);
}
