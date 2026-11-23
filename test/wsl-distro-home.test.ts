import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandShimSource } from '../src/command-shim.js';
import type { Machine, MachineFs } from '../src/machine.js';
import { distroPluginDir, prepareDistroHome } from '../src/wsl/distro-home.js';
import { fakeMachine } from './fake-machine.js';

// An in-memory disk, '/'-separated, recording what a caller did to it
type Op = { kind: 'write' | 'rm' | 'chmod' | 'mkdir'; path: string; mode?: number };
function memoryDisk(initial: Record<string, string> = {}) {
  const files = new Map<string, { data: Buffer; mode: number }>(Object.entries(initial).map(([p, t]) => [p, { data: Buffer.from(t), mode: 0o644 }]));
  const dirs = new Map<string, number>();
  const ops: Op[] = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  const fs = {
    async mkdir(p: string, o?: { mode?: number | string }) { ops.push({ kind: 'mkdir', path: p, mode: o?.mode as number }); dirs.set(p, Number(o?.mode ?? 0o777)); return undefined; },
    async chmod(p: string, mode: number | string) {
      ops.push({ kind: 'chmod', path: p, mode: Number(mode) });
      const f = files.get(p);
      if (f !== undefined) f.mode = Number(mode); else dirs.set(p, Number(mode));
    },
    async writeFile(p: string, data: string | Uint8Array, o?: { mode?: number | string }) {
      ops.push({ kind: 'write', path: p, mode: o?.mode as number });
      files.set(p, { data: Buffer.from(data), mode: Number(o?.mode ?? 0o666) });
    },
    async readFile(p: string, o: { maxBytes: number; encoding?: BufferEncoding }) {
      const f = files.get(p);
      if (f === undefined) throw enoent(p);
      return o.encoding === undefined ? f.data : f.data.toString(o.encoding);
    },
    async rm(p: string) { ops.push({ kind: 'rm', path: p }); files.delete(p); },
    async rename(from: string, to: string) {
      const f = files.get(from);
      if (f === undefined) throw enoent(from);
      ops.push({ kind: 'write', path: to }); // a rename over a file is its write, as far as a caller sees
      files.delete(from);
      files.set(to, f);
    },
    async readdir(p: string, o?: { withFileTypes: true; recursive?: boolean }) {
      const rel = under(p).map((f) => f.slice(p.length + 1));
      if (o === undefined) return [...new Set(rel.map((r) => r.split('/')[0]))];
      return rel.map((r) => {
        const i = r.lastIndexOf('/');
        return { name: r.slice(i + 1), parentPath: i < 0 ? p : `${p}/${r.slice(0, i)}`, isFile: () => true };
      });
    },
  };
  return { files, dirs, ops, fs: fs as unknown as Partial<MachineFs>, text: (p: string) => files.get(p)?.data.toString() };
}

const HOME = '/home/u/.config/agent-hive/wsl';
const SECRET = `x-hive-secret: ${'ab'.repeat(32)}`;
const TEMPLATE = 'shim __HIVE_COMMAND__ __HIVE_LANGUAGE__ __HIVE_PLATFORM__\n';
const opts = { relayPort: 5151, secretLine: SECRET, shimWords: ['pnpm', 'git'], language: 'en' as const };

function setup(hostFiles: Record<string, string> = {}) {
  const distroDisk = memoryDisk();
  const hostDisk = memoryDisk({ [commandShimSource()]: TEMPLATE, ...hostFiles });
  const distro = fakeMachine({ fs: distroDisk.fs, info: { platform: 'linux', homedir: '/home/u' } });
  const host = fakeMachine({ fs: hostDisk.fs, info: { platform: 'linux', homedir: '/h' } });
  return { distro, host, distroDisk, hostDisk };
}

test('prepareDistroHome writes the hooks, the secret and the shims under the distro home', async () => {
  const { distro, host, distroDisk } = setup();
  const home = await prepareDistroHome(distro, host, opts);
  assert.deepEqual(home, { root: HOME, hooksPath: `${HOME}/hooks.json`, secretFile: `${HOME}/hive.secret`, commandShims: `${HOME}/bin` });
  assert.equal(distroDisk.dirs.get(HOME), 0o700);
  assert.equal(distroDisk.files.get(`${HOME}/hive.secret`)?.mode, 0o600);
  assert.equal(distroDisk.text(`${HOME}/hive.secret`), `${SECRET}\n`);
  const hooks = distroDisk.text(`${HOME}/hooks.json`) ?? '';
  assert.match(hooks, /127\.0\.0\.1:5151/);
  assert.match(hooks, /\$HIVE_SECRET_FILE/);
  assert.equal(distroDisk.dirs.get(`${HOME}/bin`), 0o755);
  assert.equal(distroDisk.text(`${HOME}/bin/pnpm`), "shim 'pnpm' 'en' 'linux'\n");
  assert.equal(distroDisk.files.get(`${HOME}/bin/pnpm`)?.mode, 0o755);
  const paths = distroDisk.ops.map((o) => o.path);
  assert.ok(paths.every((p) => p.startsWith(`${HOME}`) && !p.includes('\\')));
});

