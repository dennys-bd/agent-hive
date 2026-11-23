import { createHash } from 'node:crypto';
import { renderHooksSettings } from '../agents/claude-home.js';
import { commandShimSource, renderCommandShim } from '../command-shim.js';
import type { Machine } from '../machine.js';
import type { PluginRender } from '../plugin-render.js';
import type { Language } from '../types.js';

// The Hive's folder inside a WSL distro (#943): hooks, the secret header, the command shims and the plugin copy, all written through the
// distro's own fs, since the host cannot reach it with node:fs. Every call is safe to repeat: a file is written only when its text differs.

export interface DistroHomeOptions { relayPort: number; secretLine: string; shimWords: readonly string[]; language: Language }
export interface DistroHome { root: string; hooksPath: string; secretFile: string; commandShims: string }

const HOME_PARTS = ['.config', 'agent-hive', 'wsl'];
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const SHIM_DIR = 0o755; // BIN_MODE, as the host's command-shims; the 0700 root above it is what keeps other users out
const SHIM_FILE = 0o755;
const SECRET_LINE = /^x-hive-secret: [0-9a-f]{64}$/; // the header line daemon-files writes, which curl reads with -H @file
const TEXT_MAX = 1 << 20;
const PLUGIN_FILE_MAX = 16 << 20;
const MANIFEST = '.hive-manifest.json';
const SHA256 = /^[0-9a-f]{64}$/;
const PORT_MAX = 65_535;

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function readOrUndefined(machine: Machine, path: string): Promise<string | undefined> {
  try {
    return await machine.fs.readFile(path, { maxBytes: TEXT_MAX, encoding: 'utf8' });
  } catch {
    return undefined; // missing, or too big to be ours: either way it counts as different
  }
}

/** Writes `text` only when the file differs. The mode is set first on a file already there, so a drifted mode is repaired even when the text
 * matches, and a new secret never lands under an old, wider mode; again after a write, since writeFile's mode is narrowed by the umask. */
async function putText(machine: Machine, path: string, text: string, mode: number): Promise<void> {
  await machine.fs.chmod(path, mode).catch(() => undefined); // missing: the write below creates it
  if (await readOrUndefined(machine, path) === text) return;
  await machine.fs.writeFile(path, text, { mode });
  await machine.fs.chmod(path, mode);
}

async function ensureDir(machine: Machine, path: string, mode: number): Promise<void> {
  await machine.fs.mkdir(path, { recursive: true, mode });
  await machine.fs.chmod(path, mode);
}

const distroRoot = (distro: Machine): string => distro.paths.join(distro.info().homedir, ...HOME_PARTS);

function checkedWord(word: string): string {
  if (word === '' || word === '.' || word === '..' || word.includes('/')) throw new Error('command shim word is not a plain file name');
  return word;
}

async function syncShims(distro: Machine, host: Machine, dir: string, names: readonly string[], language: Language): Promise<void> {
  await ensureDir(distro, dir, SHIM_DIR);
  const template = await host.fs.readFile(commandShimSource(), { maxBytes: TEXT_MAX, encoding: 'utf8' });
  for (const word of names) await putText(distro, distro.paths.join(dir, word), renderCommandShim(template, word, language, 'linux'), SHIM_FILE);
  const stale = (await distro.fs.readdir(dir)).filter((name) => !names.includes(name));
  await Promise.all(stale.map((name) => distro.fs.rm(distro.paths.join(dir, name), { recursive: true, force: true })));
}

/** Makes the distro's Hive folder match what the host wants there, and answers its paths. */
export async function prepareDistroHome(distro: Machine, host: Machine, opts: DistroHomeOptions): Promise<DistroHome> {
  if (!Number.isInteger(opts.relayPort) || opts.relayPort < 1 || opts.relayPort > PORT_MAX) throw new Error('relay port out of range'); // it is rendered into hooks.json's shell lines
  if (!SECRET_LINE.test(opts.secretLine)) throw new Error('secret line is not an x-hive-secret header'); // never echoed: it is the secret
  opts.shimWords.forEach(checkedWord); // before any write: a refused call leaves the folder as it was
  const { paths } = distro;
  const root = distroRoot(distro);
  const home: DistroHome = { root, hooksPath: paths.join(root, 'hooks.json'), secretFile: paths.join(root, 'hive.secret'), commandShims: paths.join(root, 'bin') };
  await ensureDir(distro, root, PRIVATE_DIR);
  await putText(distro, home.hooksPath, `${JSON.stringify(renderHooksSettings(opts.relayPort), null, 2)}\n`, PRIVATE_FILE);
  await putText(distro, home.secretFile, `${opts.secretLine}\n`, PRIVATE_FILE);
  await syncShims(distro, host, home.commandShims, opts.shimWords, opts.language);
  return home;
}

