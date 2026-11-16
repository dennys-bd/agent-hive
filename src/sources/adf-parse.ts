// Markdown to Atlassian Document Format (#814): the subset adf.ts renders, read back. Markdown outside it (a GFM table, an image, raw
// HTML, a thematic break) becomes a code block holding its literal source, so nothing is lost and it stays readable in Jira. The
// Markdown may come from an agent that quoted remote text, so every scan is linear and the nesting is capped at MAX_DEPTH.
import { type AdfDoc, type AdfNode, MAX_DEPTH } from './adf.js';
import { parseInline } from './adf-inline.js';

interface Step { nodes: AdfNode[]; next: number }

// a backtick fence's info string holds no backtick (CommonMark), so an inline code span that opens a line is not a fence
const FENCE = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})([^\n]*))$/;
// `[^\n]*`, not `.*`: `.` stops at U+2028, and the failed `$` would then retry every split of the space run before it
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+([^\n]*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HTML = /^ {0,3}<(?:[A-Za-z][\w-]*(?:[\s/>]|$)|\/[A-Za-z]|!--)/;
const IMAGE = /(?<!\\)!\[[^[\]]*\]\([^()]*\)/;
const CODE_SPAN = /`+[^`]*`+/g;
/** What a list item and a block quote may hold in Jira's schema; a heading or a quote inside them is flattened. */
const NESTABLE = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock']);

export function markdownToAdf(markdown: string): AdfDoc {
  const content = parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'), 0);
  return { version: 1, type: 'doc', content: content.length > 0 ? content : [emptyParagraph()] };
}

const emptyParagraph = (): AdfNode => ({ type: 'paragraph', content: [] });

function parseBlocks(lines: string[], depth: number): AdfNode[] {
  if (depth > MAX_DEPTH) return [codeBlock(lines.join('\n'), '')];
  const out: AdfNode[] = [];
  let at = 0;
  while (at < lines.length) {
    if (isBlank(lines[at])) {
      at += 1;
      continue;
    }
    const step = blockAt(lines, at, depth);
    out.push(...step.nodes);
    at = step.next;
  }
  return out;
}

function blockAt(lines: string[], at: number, depth: number): Step {
  const line = lines[at];
  if (FENCE.test(line)) return fenced(lines, at);
  if (HEADING.test(line)) return { nodes: [heading(line)], next: at + 1 };
  if (RULE.test(line)) return literal(lines, at, at + 1);
  if (QUOTE.test(line)) return quote(lines, at, depth);
  if (ITEM.test(line)) return list(lines, at, depth);
  if (isTableStart(lines, at) || HTML.test(line)) return literal(lines, at, blockEnd(lines, at));
  return paragraph(lines, at);
}

const isBlank = (line: string): boolean => line.trim() === '';
const indentOf = (line: string): number => line.length - line.trimStart().length;
const startsBlock = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || HTML.test(line);

function isTableStart(lines: string[], at: number): boolean {
  if (!lines[at].includes('|') || at + 1 >= lines.length || !lines[at + 1].includes('|')) return false;
  const cells = lines[at + 1].trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function blockEnd(lines: string[], at: number): number {
  let end = at + 1;
  while (end < lines.length && !isBlank(lines[end])) end += 1;
  return end;
}

/** Markdown the codec does not read, kept as its literal source in a code block with no language. */
function literal(lines: string[], from: number, to: number): Step {
  return { nodes: [codeBlock(lines.slice(from, to).join('\n'), '')], next: to };
}

function codeBlock(text: string, language: string): AdfNode {
  return { type: 'codeBlock', ...(language ? { attrs: { language } } : {}), ...(text ? { content: [{ type: 'text', text }] } : {}) };
}

function fenced(lines: string[], at: number): Step {
  const match = FENCE.exec(lines[at]);
  const marker = match?.[1] ?? match?.[3] ?? '```';
  const info = match?.[2] ?? match?.[4] ?? '';
  const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
  let end = at + 1;
  while (end < lines.length && !close.test(lines[end])) end += 1;
  const language = info.trim().split(/\s+/)[0] ?? '';
  return { nodes: [codeBlock(lines.slice(at + 1, end).join('\n'), language)], next: Math.min(end + 1, lines.length) };
}

function heading(line: string): AdfNode {
  const [, hashes, raw] = HEADING.exec(line) ?? ['', '#', ''];
  return { type: 'heading', attrs: { level: hashes.length }, content: parseInline(withoutClosingHashes((raw ?? '').trimEnd())) };
}