test('a second prepareDistroHome with the same content writes nothing', async () => {
  const { distro, host, distroDisk } = setup();
  await prepareDistroHome(distro, host, opts);
  distroDisk.ops.length = 0;
  await prepareDistroHome(distro, host, opts);
  assert.deepEqual(distroDisk.ops.filter((o) => o.kind === 'write' || o.kind === 'rm'), []);
});

test('a changed word set writes the new shim and deletes the stale one', async () => {
  const { distro, host, distroDisk } = setup();
  await prepareDistroHome(distro, host, opts);
  distroDisk.ops.length = 0;
  await prepareDistroHome(distro, host, { ...opts, shimWords: ['pnpm', 'make'] });
  assert.deepEqual(distroDisk.ops.filter((o) => o.kind === 'write').map((o) => o.path), [`${HOME}/bin/make`]);
  assert.deepEqual(distroDisk.ops.filter((o) => o.kind === 'rm').map((o) => o.path), [`${HOME}/bin/git`]);
});

test('prepareDistroHome refuses a bad secret line and a word that is a path', async () => {
  const { distro, host, distroDisk } = setup();
  await assert.rejects(prepareDistroHome(distro, host, { ...opts, secretLine: 'x-hive-secret: nope' }));
  await assert.rejects(prepareDistroHome(distro, host, { ...opts, shimWords: ['a/b'] }));
  await assert.rejects(prepareDistroHome(distro, host, { ...opts, shimWords: ['..'] }));
  assert.equal(distroDisk.files.size, 0);
});

const PLUGIN = '/h/plugins/ws';
const plugins = { dir: () => PLUGIN };
const pluginFiles = { [`${PLUGIN}/plugin.json`]: 'a', [`${PLUGIN}/skills/x/SKILL.md`]: 'b', [`${PLUGIN}/.codex/c.md`]: 'c', [`${PLUGIN}/.tmp-1/d`]: 'd' };
const DEST = `${HOME}/plugins/ws`;

const copy = (distro: Machine, host: Machine) => distroPluginDir(distro, host, plugins, 'ws');
const writes = (d: ReturnType<typeof memoryDisk>) => d.ops.filter((o) => o.kind === 'write' && !o.path.endsWith('.hive-new')).map((o) => o.path).sort();

test('distroPluginDir copies every non-dot file once and answers the distro folder', async () => {
  const { distro, host, distroDisk } = setup(pluginFiles);
  assert.equal(await copy(distro, host), DEST);
  assert.deepEqual(writes(distroDisk), [`${DEST}/.hive-manifest.json`, `${DEST}/plugin.json`, `${DEST}/skills/x/SKILL.md`]);
  assert.equal(distroDisk.dirs.get(`${DEST}/skills/x`), 0o700);
  distroDisk.ops.length = 0;
  await copy(distro, host);
  assert.deepEqual(distroDisk.ops.filter((o) => o.kind === 'write' || o.kind === 'rm'), []);
});

test('distroPluginDir rewrites only a changed file and deletes a removed one', async () => {
  const { distro, host, distroDisk, hostDisk } = setup(pluginFiles);
  await copy(distro, host);
  distroDisk.ops.length = 0;
  hostDisk.files.set(`${PLUGIN}/plugin.json`, { data: Buffer.from('a2'), mode: 0o644 });
  await copy(distro, host);
  assert.deepEqual(writes(distroDisk), [`${DEST}/.hive-manifest.json`, `${DEST}/plugin.json`]);
  distroDisk.ops.length = 0;
  hostDisk.files.delete(`${PLUGIN}/skills/x/SKILL.md`);
  await copy(distro, host);
  assert.deepEqual(distroDisk.ops.filter((o) => o.kind === 'rm').map((o) => o.path), [`${DEST}/skills/x/SKILL.md`]);
  assert.equal(distroDisk.files.has(`${DEST}/skills/x/SKILL.md`), false);
});

test('distroPluginDir treats an unparsable manifest as empty and refuses a dot workspace name', async () => {
  const { distro, host, distroDisk } = setup(pluginFiles);
  distroDisk.files.set(`${DEST}/.hive-manifest.json`, { data: Buffer.from('{nope'), mode: 0o644 });
  await copy(distro, host);
  assert.ok(distroDisk.files.has(`${DEST}/plugin.json`));
  await assert.rejects(distroPluginDir(distro, host, plugins, '.x'));
  await assert.rejects(distroPluginDir(distro, host, plugins, ''));
});

