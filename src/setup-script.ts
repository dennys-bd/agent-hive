import { isAbsolute } from 'node:path';

/** One step of a workspace's worktree setup or teardown (#299, #654): its line in the text it came from, the instruction, its argument (a
 * COPY's source) and, for a COPY that names one, its destination. */
export interface SetupStep { line: number; kind: 'copy' | 'run' | 'load' | 'del'; arg: string; dest?: string }

// Matched case-sensitively in uppercase, as a Dockerfile's instructions are.
const KINDS: Readonly<Record<string, SetupStep['kind']>> = { COPY: 'copy', RUN: 'run', LOAD: 'load', DEL: 'del' };
const WORDS: Readonly<Record<SetupStep['kind'], string>> = { copy: 'COPY', run: 'RUN', load: 'LOAD', del: 'DEL' };
const HOME = '~'; // only a COPY destination expands it (#654)
const TWO_ARGS = 'COPY takes a source and at most one destination';
const COMMENT = '#';
const HIVE_OWNED = ['.git', '.hive']; // git's and the Hive's own state: a setup never reads from them

/** Why a COPY / LOAD / DEL path cannot be used, lexically (#299): absolute, a `..` segment, nothing named (`.` would copy the whole checkout,
 * `.git` included), or a first segment `.git` / `.hive`. Undefined when it is fine. runSetup checks the real path too: a symlink can
 * still lead out. */
export function checkRelativePath(path: string): string | undefined {
  if (isAbsolute(path)) return 'the path must be relative to the workspace';
  const segments = path.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return 'the path cannot contain ".."';
  if (segments.length === 0) return 'the path must name a file or folder in the workspace';
  return HIVE_OWNED.includes(segments[0]) ? `the path cannot be inside ${segments[0]}` : undefined;
}

/** `COPY .env`, `COPY docs/ ~/x/`, `RUN pnpm install`: the task's progress line and the log's name for a step. */
export const describeStep = (step: SetupStep): string => `${WORDS[step.kind]} ${step.arg}${step.dest === undefined ? '' : ` ${step.dest}`}`;

// A path read or deleted on the Hive's own side (#654): relative inside the repo, never `~…`, which only a COPY destination expands.
const checkInside = (path: string): string | undefined => (path.startsWith(HOME) ? 'the path must be relative to the workspace' : checkRelativePath(path));

// A COPY destination (#654): absolute, `~` or `~/…` is written exactly there (the user's own line, with the power a RUN cp has); `~user` is
// refused, as is a `..` under `~/`; anything else is relative to the other side and checked as a source is.
function checkDestination(dest: string): string | undefined {
  if (dest.startsWith(HOME)) {
    if (dest !== HOME && !dest.startsWith(`${HOME}/`)) return 'only ~ and ~/ expand to the home folder';
    // the home folder is the user's, but a `..` would climb out of it: only an absolute path says that outright
    return dest.split(/[\\/]/).includes('..') ? 'the path cannot contain ".."' : undefined;
  }
  return isAbsolute(dest) ? undefined : checkRelativePath(dest);
}

// One line already trimmed, neither blank nor a comment. The first word is the instruction; a COPY splits the rest on whitespace into a source
// and an optional destination, any other instruction takes the rest of the line.
function parseLine(text: string, line: number, allowLoad: boolean): SetupStep {
  const word = text.split(/\s/, 1)[0];
  const fail = (reason: string): never => {
    throw new Error(`line ${line}: ${reason}`);
  };
  // A loaded file may be anything the user pointed at (a .env): its words and paths are never echoed into an error, which reaches the log's
  // first line
  const named = allowLoad ? ` ${word}` : '';
  const kind = Object.hasOwn(KINDS, word) ? KINDS[word] : fail(`unknown instruction${named} (COPY, RUN, LOAD or DEL)`);
  const rest = text.slice(word.length).trim();
  if (rest === '') fail(`${word} needs an argument`);
  if (kind === 'load' && !allowLoad) fail('LOAD cannot be used inside a loaded file');
  if (kind === 'run') return { line, kind, arg: rest };
  const [arg, dest, ...more] = kind === 'copy' ? rest.split(/\s+/) : [rest];
  if (more.length > 0) fail(TWO_ARGS);
  const refuse = (path: string, problem: string | undefined): void => {
    if (problem) fail(`${word}${allowLoad ? ` ${path}` : ''}: ${problem}`);
  };
  refuse(arg, checkInside(arg));
  if (dest !== undefined) refuse(dest, checkDestination(dest));
  return dest === undefined ? { line, kind, arg } : { line, kind, arg, dest };
}

/** A workspace's setup text as steps (#299): one instruction per line, blank lines and `#` comments skipped, lines counted from 1 over the
 * whole text. The first bad line throws `line <n>: <reason>`. `allowLoad` is off inside a loaded file: one level only. */
export function parseSetup(text: string, { allowLoad }: { allowLoad: boolean }): SetupStep[] {
  return text.split('\n').flatMap((raw, i) => {
    const line = raw.trim();
    return line === '' || line.startsWith(COMMENT) ? [] : [parseLine(line, i + 1, allowLoad)];
  });
}
