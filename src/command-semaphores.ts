import { resolveImpl } from './run-commands.js';
import { type Command, ENV_NAME } from './types.js';

// The Command Semaphores at run time (#798). The daemon alone matches an argv against the lines with a semaphore in the pty's workspace.

export interface SemaphoreLine { semaphore: string; words: string[] }

// Decision 1: the first command ends at the first ;, & or | (&& and || included), so 2>&1 is cut to a redirect, which never matches
const FIRST_COMMAND_END = /[;&|]/;
// A word the daemon would have to expand (a quote, $, a backtick, a redirect, a glob, a parenthesis, an escape, ~ or a brace) cannot be compared
// with an argv: the line never matches instead of matching wrong
const UNMATCHABLE = /['"`$<>*?[\](){}~\\]/;

const isAssignment = (word: string): boolean => {
  const at = word.indexOf('=');
  return at > 0 && ENV_NAME.test(word.slice(0, at));
};

/** The words a line matches by (#798, decision 1): its first command's, its leading NAME=value words skipped; undefined = it never matches. */
export function lineWords(command: string): string[] | undefined {
  const first = command.split(FIRST_COMMAND_END)[0] ?? '';
  if (UNMATCHABLE.test(first)) return undefined;
  const words = first.split(/\s+/).filter((w) => w !== '');
  const start = words.findIndex((w) => !isAssignment(w));
  return start === -1 ? undefined : words.slice(start);
}

/** The semaphore of the line whose words prefix `argv` (#798, decision 2): the most words wins, then the first in `lines`' order. */
export function matchSemaphore(argv: readonly string[], lines: readonly SemaphoreLine[]): string | undefined {
  let best: SemaphoreLine | undefined;
  for (const line of lines) {
    const isPrefix = line.words.length <= argv.length && line.words.every((w, i) => w === argv[i]);
    if (isPrefix && line.words.length > (best?.words.length ?? 0)) best = line;
  }
  return best?.semaphore;
}

/** A workspace's lines with a semaphore (#798, decision 3): per command, the line resolveCommand picks there, in comb.commands order. */
export function workspaceLines(commands: readonly Command[], workspace: string): SemaphoreLine[] {
  return commands.flatMap((c) => {
    const impl = resolveImpl(c, workspace);
    const words = impl?.semaphore === undefined ? undefined : lineWords(impl.command);
    return impl?.semaphore === undefined || words === undefined ? [] : [{ semaphore: impl.semaphore, words }];
  });
}
