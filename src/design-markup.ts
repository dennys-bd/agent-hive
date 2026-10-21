// A small scanner over a design's markup (#421): enough of HTML to find the include and slot markers, the templates a fill sits in and a
// part's top-level elements. Not a parser: it knows start and end tags, void elements, comments, and script and style bodies, which it reads
// as text so a marker inside one is left alone.
// ponytail: end tags HTML infers (an unclosed <p> or <li>) are not inferred, so a part closes its elements; a DOM parser if that ever bites

/** One tag: its lower-case name, where it starts and ends in the text, and its attributes as written. */
export interface Tag { name: string; start: number; end: number; isEnd: boolean; isSelfClosing: boolean; attrs: string }

// A quoted value may hold a >; the three alternatives start on different characters, so a match stays linear
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const RAW_TEXT = new Set(['script', 'style']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

const holdsContent = (tag: Tag): boolean => !tag.isEnd && !tag.isSelfClosing && !VOID.has(tag.name);

function tagOf([whole, slash, name, attrs]: RegExpExecArray, start: number): Tag {
  const isEnd = slash === '/';
  return { name: name.toLowerCase(), start, end: start + whole.length, isEnd, isSelfClosing: !isEnd && attrs.trimEnd().endsWith('/'), attrs };
}

// Where a script or style body ends: at its own end tag, which the scan reads next
function rawTextEnd(html: string, tag: Tag): number {
  const close = new RegExp(`</${tag.name}\\s*>`, 'ig');
  close.lastIndex = tag.end;
  return close.exec(html)?.index ?? html.length;
}

/** Every tag of `html` in order, none inside a comment or a script or style body. */
export function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  let at = html.indexOf('<');
  while (at !== -1) {
    if (html.startsWith(COMMENT_OPEN, at)) {
      const close = html.indexOf(COMMENT_CLOSE, at + COMMENT_OPEN.length);
      at = close === -1 ? -1 : html.indexOf('<', close + COMMENT_CLOSE.length);
      continue;
    }
    TAG.lastIndex = at;
    const match = TAG.exec(html);
    if (match === null) {
      at = html.indexOf('<', at + 1); // a < that opens no tag, as in "a < b"
      continue;
    }
    const tag = tagOf(match, at);
    tags.push(tag);
    at = html.indexOf('<', !tag.isEnd && RAW_TEXT.has(tag.name) ? rawTextEnd(html, tag) : tag.end);
  }
  return tags;
}

/** An attribute's value in a tag's attributes as written: any case, in double, single or no quotes; undefined when absent or bare. */
export function attrOf(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`/]+))`, 'i').exec(attrs);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
}

/** The end tag closing tags[index], counting the same name nested inside it; undefined when it is never closed. */
export function matchingEnd(tags: readonly Tag[], index: number): Tag | undefined {
  const { name } = tags[index];
  let depth = 0;
  for (const tag of tags.slice(index)) {
    if (tag.name !== name || (!tag.isEnd && tag.isSelfClosing)) continue;
    depth += tag.isEnd ? -1 : 1;
    if (depth === 0) return tag;
  }
  return undefined;
}

/** The innermost element still open at `at`: an end tag closes the latest open element of its name and every one opened after it. */
export function enclosingStart(tags: readonly Tag[], at: number): Tag | undefined {
  let open: Tag[] = [];
  for (const tag of tags) {
    if (tag.start >= at) break;
    if (tag.isEnd) {
      const index = open.map((held) => held.name).lastIndexOf(tag.name);
      if (index !== -1) open = open.slice(0, index);
    } else if (holdsContent(tag)) {
      open = [...open, tag];
    }
  }
  return open.at(-1);
}

/** The start tags no element holds: a part's or a fill's own top-level elements.
 *  ponytail: quadratic; it only runs on parts and fills, which are small, never on a whole screen */
export const topLevelStarts = (tags: readonly Tag[]): Tag[] => tags.filter((tag) => !tag.isEnd && enclosingStart(tags, tag.start) === undefined);