test('prepareDistroHome repairs a drifted mode on a file whose text already matches', async () => {
  const { distro, host, distroDisk } = setup();
  await prepareDistroHome(distro, host, opts);
  const secret = distroDisk.files.get(`${HOME}/hive.secret`);
  assert.ok(secret !== undefined);
  secret.mode = 0o644;
  await prepareDistroHome(distro, host, opts);
  assert.equal(distroDisk.files.get(`${HOME}/hive.secret`)?.mode, 0o600);
});

test('prepareDistroHome refuses a relay port that is not a port', async () => {
  const { distro, host } = setup();
  await assert.rejects(prepareDistroHome(distro, host, { ...opts, relayPort: Number.NaN }));
  await assert.rejects(prepareDistroHome(distro, host, { ...opts, relayPort: 70_000 }));
});

test('distroPluginDir never removes a path a crafted manifest key points outside the plugin folder', async () => {
  const { distro, host, distroDisk } = setup(pluginFiles);
  const hash = 'ab'.repeat(32);
  const manifest = { '../../hive.secret': hash, '..': hash, '': hash, 'a\\b': hash };
  distroDisk.files.set(`${DEST}/.hive-manifest.json`, { data: Buffer.from(JSON.stringify(manifest)), mode: 0o600 });
  await copy(distro, host);
  assert.deepEqual(distroDisk.ops.filter((o) => o.kind === 'rm'), []);
});

test('distroPluginDir replaces a file that became a folder', async () => {
  const { distro, host, distroDisk, hostDisk } = setup(pluginFiles);
  await copy(distro, host);
  hostDisk.files.delete(`${PLUGIN}/plugin.json`);
  hostDisk.files.set(`${PLUGIN}/plugin.json/inner`, { data: Buffer.from('i'), mode: 0o644 });
  await copy(distro, host);
  const ops = distroDisk.ops.map((o) => `${o.kind} ${o.path}`);
  assert.ok(ops.indexOf(`rm ${DEST}/plugin.json`) < ops.indexOf(`mkdir ${DEST}/plugin.json`));
  assert.equal(distroDisk.text(`${DEST}/plugin.json/inner`), 'i');
});

test('distroPluginDir from a win32 host writes /-separated distro paths and manifest keys', async () => {
  const root = 'C:\\h\\plugins\\ws';
  const files = new Map([[`${root}\\plugin.json`, 'a'], [`${root}\\skills\\x\\SKILL.md`, 'b'], [`${root}\\.codex\\c.md`, 'c']]);
  const hostFs = {
    async readdir(p: string) {
      return [...files.keys()].filter((f) => f.startsWith(`${p}\\`)).map((f) => {
        const i = f.lastIndexOf('\\');
        return { name: f.slice(i + 1), parentPath: f.slice(0, i), isFile: () => true };
      });
    },
    async readFile(p: string) {
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.from(text);
    },
  };
  const distroDisk = memoryDisk();
  const distro = fakeMachine({ fs: distroDisk.fs, info: { platform: 'linux', homedir: '/home/u' } });
  const host = fakeMachine({ fs: hostFs as unknown as Partial<MachineFs>, info: { platform: 'win32', homedir: 'C:\\h' } });
  await distroPluginDir(distro, host, { dir: () => root }, 'ws');
  assert.equal(distroDisk.text(`${DEST}/skills/x/SKILL.md`), 'b');
  assert.ok(distroDisk.ops.every((o) => !o.path.includes('\\')));
  assert.deepEqual(Object.keys(JSON.parse(distroDisk.text(`${DEST}/.hive-manifest.json`) ?? '{}')).sort(), ['plugin.json', 'skills/x/SKILL.md']);
});

test('distroPluginDir replaces a folder that became a file', async () => {
  const { distro, host, distroDisk, hostDisk } = setup(pluginFiles);
  await copy(distro, host);
  hostDisk.files.delete(`${PLUGIN}/skills/x/SKILL.md`);
  hostDisk.files.set(`${PLUGIN}/skills/x`, { data: Buffer.from('now a file'), mode: 0o644 });
  distroDisk.dirs.set(`${DEST}/skills/x`, 0o700); // the folder the rm of SKILL.md leaves behind
  const rename = distroDisk.fs.rename;
  let refused = false;
  distroDisk.fs.rename = async (from, to) => {
    if (to === `${DEST}/skills/x` && distroDisk.dirs.has(to) && !refused) { refused = true; throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); }
    return rename?.(from, to);
  };
  const again = fakeMachine({ fs: distroDisk.fs, info: { platform: 'linux', homedir: '/home/u' } }); // fakeMachine copies fs at creation
  await copy(again, host);
  assert.equal(distroDisk.text(`${DEST}/skills/x`), 'now a file');
  assert.ok(distroDisk.ops.some((o) => o.kind === 'rm' && o.path === `${DEST}/skills/x`));
});
