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

/** The end tag closing each start tag of `name` that is ever closed, keyed by the start tag, counting the same name nested inside: one pass
 *  with a stack, so an unclosed marker costs nothing more (#421). */
export function matchingEnds(tags: readonly Tag[], name: string): Map<Tag, Tag> {
  const ends = new Map<Tag, Tag>();
  const open: Tag[] = [];
  for (const tag of tags) {
    if (tag.name !== name || (!tag.isEnd && tag.isSelfClosing)) continue;
    if (!tag.isEnd) open.push(tag);
    else {
      const start = open.pop();
      if (start !== undefined) ends.set(start, tag);
    }
  }
  return ends;
}

// One step of the open-element stack: an end tag closes the latest open element of its name and every one opened after it
function step(open: Tag[], tag: Tag): void {
  if (tag.isEnd) {
    let index = open.length - 1;
    while (index >= 0 && open[index].name !== tag.name) index -= 1;
    if (index !== -1) open.length = index;
  } else if (holdsContent(tag)) {
    open.push(tag);
  }
}

/** The innermost element still open at `at`. The stack is local and truncated in place, so a call is linear in the tags before `at` (#421). */
export function enclosingStart(tags: readonly Tag[], at: number): Tag | undefined {
  const open: Tag[] = [];
  for (const tag of tags) {
    if (tag.start >= at) break;
    step(open, tag);
  }
  return open.at(-1);
}

/** The start tags no element holds: a part's or a fill's own top-level elements, found in one pass (#421). */
export function topLevelStarts(tags: readonly Tag[]): Tag[] {
  const open: Tag[] = [];
  const top: Tag[] = [];
  for (const tag of tags) {
    if (!tag.isEnd && open.length === 0) top.push(tag);
    step(open, tag);
  }
  return top;
}
