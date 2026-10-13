// Claude Design export → a Hive design's raw material (#241), for hive:designer's import mode: the export's props as a draft hv-tweaks block,
// its literal colours, and one static snapshot per value of each prop (the others at their default), so renders grow with the sum of the
// options, not their product. The agent writes the one .hv.html and its data-tweak CSS from them. The export's own runtime renders each
// snapshot in a headless Chrome; no dependency.
import { execFile } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
// The export's runtime (support.js) loads its React and Babel from unpkg, SRI-pinned: every other host is refused (the user's choice, spec "Rendering an export")
const HOST_RULES = 'MAP * ~NOTFOUND, EXCLUDE unpkg.com';
const RENDER_MS = 10_000; // virtual time for the runtime to load and render before the DOM is dumped
const TIMEOUT_MS = 60_000;
const DOM_MAX = 64 * 1024 * 1024;
const TEXT_MAX = 200; // design-tweaks.ts's TWEAK_TEXT_MAX

const DATA_PROPS = /\bdata-props\s*=\s*"([^"]*)"/i;
const FALLBACK = /props\.([A-Za-z_$][\w$]*)\s*\?\?\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)/g;
const ENTITIES = [['&quot;', '"'], ['&#39;', "'"], ['&lt;', '<'], ['&gt;', '>'], ['&amp;', '&']];
const SCRIPT = /<script\b[\s\S]*?<\/script\s*>/gi;
const TAG = /<[a-zA-Z][^>]*>/g;
const ATTRIBUTE = /(\s+)([^\s=>/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const COLOUR = /(?<!&)#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

const decoded = (text) => ENTITIES.reduce((all, [entity, char]) => all.replaceAll(entity, char), text);
const encoded = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const literal = (text) => (text.startsWith("'") || text.startsWith('"') ? text.slice(1, -1) : JSON.parse(text));

// The dc script's data-props, parsed; {} when absent or broken
function declaredOf(html) {
  const match = DATA_PROPS.exec(html);
  if (match === null) return {};
  try {
    const parsed = JSON.parse(decoded(match[1]));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The export's props (#241): data-props' own (not $-prefixed), then the props.<name> ?? <literal> defaults it does not declare, each once. */
export function readProps(html) {
  const declared = Object.entries(declaredOf(html)).filter(([prop]) => !prop.startsWith('$'))
    .map(([prop, meta]) => ({ prop, editor: meta?.editor, options: meta?.options, default: meta?.default }));
  const named = new Set(declared.map((p) => p.prop));
  const used = [...html.matchAll(FALLBACK)].filter(([, prop]) => !named.has(prop))
    .reduce((all, [, prop, value]) => (all.has(prop) ? all : all.set(prop, { prop, default: literal(value) })), new Map());
  return [...declared, ...used.values()];
}

const tweakName = (prop) => {
  const kebab = prop.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return /^[a-z]/.test(kebab) ? kebab : `p-${kebab}`;
};

function defOf({ editor, options, default: value }) {
  if (Array.isArray(options) && options.length > 0 && options.every((o) => typeof o === 'string' && o !== '')) {
    return { options, default: options.includes(value) ? value : options[0] };
  }
  if (editor === 'boolean' || typeof value === 'boolean') return { type: 'boolean', default: value === true };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', default: value };
  return { type: 'text', default: String(value ?? '').slice(0, TEXT_MAX) };
}

/** The draft hv-tweaks block (#241): the agent renames or narrows a tweak where the export says less than the screen means. */
export const draftBlock = (props) => Object.fromEntries(props.map((p) => [tweakName(p.prop), defOf(p)]));

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'empty';
const valuesOf = (p) => {
  const def = defOf(p);
  return def.options ?? (def.type === 'boolean' ? [true, false] : [def.default]);
};

/** The snapshots to render (#241): every default, then one per value of each prop, the others at their default. */
export const snapshotsOf = (props) => [
  { file: 'default.html' },
  ...props.flatMap((p) => valuesOf(p).map((value) => ({ file: `${tweakName(p.prop)}-${slug(value)}.html`, prop: p.prop, value }))),
];

/** The export with `prop`'s default set to `value` in its data-props (#241): what the runtime renders the root with. */
export function withValue(html, prop, value) {
  const declared = declaredOf(html);
  const attribute = `data-props="${encoded(JSON.stringify({ ...declared, [prop]: { ...(declared[prop] ?? {}), default: value } }))}"`;
  return DATA_PROPS.test(html) ? html.replace(DATA_PROPS, () => attribute) : html.replace(/\bdata-dc-script\b/i, () => `data-dc-script ${attribute}`);
}

// ponytail: a regex over tags, so a '>' inside an attribute's value cuts that tag short; a parser if a snapshot ever comes out broken
/** A dumped DOM as static markup (#241): no script, no runtime attribute, no handler. */
export const stripped = (html) => html.replace(SCRIPT, '').replace(TAG, (tag) =>
  tag.replace(ATTRIBUTE, (whole, _space, name) => (/^(?:data-dc|on)/i.test(name) ? '' : whole)));

/** The literal colours, most used first (#241), for the agent to map to tokens. */
export function coloursOf(html) {
  const counts = [...html.matchAll(COLOUR)].map(([c]) => c.toLowerCase()).reduce((all, c) => all.set(c, (all.get(c) ?? 0) + 1), new Map());
  return [...counts].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}\n`).join('');
}

const ON_PATH = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const SYSTEM_CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/opt/google/chrome/chrome'],
};
const PLAYWRIGHT_CACHE = { darwin: 'Library/Caches/ms-playwright', linux: '.cache/ms-playwright' };
const PLAYWRIGHT_BINARIES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
];

async function firstExecutable(paths, isExecutable) {
  for (const path of paths) if (await isExecutable(path)) return path;
  return undefined;
}

async function playwrightBrowsers({ env, platform, home, list }) {
  const root = env.PLAYWRIGHT_BROWSERS_PATH || join(home, PLAYWRIGHT_CACHE[platform] ?? PLAYWRIGHT_CACHE.linux);
  const builds = (await list(root)).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  return builds.flatMap((build) => PLAYWRIGHT_BINARIES.map((binary) => join(root, build, binary)));
}

/** The browser to render with (#241): PATH first, then the system Chrome, then Playwright's newest Chromium; undefined without one. */
export async function findBrowser(deps) {
  const dirs = (deps.env.PATH ?? '').split(delimiter).filter(Boolean);
  const onPath = ON_PATH.flatMap((name) => dirs.map((dir) => join(dir, name)));
  return firstExecutable([...onPath, ...(SYSTEM_CHROME[deps.platform] ?? []), ...(await playwrightBrowsers(deps))], deps.isExecutable);
}

const hostDeps = () => ({
  env: process.env, platform: process.platform, home: homedir(),
  isExecutable: (path) => access(path, constants.X_OK).then(() => true, () => false), list: (dir) => readdir(dir).catch(() => []),
});

// The export is copied with its sibling scripts into a throwaway folder, so the runtime finds support.js and the user's folder stays untouched
async function render(browser, exportPath, html) {
  const tmp = await mkdtemp(join(tmpdir(), 'import-dc-'));
  try {
    const beside = (await readdir(dirname(exportPath))).filter((name) => name.endsWith('.js'));
    await Promise.all(beside.map((name) => copyFile(join(dirname(exportPath), name), join(tmp, name))));
    const page = join(tmp, 'export.dc.html');
    await writeFile(page, html);
    // execFile with an argv array, never a shell; and never --no-sandbox
    const { stdout } = await run(browser, [
      '--headless', '--no-first-run', '--disable-gpu', `--user-data-dir=${join(tmp, 'profile')}`, `--host-resolver-rules=${HOST_RULES}`,
      `--virtual-time-budget=${RENDER_MS}`, '--dump-dom', pathToFileURL(page).href,
    ], { maxBuffer: DOM_MAX, timeout: TIMEOUT_MS });
    return stripped(stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main([exportPath, out]) {
  if (exportPath === undefined || out === undefined) {
    console.error('usage: node import-dc.mjs <export.dc.html> <out-folder>');
    return 1;
  }
  const html = await readFile(exportPath, 'utf8');
  const props = readProps(html);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'tweaks.json'), `${JSON.stringify(draftBlock(props), null, 2)}\n`);
  await writeFile(join(out, 'colours.txt'), coloursOf(html));
  const browser = await findBrowser(hostDeps());
  if (browser === undefined) {
    console.error('no browser: none on PATH (chromium, chromium-browser, google-chrome), no system Chrome, no Playwright Chromium');
    return 2;
  }
  for (const snapshot of snapshotsOf(props)) {
    const file = join(out, snapshot.file);
    await writeFile(file, await render(browser, exportPath, snapshot.prop === undefined ? html : withValue(html, snapshot.prop, snapshot.value)));
    console.log(file);
  }
  return 0;
}

// A script only when run: the test imports the pure parts. realpath, since Node resolves the main module's symlinks
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 2; },
  );
}
