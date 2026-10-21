// The check of a Hive design folder (#241), as "The check" of reference/design.md runs it: every .hv.html of the folder stays inside it and
// off the network, holds its required tags in order and declares valid tweaks, and no symbolic link sits under the folder. Its parts (#421)
// are held to the same network rules, and every include is followed from each screen as the design frame route assembles it. The regex is
// JavaScript's, so no grep dialect (ugrep's) changes what it finds. One finding per line; exit 1 on any.
// The tweak rules copy src/design-tweaks.ts, and the include rules src/design-parts.ts and src/design-markup.ts: the plugin is copied out of
// the repository, so it cannot import them; test/plugin-scripts.test.ts keeps each copy in step on the same inputs.
import { realpathSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUTSIDE = /(src|srcset|href|action|formaction|poster|data)\s*=\s*["']?\s*(https?:|file:|\/\/|\/)|(url|image-set)\(\s*["']?\s*(https?:|file:|\/\/|\/)|@import\s+["']?\s*(https?:|file:|\/\/|\/)|import\s*\(?\s*["'](https?:|\/\/)|\.\.[/\\]|http-equiv\s*=\s*["']?refresh|sendBeacon|EventSource|window\.open|fetch\s*\(|XMLHttpRequest|WebSocket/i;
const TAGS = ['<!doctype html>', '<html', '<head', '</head>', '<body', '</body>', '</html>'];
const BLOCK = /<script\b[^>]*\bid\s*=\s*["']?hv-tweaks\b[^>]*>([\s\S]*?)<\/script\s*>/gi;

// --- a copy of src/design-tweaks.ts, reasons included ---
const TWEAK_NAME = /^[a-z][a-z0-9-]*$/;
const TWEAKS_MAX = 32;
const TWEAK_TEXT_MAX = 200;
const TWEAK_NAME_MAX = 64;
const TWEAK_OPTIONS_MAX = 64;
const BOUNDS = ['min', 'max', 'step'];
const DECLARED_VIEWPORTS = ['desktop', 'tablet', 'mobile'];
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function fitValue(def, value) {
  if (def.type === 'enum') return typeof value === 'string' && def.options.includes(value) ? value : undefined;
  if (def.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (def.type === 'text') return typeof value === 'string' && value.length <= TWEAK_TEXT_MAX ? value : undefined;
  return isNumber(value) && value >= (def.min ?? Number.NEGATIVE_INFINITY) && value <= (def.max ?? Number.POSITIVE_INFINITY) ? value : undefined;
}

function optionsOf(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((option) => typeof option === 'string' && option !== '')) {
    return 'options must be a non-empty list of non-empty strings';
  }
  if (raw.length > TWEAK_OPTIONS_MAX) return `at most ${TWEAK_OPTIONS_MAX} options`;
  if (raw.some((option) => option.length > TWEAK_TEXT_MAX)) return `an option is at most ${TWEAK_TEXT_MAX} characters`;
  return new Set(raw).size === raw.length ? raw : 'options must be unique';
}

function boundsOf(raw) {
  const present = BOUNDS.filter((key) => raw[key] !== undefined);
  if (!present.every((key) => isNumber(raw[key]))) return 'min, max and step must be numbers';
  const bounds = Object.fromEntries(present.map((key) => [key, raw[key]]));
  if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) return 'min must not be above max';
  return bounds.step !== undefined && bounds.step <= 0 ? 'step must be above 0' : bounds;
}

// A definition's shape, its default checked after: an enum is written without a type
function shapeOf(raw) {
  const { type, group } = raw;
  if (group !== undefined && typeof group !== 'string') return 'group must be a string';
  if (group !== undefined && group.length > TWEAK_TEXT_MAX) return `group is at most ${TWEAK_TEXT_MAX} characters`;
  const grouped = group === undefined ? {} : { group };
  if (type === undefined || type === 'enum') {
    const options = optionsOf(raw.options);
    return typeof options === 'string' ? options : { type: 'enum', options, ...grouped };
  }
  if (type === 'boolean' || type === 'text') return { type, ...grouped };
  if (type !== 'number') return `unknown type ${JSON.stringify(type)}`;
  const bounds = boundsOf(raw);
  return typeof bounds === 'string' ? bounds : { type, ...bounds, ...grouped };
}

function defOf(name, raw) {
  if (!TWEAK_NAME.test(name)) return `"${name}" is not a tweak name: [a-z][a-z0-9-]*`;
  if (name.length > TWEAK_NAME_MAX) return `"${name.slice(0, 16)}…" is longer than ${TWEAK_NAME_MAX} characters`;
  if (!isRecord(raw)) return `${name}: a definition is an object`;
  const shape = shapeOf(raw);
  if (typeof shape === 'string') return `${name}: ${shape}`;
  const value = fitValue(shape, raw.default);
  return value === undefined ? `${name}: the default does not fit` : { name, ...shape, default: value };
}

function viewportsOf(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((item) => typeof item === 'string')) {
    return 'viewports must be a non-empty list of desktop, tablet, mobile';
  }
  const foreign = raw.find((item) => !DECLARED_VIEWPORTS.includes(item));
  if (foreign !== undefined) return `viewports: unknown viewport ${JSON.stringify(foreign)}`;
  return new Set(raw).size === raw.length ? [...raw] : 'viewports must be unique';
}

export function parseTweaks(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the block is an object of name to definition' };
  const { viewports: declared, ...tweaks } = raw;
  const viewports = declared === undefined ? [] : viewportsOf(declared);
  if (typeof viewports === 'string') return { ok: false, reason: viewports };
  const entries = Object.entries(tweaks);
  if (entries.length > TWEAKS_MAX) return { ok: false, reason: `at most ${TWEAKS_MAX} tweaks` };
  const defs = entries.map(([name, def]) => defOf(name, def));
  const reason = defs.find((def) => typeof def === 'string');
  return reason === undefined ? { ok: true, schema: defs, viewports } : { ok: false, reason };
}

// --- a copy of src/design-markup.ts and of src/design-parts.ts's path rules (#421), reasons included ---
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const RAW_TEXT = new Set(['script', 'style']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const PART_DEPTH_MAX = 4;
const PART_REASONS = {
  noSrc: 'no src', notRelative: 'not a relative path', parent: 'a .. segment', dot: 'a dot segment', screen: 'a screen, not a part',
  notHtml: 'not a .html file', missing: 'not found', symlink: 'a symbolic link', cycle: 'a cycle', depth: 'deeper than 4 levels',
  tweaks: 'hv-tweaks belongs to the screen',
};

const holdsContent = (tag) => !tag.isEnd && !tag.isSelfClosing && !VOID.has(tag.name);

function tagOf([whole, slash, name, attrs], start) {
  const isEnd = slash === '/';
  return { name: name.toLowerCase(), start, end: start + whole.length, isEnd, isSelfClosing: !isEnd && attrs.trimEnd().endsWith('/'), attrs };
}

function rawTextEnd(html, tag) {
  const close = new RegExp(`</${tag.name}\\s*>`, 'ig');
  close.lastIndex = tag.end;
  return close.exec(html)?.index ?? html.length;
}

function scanTags(html) {
  const tags = [];
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
      at = html.indexOf('<', at + 1);
      continue;
    }
    const tag = tagOf(match, at);
    tags.push(tag);
    at = html.indexOf('<', !tag.isEnd && RAW_TEXT.has(tag.name) ? rawTextEnd(html, tag) : tag.end);
  }
  return tags;
}

function attrOf(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`/]+))`, 'i').exec(attrs);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
}

