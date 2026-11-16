// The inline half of Markdown to ADF (#814): marks, code spans, links, mentions and hard breaks inside one block's text.
import { ACCOUNT_ID, type AdfMark, type AdfNode, MARK_ORDER, MAX_DEPTH, MENTION_SCHEME, SAFE_HREF } from './adf.js';

const PUNCT = /[!-/:-@[-`{-~]/;
const BACKTICKS = /`+/y;
const DESTINATION = /([^\s()]*)\)/y;
const ANGLED = /<([^<>\n]*)>\)/y;

/** One string's scan state: its bracket pairs, found once, and where each delimiter is known to have no closer, so a run of
 * unmatched openers costs one scan instead of one per opener. */
interface Scan { text: string; depth: number; brackets: Map<number, number>; noCloser: Map<string, number> }

type Span = { nodes: AdfNode[]; next: number } | { literal: string; next: number };

export function parseInline(text: string): AdfNode[] {
  return parseSpan(text, [], 0);
}

function parseSpan(text: string, marks: AdfMark[], depth: number): AdfNode[] {
  if (depth > MAX_DEPTH) return text ? [textNode(text, marks)] : [];
  const scan: Scan = { text, depth, brackets: bracketPairs(text), noCloser: new Map() };
  const out: AdfNode[] = [];
  let plain = '';
  let at = 0;
  while (at < text.length) {
    const span = spanAt(scan, at, marks);
    if (span && 'nodes' in span) {
      if (plain) out.push(textNode(plain, marks));
      plain = '';
      out.push(...span.nodes);
    } else if (span) plain += span.literal;
    else plain += text[at];
    at = span ? span.next : at + 1;
  }
  if (plain) out.push(textNode(plain, marks));
  return out;
}

function spanAt(scan: Scan, at: number, marks: AdfMark[]): Span | undefined {
  const { text } = scan;
  const char = text[at];
  if (char === '\\') return escaped(text, at);
  if (char === '\n') return { nodes: [{ type: 'hardBreak' }], next: at + 1 };
  if (char === '`') return codeSpan(scan, at, marks);
  if (char === '[') return link(scan, at, marks);
  if (text.startsWith('**', at)) return delimited(scan, at, '**', marks, { type: 'strong' });
  if (char === '_' || char === '*') return delimited(scan, at, char, marks, { type: 'em' });
  return undefined;
}

function escaped(text: string, at: number): Span | undefined {
  const next = text[at + 1];
  if (next === '\n') return { literal: '', next: at + 1 };
  return next !== undefined && PUNCT.test(next) ? { literal: next, next: at + 2 } : undefined;
}

function codeSpan(scan: Scan, at: number, marks: AdfMark[]): Span {
  BACKTICKS.lastIndex = at;
  const run = BACKTICKS.exec(scan.text)?.[0] ?? '`';
  const key = `code${run.length}`;
  const none = scan.noCloser.get(key) ?? Number.POSITIVE_INFINITY;
  const found = at + run.length < none ? closingRun(scan.text, at + run.length, run) : -1;
  if (found < 0) {
    scan.noCloser.set(key, Math.min(at + run.length, none));
    return { literal: run, next: at + run.length };
  }
  const raw = scan.text.slice(at + run.length, found);
  const code = raw.length > 1 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '' ? raw.slice(1, -1) : raw;
  // ADF lets a code mark sit only beside a link, so a code span inside bold or italic keeps just the link
  const kept = withMark(marks.filter((mark) => mark.type === 'link'), { type: 'code' });
  return { nodes: [textNode(code, kept)], next: found + run.length };
}

/** The next backtick run exactly as long as the opening one. */
function closingRun(text: string, from: number, run: string): number {
  let at = text.indexOf(run, from);
  while (at >= 0) {
    BACKTICKS.lastIndex = at;
    const length = BACKTICKS.exec(text)?.[0].length ?? 1;
    if (length === run.length) return at;
    at = text.indexOf(run, at + length);
  }
  return -1;
}

/** A `**`, `*` or `_` pair; `_` opens and closes only at a word boundary, so snake_case stays text. */
function delimited(scan: Scan, at: number, delim: string, marks: AdfMark[], mark: AdfMark): Span | undefined {
  const { text } = scan;
  const start = at + delim.length;
  if (start >= text.length || /\s/.test(text[start])) return undefined;
  if (delim === '_' && isWordChar(text[at - 1])) return undefined;
  const none = scan.noCloser.get(delim) ?? Number.POSITIVE_INFINITY;
  if (start >= none) return undefined;
  for (let end = start + 1; end < text.length; end += 1) {
    if (text[end] === '\\') end += 1;
    else if (text.startsWith(delim, end) && !/\s/.test(text[end - 1]) && closes(text, end, delim)) {
      return { nodes: parseSpan(text.slice(start, end), withMark(marks, mark), scan.depth + 1), next: end + delim.length };
    }
  }
  scan.noCloser.set(delim, Math.min(start, none));
  return undefined;
}

function closes(text: string, end: number, delim: string): boolean {
  if (delim === '_') return !isWordChar(text[end + 1]);
  return delim === '*' ? text[end + 1] !== '*' && text[end - 1] !== '*' : true;
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** `[label](href)`, or `[@Name](mention:<accountId>)` read back as a mention. A link to anything but the web or mail keeps only its
 * label, so a `javascript:` link never reaches Jira. */
function link(scan: Scan, at: number, marks: AdfMark[]): Span | undefined {
  const close = scan.brackets.get(at);
  if (close === undefined || scan.text[close + 1] !== '(') return undefined;
  const dest = destination(scan.text, close + 2);
  if (!dest) return undefined;
  const label = scan.text.slice(at + 1, close);
  const mention = dest.href.startsWith(MENTION_SCHEME) ? dest.href.slice(MENTION_SCHEME.length) : undefined;
  if (mention !== undefined && ACCOUNT_ID.test(mention)) {
    const attrs = { id: mention, text: label.replace(/\\([!-/:-@[-`{-~])/g, '$1') };
    return { nodes: [{ type: 'mention', attrs }], next: dest.next };
  }
  const inner = SAFE_HREF.test(dest.href) ? withMark(marks, { type: 'link', attrs: { href: dest.href } }) : marks;
  return { nodes: parseSpan(label, inner, scan.depth + 1), next: dest.next };
}

function bracketPairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '\\') at += 1;
    else if (text[at] === '[') open.push(at);
    else if (text[at] === ']' && open.length > 0) pairs.set(open.pop() as number, at);
  }
  return pairs;
}

function destination(text: string, from: number): { href: string; next: number } | undefined {
  const pattern = text[from] === '<' ? ANGLED : DESTINATION;
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? { href: match[1], next: from + match[0].length } : undefined;
}

function withMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  const rank = (type: string) => MARK_ORDER.indexOf(type as (typeof MARK_ORDER)[number]);
  return [...marks.filter((each) => each.type !== mark.type), mark].sort((a, b) => rank(a.type) - rank(b.type));
}

const textNode = (text: string, marks: AdfMark[]): AdfNode => (marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text });
