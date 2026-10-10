// The task references a row of a terminal shows (#588), for the terminals' link provider: `#N`, and `PREFIX-N` for a prefix the Hive gives
// its ids, the forms taskRef prints. Pure, beside file-links.ts; xterm-setup.ts wires it to xterm, and the server resolves a click.
import type { CombConfig } from '../../types.js';

/** One reference found in a row: its text, and its span in the row (start inclusive, end exclusive). */
export interface TaskRefMatch {
  ref: string;
  start: number;
  end: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The prefixes a `PREFIX-N` may use: the Comb's (local tasks), and every qualifyId source's prefix, or its name without one. */
export function refPrefixes({ comb }: { comb: Pick<CombConfig, 'prefix' | 'sources'> }): string[] {
  return [comb.prefix, ...comb.sources.filter((s) => s.qualifyId).map((s) => s.prefix ?? s.name)];
}

// `#N` never right after a word character, a `/` or a `=`, so `abc#1`, a URL's fragment and a query value stay text. `PREFIX-N` only for a
// known prefix, never inside a longer hyphenated name (`FOO-HIVE-11`), so `UTF-8` and `ISO-8601` stay text.
// ponytail: a CSS colour such as #123456 still reads as `#N`, and its click opens issue 123456; check the shape if that ever bites
function refPattern(prefixes: readonly string[]): RegExp {
  const named = prefixes.length === 0 ? '' : `|(?<![\\w-])(?:${prefixes.map(escapeRegExp).join('|')})-\\d+\\b`;
  return new RegExp(`(?<![\\w/=])#\\d+\\b${named}`, 'g');
}

/** Every reference in `text`, in order. Nothing is resolved here: the server answers a click, and a reference that resolves to nothing
 * opens nothing. */
export function findTaskRefs(text: string, prefixes: readonly string[]): TaskRefMatch[] {
  return [...text.matchAll(refPattern(prefixes))].map((match) => ({ ref: match[0], start: match.index, end: match.index + match[0].length }));
}