function matchingEnd(tags, index) {
  const { name } = tags[index];
  let depth = 0;
  for (const tag of tags.slice(index)) {
    if (tag.name !== name || (!tag.isEnd && tag.isSelfClosing)) continue;
    depth += tag.isEnd ? -1 : 1;
    if (depth === 0) return tag;
  }
  return undefined;
}

function enclosingStart(tags, at) {
  let open = [];
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

const topLevelStarts = (tags) => tags.filter((tag) => !tag.isEnd && enclosingStart(tags, tag.start) === undefined);

export function partPath(file, src) {
  const raw = src?.trim() ?? '';
  if (raw === '') return { refused: PART_REASONS.noSrc };
  if (raw.startsWith('/') || raw.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return { refused: PART_REASONS.notRelative };
  if (raw.split('/').includes('..')) return { refused: PART_REASONS.parent };
  const path = posix.join(posix.dirname(file), raw);
  if (path.split('/').some((segment) => segment.startsWith('.'))) return { refused: PART_REASONS.dot };
  const lower = path.toLowerCase();
  if (lower.endsWith('.hv.html')) return { refused: PART_REASONS.screen };
  return lower.endsWith('.html') ? { path } : { refused: PART_REASONS.notHtml };
}

// --- the check ---
// A script or stylesheet the screen loads by a relative path, as the skeleton's hv-kit.js and hv-tokens.css: missing, the screen still
// renders, without its clicks or its tokens, so nothing else would tell
const LOADED = /<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref)\s*=\s*["']?([^"'\s>]+)/gi;
const assetFindings = (file, text, present) => [...text.matchAll(LOADED)].map((match) => match[1])
  .filter((path) => !/^[a-z][a-z0-9+.-]*:/i.test(path) && !present.has(path))
  .map((path) => `${file}: loads ${path}, which is not in its folder`);

const lineFindings = (file, text) => text.split('\n').flatMap((line, at) =>
  (OUTSIDE.test(line) ? [`${file}:${at + 1}: reaches outside its folder or the network: ${line.trim().slice(0, 160)}`] : []));

function tagFindings(file, text) {
  const lower = text.toLowerCase();
  let from = 0;
  for (const tag of TAGS) {
    const at = lower.indexOf(tag, from);
    if (at === -1) return [`${file}: ${tag} is missing or out of order`];
    from = at + tag.length;
  }
  return [];
}

function tweakFindings(file, text) {
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length === 0) return [];
  if (blocks.length > 1) return [`${file}: more than one hv-tweaks block`];
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch {
    return [`${file}: the hv-tweaks block is not JSON`];
  }
  const parsed = parseTweaks(raw);
  return parsed.ok ? [] : [`${file}: hv-tweaks: ${parsed.reason}`];
}

// --- parts and includes (#421) ---
const PART_DOCUMENT = /<!doctype|<html\b|<head\b|<body\b/i;
const HAND_MARKS = /\bdata-hv-(?:source|fill)\s*=/i;

const markFindings = (file, text) => (HAND_MARKS.test(text) ? [`${file}: data-hv-source and data-hv-fill are written by the Hive, never by hand`] : []);

// A part is a fragment with no tweaks of its own, held to the same network and .. rules as a screen
const partFindings = (file, text) => [
  ...lineFindings(file, text),
  ...(PART_DOCUMENT.test(text) ? [`${file}: a part is a fragment, with no <!doctype, <html, <head or <body`] : []),
  ...([...text.matchAll(BLOCK)].length > 0 ? [`${file}: hv-tweaks belongs to the screen, not a part`] : []),
  ...markFindings(file, text),
];

const slotsOf = (text) => scanTags(text).filter((tag) => tag.name === 'hv-slot' && !tag.isEnd).map((tag) => attrOf(tag.attrs, 'name'));

// Every include of a file, one inside another's fill too (it resolves from the same file), with the slots its fills name
function includesOf(text) {
  const tags = scanTags(text);
  return tags.flatMap((tag, index) => {
    if (tag.name !== 'hv-include' || tag.isEnd) return [];
    const end = tag.isSelfClosing ? undefined : matchingEnd(tags, index);
    const inner = end === undefined ? '' : text.slice(tag.end, end.start);
    const fills = topLevelStarts(scanTags(inner)).filter((t) => t.name === 'template').map((t) => attrOf(t.attrs, 'data-hv-slot')).filter((name) => name !== undefined);
    return [{ src: attrOf(tag.attrs, 'src'), fills }];
  });
}

// As the route reads a part: a regular file whose realpath is its own path, so a symbolic link anywhere on the way is refused
async function readPart(root, path) {
  const asked = join(root, ...path.split('/'));
  const real = await realpath(asked).catch(() => undefined);
  if (real === undefined) return { refused: PART_REASONS.missing };
  if (real !== asked) return { refused: PART_REASONS.symlink };
  return readFile(real, 'utf8').then((text) => ({ text }), () => ({ refused: PART_REASONS.missing }));
}

// One file's includes, followed as the route assembles them: a broken one in its notice's words, on the file whose include it replaces
async function walkIncludes(root, file, text, depth, stack, findings) {
  for (const { src, fills } of includesOf(text)) {
    const say = (reason) => findings.add(`${file}: hv-include: ${reason}: ${src ?? ''}`);
    const target = partPath(file, src);
    if ('refused' in target) { say(target.refused); continue; }
    if (stack.includes(target.path)) { say(PART_REASONS.cycle); continue; }
    if (depth >= PART_DEPTH_MAX) { say(PART_REASONS.depth); continue; }
    const read = await readPart(root, target.path);
    if ('refused' in read) { say(read.refused); continue; }
    const declared = slotsOf(read.text);
    for (const name of fills.filter((fill) => !declared.includes(fill))) say(`fills slot ${name}, which the part does not declare`);
    await walkIncludes(root, target.path, read.text, depth + 1, [...stack, target.path], findings);
  }
}

/** Every finding of `folder` (#241, #421): symbolic links first, then each screen's by file name, each part's by path, then the includes. */
export async function checkFolder(folder) {
  const all = await readdir(folder, { recursive: true, withFileTypes: true });
  const links = all.filter((entry) => entry.isSymbolicLink()).map((entry) => `${join(entry.parentPath, entry.name)}: a symbolic link`);
  const present = new Set(all.filter((e) => e.isFile()).map((e) => relative(folder, join(e.parentPath, e.name)).split(sep).join('/')));
  const screens = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.hv.html')).map((e) => e.name).sort();
  if (screens.length === 0) return [...links, `${folder}: no .hv.html screen`];
  const texts = await Promise.all(screens.map((name) => readFile(join(folder, name), 'utf8')));
  const found = screens.map((name, i) => [
    ...lineFindings(name, texts[i]), ...tagFindings(name, texts[i]), ...tweakFindings(name, texts[i]), ...assetFindings(name, texts[i], present), ...markFindings(name, texts[i]),
  ]);
  const parts = [...present].filter((path) => path.endsWith('.html') && !path.endsWith('.hv.html') && !path.split('/').some((s) => s.startsWith('.'))).sort();
  const ofParts = await Promise.all(parts.map(async (path) => partFindings(path, await readFile(join(folder, path), 'utf8'))));
  const root = await realpath(folder); // the reads compare realpaths: macOS's tmpdir is itself a link
  const includes = new Set();
  for (const [i, name] of screens.entries()) await walkIncludes(root, name, texts[i], 0, [name], includes);
  return [...links, ...found.flat(), ...ofParts.flat(), ...includes];
}

async function main([folder]) {
  if (folder === undefined) {
    console.error('usage: node check-hv.mjs <folder>');
    return 2;
  }
  const findings = await checkFolder(folder);
  for (const finding of findings) console.log(finding);
  return findings.length === 0 ? 0 : 1;
}

// A script only when run: the test imports parseTweaks, partPath and checkFolder. realpath, since Node resolves the main module's symlinks
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 2; },
  );
}
