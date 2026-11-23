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
const SHIM_DIR = 0o755; // the shims are on PATH for the distro's other users' tools too, as the host's command-shims are
const SHIM_FILE = 0o755;
const SECRET_LINE = /^x-hive-secret: [0-9a-f]{64}$/; // the header line daemon-files writes, which curl reads with -H @file
const TEXT_MAX = 1 << 20;
const PLUGIN_FILE_MAX = 16 << 20;
const MANIFEST = '.hive-manifest.json';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function readOrUndefined(machine: Machine, path: string): Promise<string | undefined> {
  try {
    return await machine.fs.readFile(path, { maxBytes: TEXT_MAX, encoding: 'utf8' });
  } catch {
    return undefined; // missing, or too big to be ours: either way it counts as different
  }
}

/** Writes `text` only when the file differs; chmod too, since a mode given to writeFile applies only to a new file. */
async function putText(machine: Machine, path: string, text: string, mode: number): Promise<void> {
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

async function readManifest(distro: Machine, path: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readOrUndefined(distro, path) ?? '');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {}; // unparsable: copy everything
  }
}

/** Copies the workspace's rendered plugin into the distro, by hash, and answers the distro folder. The manifest goes last, so a copy cut
 * short is redone the next time. */
export async function distroPluginDir(distro: Machine, host: Machine, plugins: Pick<PluginRender, 'dir'>, workspace: string): Promise<string> {
  const name = encodeURIComponent(workspace);
  if (name === '' || name.startsWith('.')) throw new Error('workspace name outside the plugins folder');
  const hostDir = plugins.dir(workspace);
  const dest = distro.paths.join(distroRoot(distro), 'plugins', name);
  const manifestPath = distro.paths.join(dest, MANIFEST);
  const old = await readManifest(distro, manifestPath);
  const fresh: Record<string, string> = {};
  let changed = false;
  for (const rel of await hostFiles(host, hostDir)) {
    const data = await host.fs.readFile(host.paths.join(hostDir, ...rel.split('/')), { maxBytes: PLUGIN_FILE_MAX });
    fresh[rel] = sha256(data);
    if (old[rel] === fresh[rel]) continue;
    const target = distro.paths.join(dest, rel);
    await ensureDir(distro, distro.paths.dirname(target), PRIVATE_DIR);
    await distro.fs.writeFile(target, data);
    changed = true;
  }
  const gone = Object.keys(old).filter((rel) => !(rel in fresh));
  await Promise.all(gone.map((rel) => distro.fs.rm(distro.paths.join(dest, rel), { force: true })));
  if (changed || gone.length > 0) {
    await ensureDir(distro, dest, PRIVATE_DIR);
    await distro.fs.writeFile(manifestPath, `${JSON.stringify(fresh, null, 2)}\n`);
  }
  return dest;
}
