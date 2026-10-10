// The file paths a line of a worker's terminal shows (#258), for the terminal window's link provider: a relative path with a `/` or a file
// extension, or an absolute one, with an optional :line or :line:col. Pure, so node:test covers it; src/ui/terminal.ts wires it to xterm.

/** One path found in a line: its text, its optional position, and its span in the line (start inclusive, end exclusive). */
export interface FileLink {
  path: string;
  line?: number;
  col?: number;
  start: number;
  end: number;
}

// Never right after a path character, a `:` or a `/`, so a URL's host and path (`https://x/a.md`) never start a match. The last character
// is not a `.`, so a sentence's full stop stays outside.
const CANDIDATE = /(?<![\w.~@+\-/:])(\/?(?:[\w.~@+-]+\/)*[\w.~@+-]*[\w~@+-])(?::(\d+)(?::(\d+))?)?/g;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/;

// A plain word is no path: it needs a `/` (relative or absolute) or an extension after a name.
const looksLikeFile = (path: string): boolean => path.includes('/') || EXTENSION.test(path);

/** Every path in `text`, in order. Links are not checked against the disk: a miss answers 404 on click and nothing opens. */
export function findFileLinks(text: string): FileLink[] {
  return [...text.matchAll(CANDIDATE)].flatMap((match) => {
    const [whole, path, line, col] = match;
    if (!looksLikeFile(path)) return [];
    const at = { ...(line ? { line: Number(line) } : {}), ...(line && col ? { col: Number(col) } : {}) };
    return [{ path, ...at, start: match.index, end: match.index + whole.length }];
  });
}
