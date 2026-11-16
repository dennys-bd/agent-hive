// Atlassian Document Format to Markdown (#814). Jira bodies and comments are ADF; the read model and the agents read Markdown.
// The reverse direction lives in adf-parse.ts; both share the node shapes, the mark order and the limits below. A Jira document is
// remote input: every node is checked before it is read, and nothing it holds reaches the Markdown unescaped.

export interface AdfMark { type: string; attrs?: Record<string, unknown> }
export interface AdfNode { type: string; attrs?: Record<string, unknown>; content?: AdfNode[]; text?: string; marks?: AdfMark[] }
export interface AdfDoc { version: 1; type: 'doc'; content: AdfNode[] }

/** Outermost first: the parser emits marks in this order and the renderer nests them in it, so a document round-trips equal. */
export const MARK_ORDER = ['link', 'strong', 'em', 'code'] as const;

/** The URL scheme a mention takes in Markdown: `[@Name](mention:<accountId>)` reads as the name and converts back to a mention. */
export const MENTION_SCHEME = 'mention:';

/** Past this nesting a node is read as flat text, so a hostile document cannot overflow the stack. */
export const MAX_DEPTH = 48;
export const SAFE_HREF = /^(?:https?|mailto):/i;
export const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const LANGUAGE = /^[\w+#.-]{1,32}$/;

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'date', 'status', 'placeholder']);

const hasType = (value: unknown): value is { type: string } =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
export const kids = (node: AdfNode): AdfNode[] => (Array.isArray(node.content) ? node.content.filter((child): child is AdfNode => hasType(child)) : []);
const marksOf = (node: AdfNode): AdfMark[] => (Array.isArray(node.marks) ? node.marks.filter((mark): mark is AdfMark => hasType(mark)) : []);
const isList = (node: AdfNode): boolean => node.type === 'bulletList' || node.type === 'orderedList';

/** Jira answers `null` for an empty description, so an absent document reads as no Markdown. */
export function adfToMarkdown(doc: AdfDoc | AdfNode | null | undefined): string {
  return hasType(doc) ? blocks(kids(doc), 0) : '';
}

/** Two lists of one kind in a row take the other marker (`*`, `)`), or the parser would read them back as one list. */
function blocks(nodes: AdfNode[], depth: number): string {
  const out: string[] = [];
  let alternate = false;
  nodes.forEach((node, index) => {
    alternate = isList(node) && index > 0 && nodes[index - 1].type === node.type && !alternate;
    const text = block(node, depth, alternate);
    if (text !== '') out.push(text);
  });
  return out.join('\n\n');
}

function block(node: AdfNode, depth: number, alternate = false): string {
  if (depth > MAX_DEPTH) return escapeLineStarts(escapeText(flatText(node)));
  switch (node.type) {
    case 'paragraph':
      return escapeLineStarts(inline(withoutTrailingBreaks(kids(node))));
    case 'heading':
      return `${'#'.repeat(headingLevel(node))} ${headingText(node)}`;
    case 'bulletList':
      return list(node, depth, () => (alternate ? '* ' : '- '));
    case 'orderedList':
      return list(node, depth, (index) => `${orderOf(node) + index}${alternate ? ')' : '.'} `);
    case 'codeBlock':
      return codeBlock(node);
    case 'blockquote':
      return blocks(kids(node), depth + 1).split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
    default:
      return escapeLineStarts(escapeText(textOf(node, depth)));
  }
}

function headingLevel(node: AdfNode): number {
  const level = Number(node.attrs?.level);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1;
}

/** One line, and a closing `#` escaped, since the parser strips a heading's closing hashes. */
function headingText(node: AdfNode): string {
  const text = inline(kids(node)).replace(/\\?\n/g, ' ');
  return text.endsWith('#') ? `${text.slice(0, -1)}\\#` : text;
}

function orderOf(node: AdfNode): number {
  const order = Number(node.attrs?.order);
  return Number.isInteger(order) && order >= 0 ? order : 1;
}

function list(node: AdfNode, depth: number, marker: (index: number) => string): string {
  return kids(node).map((item, index) => listItem(item, marker(index), depth + 1)).join('\n');
}

/** The item's first block sits on the marker line; the rest is indented to the marker's width, a nested list tight under it. */
function listItem(item: AdfNode, marker: string, depth: number): string {
  const body = kids(item)
    .map((child, index) => (index === 0 ? block(child, depth) : `${isList(child) ? '\n' : '\n\n'}${block(child, depth)}`))
    .join('');
  const pad = ' '.repeat(marker.length);
  return marker + body.split('\n').map((line, index) => (index === 0 || line === '' ? line : pad + line)).join('\n');
}

function codeBlock(node: AdfNode): string {
  const code = kids(node).map((child) => (typeof child.text === 'string' ? child.text : '')).join('');
  const fence = '`'.repeat(Math.max(2, longestRun(code)) + 1);
  const language = typeof node.attrs?.language === 'string' && LANGUAGE.test(node.attrs.language) ? node.attrs.language : '';
  return `${fence}${language}\n${code}\n${fence}`;
}

function longestRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    run = char === '`' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** A Shift+Enter left at a paragraph's end has no Markdown form that reads back, so it is dropped. */
function withoutTrailingBreaks(nodes: AdfNode[]): AdfNode[] {
  let end = nodes.length;
  while (end > 0 && nodes[end - 1].type === 'hardBreak') end -= 1;
  return nodes.slice(0, end);
}

/** A `!` right before a link would read back as an image, so it is escaped there. */
function inline(nodes: AdfNode[]): string {
  const parts = nodes.map(inlineNode).filter((part) => part !== '');
  // one join, not a growing string: a remote paragraph may hold many thousand nodes
  return parts.map((part, index) => (part.endsWith('!') && parts[index + 1]?.startsWith('[') ? `${part.slice(0, -1)}\\!` : part)).join('');
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return marked(typeof node.text === 'string' ? node.text : '', marksOf(node));
    case 'hardBreak':
      return '\\\n';
    case 'mention':
      return mention(node);
    default:
      return escapeText(textOf(node, 0));
  }
}

function mention(node: AdfNode): string {
  const id = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
  const text = escapeText(typeof node.attrs?.text === 'string' ? node.attrs.text : `@${id}`);
  return ACCOUNT_ID.test(id) ? `[${text}](${MENTION_SCHEME}${id})` : text;
}

/** Nests the supported marks in MARK_ORDER; any other mark (strike, underline, colour) is dropped and its text kept. */
function marked(text: string, marks: AdfMark[]): string {
  const has = (type: string) => marks.find((mark) => mark.type === type);
  const body = has('code') ? inlineCode(text) : emphasized(text, Boolean(has('strong')), Boolean(has('em')));
  const href = safeHref(has('link')?.attrs?.href);
  return href === undefined ? body : `[${body}](${href})`;
}

/** A delimiter beside a space neither opens nor closes, so the text's edge spaces go outside bold and italic. */
function emphasized(text: string, strong: boolean, em: boolean): string {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if ((!strong && !em) || start >= end) return escapeText(text);
  let core = escapeText(text.slice(start, end));
  if (em) core = `_${core}_`;
  if (strong) core = `**${core}**`;
  return text.slice(0, start) + core + text.slice(end);
}

function inlineCode(text: string): string {
  const fence = '`'.repeat(longestRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** Only web and mail links survive, percent-encoded where a character would end or break the Markdown destination. */
export function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SAFE_HREF.test(value)) return undefined;
  // encodeURIComponent leaves parentheses alone, and they end a destination
  return [...value].map((char) => (breaksDestination(char) ? encodeURIComponent(char).replace('(', '%28').replace(')', '%29') : char)).join('');
}

const breaksDestination = (char: string): boolean => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f || /[\s()<>\\]/.test(char);

/** The text of a node the codec does not render: its own text, an inline node's label, its children's text with block children one
 * per line, or `[type]` when none of them has any; never an exception, never an empty string for a node that held something. */
export function textOf(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return flatText(node);
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  const label = node.attrs?.text ?? node.attrs?.shortName ?? node.attrs?.url;
  if (typeof label === 'string' && label !== '') return label;
  const children = kids(node);
  const joiner = children.every((child) => INLINE.has(child.type)) ? '' : '\n';
  const text = children.map((child) => textOf(child, depth + 1)).filter((part) => part !== '').join(joiner);
  return text !== '' ? text : placeholder(node);
}

const placeholder = (node: AdfNode): string => `[${/^media/.test(node.type) ? 'media' : node.type}]`;

/** Every text under a node, without recursion: what a node nested past MAX_DEPTH reads as. */
function flatText(root: AdfNode): string {
  const parts: string[] = [];
  const stack: AdfNode[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (typeof node.text === 'string') parts.push(node.text);
    stack.push(...kids(node).reverse());
  }
  return parts.join(' ') || placeholder(root);
}

/** Backslash-escapes what the parser would read as a mark; an underscore inside a word (snake_case) is left as it is. */
function escapeText(text: string): string {
  return text
    .replace(/[\\`*[\]]/g, '\\$&')
    .replace(/_/g, (match, at: number, all: string) => (isWordChar(all[at - 1]) && isWordChar(all[at + 1]) ? match : '\\_'));
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** A paragraph line that would open another block (`#`, `>`, `-`, `+`, `<`, `~~~`, `1. `) gets its opening escaped; its leading
 * spaces go, as the parser drops them anyway. */
function escapeLineStarts(text: string): string {
  return text
    .split('\n')
    .map((raw) => {
      const line = raw.trimStart();
      const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(line);
      if (ordered) return `${ordered[1]}\\${line.slice(ordered[1].length)}`;
      return /^(#|>|[-+<]|~~~)/.test(line) ? `\\${line}` : line;
    })
    .join('\n');
}