/** `## Title ##` closes with hashes after a space; `C#` and an escaped `\#` keep theirs. A loop, not a `$` regex, so it stays linear. */
function withoutClosingHashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === text.length) return text;
  if (end === 0) return '';
  return /[ \t]/.test(text[end - 1]) ? text.slice(0, end).trimEnd() : text;
}

function quote(lines: string[], at: number, depth: number): Step {
  const inner: string[] = [];
  let end = at;
  for (let match = QUOTE.exec(lines[end] ?? ''); match; match = QUOTE.exec(lines[end] ?? '')) {
    inner.push(match[1]);
    end += 1;
  }
  const content = nestable(parseBlocks(inner, depth + 1));
  return { nodes: [{ type: 'blockquote', content: content.length > 0 ? content : [emptyParagraph()] }], next: end };
}

function nestable(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap((node) => {
    if (NESTABLE.has(node.type)) return [node];
    if (node.type === 'heading') return [{ type: 'paragraph', content: node.content ?? [] }];
    return nestable(node.content ?? []);
  });
}

/** Every line break inside a paragraph is a hard break: the Hive's Markdown is written for GitHub, which shows a newline as one. */
function paragraph(lines: string[], at: number): Step {
  let end = at + 1;
  while (end < lines.length && !isBlank(lines[end]) && !startsBlock(lines[end])) end += 1;
  if (lines.slice(at, end).some((line) => IMAGE.test(line.replace(CODE_SPAN, '')))) return literal(lines, at, end);
  const text = lines.slice(at, end).map((line, index, all) => (index < all.length - 1 ? withoutBreakMark(line) : line).trim()).join('\n');
  return { nodes: [{ type: 'paragraph', content: parseInline(text) }], next: end };
}

/** Drops the trailing spaces and a trailing hard-break backslash (an odd run: an even one is escaped backslashes), walking back from
 * the end instead of with a `$` regex, which backtracks on a long run. */
function withoutBreakMark(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  let run = 0;
  while (run < end && line[end - 1 - run] === '\\') run += 1;
  return line.slice(0, run % 2 === 1 ? end - 1 : end);
}

function list(lines: string[], at: number, depth: number): Step {
  const [, indent, marker] = ITEM.exec(lines[at]) ?? ['', '', '-'];
  const ordered = /\d/.test(marker);
  const items: AdfNode[] = [];
  let next = at;
  for (let cursor = at; cursor < lines.length; ) {
    const match = ITEM.exec(lines[cursor]);
    if (!match || match[1].length !== indent.length || /\d/.test(match[2]) !== ordered || match[2].slice(-1) !== marker.slice(-1)) break;
    const item = itemBody(lines, cursor, match);
    const content = nestable(parseBlocks(item.body, depth + 1));
    // Jira wants a list item to open with a paragraph or a code block, never with a list
    const opens = content.length > 0 && (content[0].type === 'paragraph' || content[0].type === 'codeBlock');
    items.push({ type: 'listItem', content: opens ? content : [emptyParagraph(), ...content] });
    next = item.next;
    cursor = item.next;
    while (cursor < lines.length && isBlank(lines[cursor])) cursor += 1;
  }
  const node: AdfNode = ordered
    ? { type: 'orderedList', attrs: { order: Number(marker.slice(0, -1)) }, content: items }
    : { type: 'bulletList', content: items };
  return { nodes: [node], next };
}

/** The item's lines, dedented: those indented under its marker, the blank lines between them, and a paragraph's lazy continuation. */
function itemBody(lines: string[], at: number, match: RegExpExecArray): { body: string[]; next: number } {
  const rest = match[3] ?? '';
  const contentCol = rest === '' ? match[1].length + match[2].length + 1 : lines[at].length - rest.length;
  const threshold = Math.min(contentCol, match[1].length + 2);
  const body = [rest];
  let end = at + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (isBlank(line)) {
      let ahead = end;
      while (ahead < lines.length && isBlank(lines[ahead])) ahead += 1;
      if (ahead === lines.length || indentOf(lines[ahead]) < threshold) break;
      body.push(...lines.slice(end, ahead).map(() => ''));
      end = ahead;
    } else if (indentOf(line) >= threshold) {
      body.push(line.slice(Math.min(indentOf(line), contentCol)));
      end += 1;
    } else if (!isBlank(body[body.length - 1]) && !startsBlock(line)) {
      body.push(line.trimStart());
      end += 1;
    } else break;
  }
  return { body, next: end };
}
