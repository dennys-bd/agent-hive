import { isAbsolute } from 'node:path';
import { PLUGINS_DIR } from '../plugin-render.js';
import { DAEMON_OUT } from './daemon-files.js';

/** home: this run's home (its plugins/ readable); homes: Hive homes whose daemon files no worker reads; denied: files or folders no worker
 *  reads. Absolute paths; a whole `*` segment stands for any one folder. */
export interface RunPaths { home: string; homes: readonly string[]; denied: readonly string[] }
export interface RunRules { allow: string[]; deny: string[] }

const ALLOW_FLAG = '--allowedTools';
const DENY_FLAG = '--disallowedTools';
// A space or comma would split the flag's list; a glob character would turn the literal path into a pattern (a whole `*` segment is allowed apart)
const UNSAFE = /[\s,()*?[\]!#\\]/;
// What a Hive home holds besides plugins/ (src/home.ts and the stores): read through any home, the other arm's above all, a worker would
// learn a daemon's secret and port, the other arm's stage commands or item versions, or the experiment's name. plugins/ holds each workspace's rendered plugin
const HOME_FILES = ['hive.*', '*.json', DAEMON_OUT, 'prompts/**', 'protocol/**', 'reviews/**', 'pr-reviews/**', 'custom/**', 'eval/**'];

const checked = (value: string, what: string): string => {
  if (UNSAFE.test(value)) throw new Error(`a permission rule cannot hold this ${what}: ${value}`);
  return value;
};

/** `//abs/path`: a single leading slash in a Read rule anchors at the settings source, not at the filesystem root. The paths are the Hive's
 *  own; a `*` segment is the caller's on purpose, any other glob character would turn a literal into a pattern. */
function rooted(path: string): string {
  if (!isAbsolute(path)) throw new Error(`a permission rule needs an absolute path: ${path}`);
  return `/${path.split('/').map((segment) => (segment === '*' ? segment : checked(segment, 'path'))).join('/')}`;
}

const pushForms = (branch: string): string[] => ['HEAD', '*'].flatMap((from) => [`Bash(git push origin ${from}:${branch})`, `Bash(git push origin ${from}:${branch} 2>&1)`]);

/** What one run adds to the seed's lists. The push is the Merge prompt's own, exact: an allow can never carve an exception out of a
 *  deny, so the seed denies every other push form and none of its denies matches this one. Read rules also bind Glob and Grep. */
export function runRules(runBranch: string, { home, homes, denied }: RunPaths): RunRules {
  return {
    // Its own branch only, anchored at the end: a trailing `*` would let a second refspec follow, so the one redirect workers write
    // (`2>&1`, seen in the smokes) is a rule of its own. The sha form's leading `*` cannot be narrower (a rule has no character classes);
    // the seed's denials still refuse an option, a forced refspec or main, and the sandbox keeps any push on the local origin
    allow: [...pushForms(checked(runBranch, 'branch')), `Read(${rooted(home)}/${PLUGINS_DIR}/**)`],
    deny: [
      ...denied.flatMap((path) => [`Read(${rooted(path)})`, `Read(${rooted(path)}/**)`]),
      ...homes.flatMap((dir) => HOME_FILES.map((file) => `Read(${rooted(dir)}/${file})`)),
    ],
  };
}

function withRules(args: readonly string[], flag: string, rules: readonly string[]): string[] {
  const at = args.indexOf(flag);
  if (at === -1 || at + 1 >= args.length) return [...args, flag, rules.join(' ')];
  return args.map((arg, i) => (i === at + 1 ? [arg, ...rules].join(' ') : arg));
}

/** The seed's claudeArgs with the run's rules joined to its two lists. */
export function runClaudeArgs(claudeArgs: readonly string[], runBranch: string, paths: RunPaths): string[] {
  const rules = runRules(runBranch, paths);
  return withRules(withRules(claudeArgs, ALLOW_FLAG, rules.allow), DENY_FLAG, rules.deny);
}

/** A permission list as Claude reads it: rules split on spaces or commas, except inside a rule's parentheses (`Bash(npm run x *)`). */
export function splitRules(text: string): string[] {
  const rules: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    depth = ch === '(' ? depth + 1 : ch === ')' ? Math.max(0, depth - 1) : depth;
    if (depth === 0 && /[\s,]/.test(ch)) {
      if (current !== '') rules.push(current);
      current = '';
    } else current += ch;
  }
  return current === '' ? rules : [...rules, current];
}

// The worker lists the retired #105 harness ran its arms with: the isolation rows' defaults of a new experiment (#459)
const WORKER_ALLOW_TEXT = 'Read(./**) Edit(./**) Write(./**) Glob Grep Task Skill TodoWrite mcp__hive__* Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git add:*) Bash(git commit:*) Bash(git merge:*) Bash(git rebase:*) Bash(git fetch:*) Bash(git switch:*) Bash(git checkout:*) Bash(git branch:*) Bash(git rev-parse:*) Bash(git symbolic-ref:*) Bash(git check-ignore:*) Bash(git -C:*) Bash(pnpm install:*) Bash(pnpm test:*) Bash(pnpm build:*) Bash(pnpm lint:*) Bash(pnpm exec tsc:*) Bash(pnpm exec vitest:*) Bash(pnpm exec biome:*) Bash(pnpm audit:*) Bash(npm test:*) Bash(npm run build:*) Bash(npm run typecheck:*) Bash(npm run test:coverage *) Bash(npm audit:*) Bash(npx tsc:*) Bash(tsc:*) Bash(mkdir:*) Bash(grep:*) Bash(rg:*) Bash(head:*) Bash(tail:*) Bash(sed -n:*) Bash(wc:*) Bash(cat:*) Bash(ls:*) Bash(echo:*) Bash(tr:*) Bash(sort:*) Bash(uniq:*) Bash(cut:*) Bash(diff:*) Bash(git ls-tree:*) Bash(git ls-files:*) Bash(git grep:*) Bash(cd:*) Bash(pwd:*) Bash(printf:*) Bash(basename:*) Bash(dirname:*) Bash(stat:*) Bash(du:*) Bash(which:*) Bash(date:*) Bash(jq:*)';
const WORKER_DENY_TEXT = 'Bash(git push) Bash(git push origin) Bash(git push -*) Bash(git push * -*) Bash(git push * +*) Bash(git push *main*) Bash(git push *refs/*) Bash(git push * HEAD) Bash(git push * feat/*) Bash(git push * hive/*) Bash(git push *:hive/*) Bash(git -* push*) Bash(git -C * -c *) Bash(git -C * --config-env*) Bash(git -C * --exec-path*) Bash(git -C * config*) Bash(gh:*) Bash(npx eslint:*) Bash(eslint:*) Bash(npx prettier:*) Bash(prettier:*) Bash(git * send-pack*) Bash(git send-pack*) Bash(git * http-push*) Bash(git http-push*) Bash(git *--upload-pack*) Bash(git *--receive-pack*) Bash(git *--no-index*) Bash(find * -exec*) Bash(find * -execdir*) Bash(find * -ok*) Bash(find * -delete*) Bash(find * -fprint*)';
export const WORKER_ALLOW: readonly string[] = splitRules(WORKER_ALLOW_TEXT);
export const WORKER_DENY: readonly string[] = splitRules(WORKER_DENY_TEXT);