// Every file of the host's plugin folder as a '/'-separated relative path, but any under a dot entry (.codex, .tmp-*, .old-*): this cut is Claude's
async function hostFiles(host: Machine, dir: string): Promise<string[]> {
  const entries = await host.fs.readdir(dir, { withFileTypes: true, recursive: true });
  const rels = entries.filter((e) => e.isFile()).map((e) => host.paths.relative(dir, host.paths.join(e.parentPath, e.name)).split(host.paths.sep).join('/'));
  return rels.filter((rel) => !rel.split('/').some((seg) => seg.startsWith('.'))).sort();
}

// A manifest key is data from the distro's disk: only a plain relative path under the plugin folder may reach a write or an rm
const isPluginRel = (rel: string): boolean =>
  !rel.includes('\\') && !rel.includes('\0') && rel.split('/').every((seg) => seg !== '' && !seg.startsWith('.')); // as hostFiles: no dot entry, no . or ..

async function readManifest(distro: Machine, path: string): Promise<Map<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readOrUndefined(distro, path) ?? '');
  } catch {
    return new Map(); // missing or unparsable: copy everything
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
  const entries = Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && SHA256.test(e[1]) && isPluginRel(e[0]));
  return new Map(entries);
}

// One copy per distro folder at a time: a Settings save during a launch would otherwise interleave writes and leave a manifest naming
// content that is not on disk, which the next diff would trust
const queues = new WeakMap<Machine, Map<string, Promise<unknown>>>();
function serialised<T>(machine: Machine, key: string, run: () => Promise<T>): Promise<T> {
  const byKey = queues.get(machine) ?? new Map<string, Promise<unknown>>();
  queues.set(machine, byKey);
  const next = (byKey.get(key) ?? Promise.resolve()).then(run, run);
  byKey.set(key, next.catch(() => undefined));
  return next;
}

// tmp + rename: a running agent reading a skill mid-copy sees the old file or the new one, never half
async function putFile(distro: Machine, target: string, data: Buffer): Promise<void> {
  const dir = distro.paths.dirname(target);
  await ensureDir(distro, dir, PRIVATE_DIR);
  const tmp = distro.paths.join(dir, `.${distro.paths.basename(target)}.hive-new`);
  await distro.fs.writeFile(tmp, data);
  // A folder where the file goes (it was a folder on the host before): only then is it removed, so a plain rewrite costs no rm
  await distro.fs.rename(tmp, target).catch(async () => {
    await distro.fs.rm(target, { recursive: true, force: true });
    await distro.fs.rename(tmp, target);
  });
}

async function syncPlugin(distro: Machine, host: Machine, hostDir: string, dest: string): Promise<void> {
  const manifestPath = distro.paths.join(dest, MANIFEST);
  const old = await readManifest(distro, manifestPath);
  const rels = await hostFiles(host, hostDir);
  // Removed files first: a file that became a folder (or the reverse) would otherwise block its own replacement
  const gone = [...old.keys()].filter((rel) => !rels.includes(rel));
  await Promise.all(gone.map((rel) => distro.fs.rm(distro.paths.join(dest, rel), { recursive: true, force: true })));
  const fresh = new Map<string, string>();
  for (const rel of rels) {
    const data = await host.fs.readFile(host.paths.join(hostDir, ...rel.split('/')), { maxBytes: PLUGIN_FILE_MAX });
    fresh.set(rel, sha256(data));
    if (old.get(rel) !== fresh.get(rel)) await putFile(distro, distro.paths.join(dest, rel), data);
  }
  const same = gone.length === 0 && [...fresh].every(([rel, hash]) => old.get(rel) === hash);
  if (same) return;
  await ensureDir(distro, dest, PRIVATE_DIR);
  await distro.fs.writeFile(manifestPath, `${JSON.stringify(Object.fromEntries(fresh), null, 2)}\n`); // last: a copy cut short is redone
}

/** Copies the workspace's rendered plugin into the distro, by hash, and answers the distro folder. */
export async function distroPluginDir(distro: Machine, host: Machine, plugins: Pick<PluginRender, 'dir'>, workspace: string): Promise<string> {
  const name = encodeURIComponent(workspace);
  if (name === '' || name.startsWith('.')) throw new Error('workspace name outside the plugins folder');
  const hostDir = plugins.dir(workspace);
  const dest = distro.paths.join(distroRoot(distro), 'plugins', name);
  await serialised(distro, dest, () => syncPlugin(distro, host, hostDir, dest));
  return dest;
}
