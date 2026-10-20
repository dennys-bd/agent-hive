// The check of a Hive design folder (#241), as "The check" of reference/design.md runs it: every .hv.html of the folder stays inside it and
// off the network, holds its required tags in order and declares valid tweaks, and no symbolic link sits under the folder. The regex is
// JavaScript's, so no grep dialect (ugrep's) changes what it finds. One finding per line; exit 1 on any.
// The tweak rules copy src/design-tweaks.ts: the plugin is copied out of the repository, so it cannot import it; test/plugin-scripts.test.ts
// keeps the two in step on the same blocks.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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

/** Every finding of `folder` (#241): symbolic links first, then each screen's, by file name. */
export async function checkFolder(folder) {
  const all = await readdir(folder, { recursive: true, withFileTypes: true });
  const links = all.filter((entry) => entry.isSymbolicLink()).map((entry) => `${join(entry.parentPath, entry.name)}: a symbolic link`);
  const present = new Set(all.filter((e) => e.isFile()).map((e) => relative(folder, join(e.parentPath, e.name)).split(sep).join('/')));
  const screens = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.hv.html')).map((e) => e.name).sort();
  if (screens.length === 0) return [...links, `${folder}: no .hv.html screen`];
  const found = await Promise.all(screens.map(async (name) => {
    const text = await readFile(join(folder, name), 'utf8');
    return [...lineFindings(name, text), ...tagFindings(name, text), ...tweakFindings(name, text), ...assetFindings(name, text, present)];
  }));
  return [...links, ...found.flat()];
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

// A script only when run: the test imports parseTweaks and checkFolder. realpath, since Node resolves the main module's symlinks
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 2; },
  );
}
