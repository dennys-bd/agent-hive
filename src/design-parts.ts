// Shared parts of design screens (#421): a screen includes markup fragments of its folder, and the design frame route assembles it before
// serving, so the frame still gets one document and its policy stays as it is. assets/plugin/scripts/check-hv.mjs keeps a copy of these
// rules, since the plugin is copied out of the repository; test/plugin-scripts.test.ts keeps the two in step.
import { readFile, realpath, stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { attrOf, enclosingStart, matchingEnd, scanTags, type Tag, topLevelStarts } from './design-markup.js';

/** How deep includes nest, counted from the screen: a header inside a shell is a real case, and the bound caps the work. */
export const PART_DEPTH_MAX = 4;

/** Why an include renders as its notice: the words the notice and check-hv's finding both carry. */
export const PART_REASONS = {
  noSrc: 'no src',
  notRelative: 'not a relative path',
  parent: 'a .. segment',
  dot: 'a dot segment',
  screen: 'a screen, not a part',
  notHtml: 'not a .html file',
  missing: 'not found',
  symlink: 'a symbolic link',
  cycle: 'a cycle',
  depth: 'deeper than 4 levels', // PART_DEPTH_MAX
  tweaks: 'hv-tweaks belongs to the screen',
} as const;
export type PartReason = (typeof PART_REASONS)[keyof typeof PART_REASONS];

/** A part's text, or why it cannot be read. */
export type PartRead = { text: string } | { refused: PartReason };
/** Reads a part by its path from the design folder, a path the text rules already passed. Injected, so tests run on an in-memory folder. */
export type ReadPart = (path: string) => Promise<PartRead>;
/** The assembled screen, and every part it asked for, a failed one included: the pane reloads when one changes or appears. */
export interface Assembled { html: string; parts: string[] }

const SOURCE = 'data-hv-source';
const FILL = 'data-hv-fill';
const SCREEN_SUFFIX = '.hv.html';
// The design system's status red (theme.css's --destructive): the frame has no Hive tokens
const NOTICE_STYLE = 'display:block;box-sizing:border-box;margin:4px 0;padding:4px 8px;border:1.5px solid #d9534f;border-radius:6px;color:#d9534f;font:12px/1.4 ui-monospace,monospace;background:transparent';

interface Edit { from: number; to: number; insert: string }
interface Marker { tag: Tag; end?: Tag; to: number }
interface At { file: string; depth: number; stack: readonly string[] }
// One assembly's reader and the parts it asked for, filled as includes are met
interface Run { read: ReadPart; parts: Set<string> }

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** A broken include's visible notice, in its place: one bad part never blanks the screen. */
export const partNotice = (reason: PartReason, src: string): string =>
  `<div data-hv-notice style="${NOTICE_STYLE}">hv-include: ${reason}: ${escapeHtml(src)}</div>`;

// From the last, so each edit's offsets still hold; the edits of one pass never overlap
const applyEdits = (text: string, edits: readonly Edit[]): string =>
  [...edits].sort((a, b) => b.from - a.from).reduce((out, { from, to, insert }) => `${out.slice(0, from)}${insert}${out.slice(to)}`, text);

// Right after the tag's name: no wrapper element is added, so a child selector (.shell > .sidebar) still matches
function attrEdit(tag: Tag, name: string, value: string): Edit {
  const at = tag.start + 1 + tag.name.length;
  return { from: at, to: at, insert: ` ${name}="${escapeHtml(value)}"` };
}

// Each top-level element marked with the file it came from, where a nearer one has not marked it already
const withSource = (html: string, file: string): string =>
  applyEdits(html, topLevelStarts(scanTags(html)).filter((tag) => attrOf(tag.attrs, SOURCE) === undefined).map((tag) => attrEdit(tag, SOURCE, file)));

// The file's own markers of `name` with their end tags; one nested inside another belongs to the outer one
function markersOf(tags: readonly Tag[], name: string): Marker[] {
  let covered = 0;
  return tags.flatMap((tag, index) => {
    if (tag.name !== name || tag.isEnd || tag.start < covered) return [];
    const end = tag.isSelfClosing ? undefined : matchingEnd(tags, index);
    covered = end?.end ?? tag.end;
    return [{ tag, end, to: covered }];
  });
}

/** The include's target from the including file's folder, or why it is refused: decided on the text alone, so nothing outside is probed. */
export function partPath(file: string, src: string | undefined): { path: string } | { refused: PartReason } {
  const raw = src?.trim() ?? '';
  if (raw === '') return { refused: PART_REASONS.noSrc };
  if (raw.startsWith('/') || raw.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return { refused: PART_REASONS.notRelative };
  if (raw.split('/').includes('..')) return { refused: PART_REASONS.parent };
  const path = posix.join(posix.dirname(file), raw);
  if (path.split('/').some((segment) => segment.startsWith('.'))) return { refused: PART_REASONS.dot };
  const lower = path.toLowerCase();
  if (lower.endsWith(SCREEN_SUFFIX)) return { refused: PART_REASONS.screen };
  return lower.endsWith('.html') ? { path } : { refused: PART_REASONS.notHtml };
}

/** `screenPath`'s markup with every include in place: slots filled, origins marked, each broken include as its notice. */
export async function assemble(screenPath: string, text: string, read: ReadPart): Promise<Assembled> {
  const run: Run = { read, parts: new Set() };
  const html = await assembleFile(text, new Map(), { file: screenPath, depth: 0, stack: [screenPath] }, run);
  return { html, parts: [...run.parts].sort() };
}

// Slots first, so a slot a part passes down into an include's fill is filled as its own; then the includes
async function assembleFile(text: string, fills: ReadonlyMap<string, string>, at: At, run: Run): Promise<string> {
  const own = at.depth === 0 ? text : withoutTweaks(text, at.file);
  return expandIncludes(fillSlots(own, fills), at, run);
}

// A part declares no tweak: the pane reads one block per screen. The block is dropped and the notice says why
function withoutTweaks(text: string, file: string): string {
  const blocks = markersOf(scanTags(text), 'script').filter(({ tag }) => attrOf(tag.attrs, 'id') === 'hv-tweaks');
  return applyEdits(text, blocks.map(({ tag, to }) => ({ from: tag.start, to, insert: partNotice(PART_REASONS.tweaks, file) })));
}

const hasElement = (markup: string): boolean => scanTags(markup).some((tag) => !tag.isEnd);

// Each slot replaced by its fill, else its default: no hv-slot is left. A fill of text alone has no element to mark, so the element holding
// the slot gets data-hv-fill, once
function fillSlots(text: string, fills: ReadonlyMap<string, string>): string {
  const tags = scanTags(text);
  const holders = new Set<Tag>();
  const edits = markersOf(tags, 'hv-slot').flatMap(({ tag, end, to }) => {
    const name = attrOf(tag.attrs, 'name') ?? '';
    const fill = fills.get(name);
    const slot: Edit = { from: tag.start, to, insert: fill ?? (end === undefined ? '' : text.slice(tag.end, end.start)) };
    const holder = fill === undefined || hasElement(fill) ? undefined : enclosingStart(tags, tag.start);
    if (holder === undefined || holders.has(holder)) return [slot];
    holders.add(holder);
    return [slot, attrEdit(holder, FILL, name)];
  });
  return applyEdits(text, edits);
}

// Every include of the file's own markup in place; one inside another's fill is assembled with that fill
async function expandIncludes(text: string, at: At, run: Run): Promise<string> {
  const edits = await Promise.all(markersOf(scanTags(text), 'hv-include').map(async ({ tag, end, to }) => ({
    from: tag.start, to, insert: await includeOne(attrOf(tag.attrs, 'src'), end === undefined ? '' : text.slice(tag.end, end.start), at, run),
  })));
  return applyEdits(text, edits);
}

// One include: its notice when refused, else the part assembled with the include's fills and marked with its own path
async function includeOne(src: string | undefined, inner: string, at: At, run: Run): Promise<string> {
  const shown = src ?? '';
  const target = partPath(at.file, src);
  if ('refused' in target) return partNotice(target.refused, shown);
  const { path } = target;
  run.parts.add(path);
  if (at.stack.includes(path)) return partNotice(PART_REASONS.cycle, shown);
  if (at.depth >= PART_DEPTH_MAX) return partNotice(PART_REASONS.depth, shown);
  const [read, fills] = await Promise.all([run.read(path), fillsOf(inner, at, run)]);
  if ('refused' in read) return partNotice(read.refused, shown);
  const body = await assembleFile(read.text, fills, { file: path, depth: at.depth + 1, stack: [...at.stack, path] }, run);
  return withSource(body, path);
}

// The include's fills by slot name: its <template data-hv-slot> children, each with its includes resolved from the including file and its
// top-level elements marked with it. Anything else inside the include is ignored
async function fillsOf(inner: string, at: At, run: Run): Promise<Map<string, string>> {
  const tags = scanTags(inner);
  const top = new Set(topLevelStarts(tags));
  const fills = markersOf(tags, 'template').flatMap(({ tag, end }) => {
    const name = attrOf(tag.attrs, 'data-hv-slot');
    return top.has(tag) && end !== undefined && name !== undefined ? [{ name, markup: inner.slice(tag.end, end.start) }] : [];
  });
  const entries = await Promise.all(fills.map(async ({ name, markup }) => [name, withSource(await expandIncludes(markup, at, run), at.file)] as const));
  return new Map(entries);
}

/** The route's reader: a regular file whose realpath is its own path under `folder`, itself a real path, so a symbolic link anywhere on the
 *  way is refused, one to a file inside included, as check-hv refuses every link. */
export function readPartFrom(folder: string): ReadPart {
  return async (path) => {
    const asked = resolve(folder, path);
    const real = await realpath(asked).catch(() => undefined);
    if (real === undefined) return { refused: PART_REASONS.missing };
    if (real !== asked) return { refused: PART_REASONS.symlink };
    const isFile = await stat(real).then((info) => info.isFile(), () => false);
    if (!isFile) return { refused: PART_REASONS.missing };
    return readFile(real, 'utf8').then((text): PartRead => ({ text }), (): PartRead => ({ refused: PART_REASONS.missing }));
  };
}
