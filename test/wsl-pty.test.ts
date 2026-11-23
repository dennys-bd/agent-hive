import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import { test } from 'node:test';
import { MachineError, type MachineFs, type RunInputs, type RunSpec } from '../src/machine.js';
import { createPtyHost } from '../src/pty-host.js';
import { createWslPty, type WslPtyDeps, withoutConptyTitle } from '../src/wsl/wsl-pty.js';
import { fakeMachine } from './fake-machine.js';
import { fakePtys } from './fakes.js';

// The distro's paths are POSIX strings on purpose: the fake machine is linux and nothing here touches the host's disk
const WSL = ['C:\\Windows\\System32\\wsl.exe'];
const DISTRO = 'Ubuntu';
const DISTRO_HOME = '/home/u';
const ROOT = `${DISTRO_HOME}/.config/agent-hive/wsl`;
const HOME = { root: ROOT, hooksPath: `${ROOT}/hooks.json`, secretFile: `${ROOT}/hive.secret`, commandShims: `${ROOT}/bin` };
const PLUGIN = `${ROOT}/plugins/acme`;
const RELAY = 5151;
const SECRET = 'fake-secret-944';
const LENT = 'fake-lent-944';
const CWD = '/home/u/repo/.hive/worktrees/hive-1-task';
const ENV_FILE = `${ROOT}/command-shims-env/P1.sh`;
const HOST_CWD = 'host-cwd'; // never a path the distro sees
const RUN: RunInputs = { withHive: true, external: [], extraArgs: [], session: { id: 'S1', resume: false } };
const HANDLERS = { onExit: (): void => {}, onError: (): void => {} };

const stats = (dir: boolean): Stats => ({ isDirectory: () => dir, isFile: () => !dir }) as unknown as Stats;

// An in-memory distro disk: the folders that exist, what was written and removed
function distroDisk() {
  const dirs = new Set([CWD]);
  const files = new Map<string, string>();
  const removed: string[] = [];
  const fs: Partial<MachineFs> = {
    stat: async (p) => {
      if (!dirs.has(p)) throw new MachineError(`ENOENT ${p}`, { code: 'ENOENT' });
      return stats(true);
    },
    mkdir: async (p) => { dirs.add(p); return undefined; },
    chmod: async () => undefined,
    writeFile: async (p, data) => { files.set(p, String(data)); },
    rm: async (p) => { removed.push(p); files.delete(p); dirs.delete(p); },
  };
  return { dirs, files, removed, fs };
}

function setup(over: Partial<WslPtyDeps> = {}) {
  const disk = distroDisk();
  const machine = fakeMachine({ fs: disk.fs, info: { platform: 'linux', homedir: DISTRO_HOME, tmpdir: '/tmp', path: '/usr/bin:/bin' } });
  const fake = fakePtys();
  const deps: WslPtyDeps = {
    command: WSL, distro: DISTRO, machine, ptys: createPtyHost(fake.spawnPty), home: HOME, relayPort: RELAY, secret: SECRET,
    pluginDir: async (workspace) => `${ROOT}/plugins/${workspace}`, hostEnv: { HOST_ONLY: 'x' }, hostCwd: HOST_CWD, ...over,
  };
  return { disk, fake, pty: createWslPty(deps) };
}

const agentSpec = (more: Partial<RunSpec> = {}): RunSpec => ({
  ptyId: 'P1', slug: 'hive-1-task', workspace: 'acme', cwd: CWD, env: { A: '1' }, prompt: { text: 'Do it.', name: 'hive-1-task' },
  agent: { id: 'claude', run: RUN }, lent: { GH_TOKEN: LENT }, ...more,
});

const flagValue = (args: string[], flag: string): string | undefined => {
  const line = args.at(-1) ?? '';
  return new RegExp(`${flag} '([^']*)'`).exec(line)?.[1];
};

test('an agent run writes its prompt and MCP config through the distro and starts under wsl.exe with distro paths', async () => {
  const { disk, fake, pty } = setup();
  await pty.spawn(agentSpec(), HANDLERS).started;
  assert.equal(disk.files.get(`${ROOT}/prompts/hive-1-task.md`), 'Do it.');
  assert.ok(disk.files.has(`${ROOT}/prompts/P1.mcp.json`));
  const [spawned] = fake.ptys;
  assert.ok(spawned);
  assert.equal(spawned.file, WSL[0]);
  assert.deepEqual(spawned.args.slice(0, 4), ['-d', DISTRO, '--exec', 'env']);
  assert.equal(spawned.args[4], `PATH=${HOME.commandShims}:/usr/bin:/bin:${DISTRO_HOME}/.local/bin`);
  assert.deepEqual(spawned.args.slice(5, 7), ['sh', '-c']);
  assert.equal(flagValue(spawned.args, '--plugin-dir'), PLUGIN);
  assert.ok(spawned.args.join(' ').includes(HOME.hooksPath));
  assert.ok(!spawned.args.join(' ').includes(HOST_CWD));
  assert.ok(!spawned.args.join(' ').includes('\\'), 'no Windows path in the run');
  assert.equal(spawned.options.cwd, HOST_CWD);
  assert.equal(disk.files.get(ENV_FILE), `PATH='${HOME.commandShims}':$PATH; export PATH\n`);
  assert.equal(spawned.options.env.CLAUDE_ENV_FILE, ENV_FILE);
});

test('the MCP config and HIVE_PORT name the relay port only', async () => {
  const { disk, fake, pty } = setup();
  await pty.spawn(agentSpec(), HANDLERS).started;
  const mcp = disk.files.get(`${ROOT}/prompts/P1.mcp.json`) ?? '';
  assert.ok(mcp.includes(`127.0.0.1:${RELAY}`));
  assert.deepEqual([...mcp.matchAll(/:(\d{2,5})\b/g)].map((m) => m[1]).filter((p) => p !== String(RELAY)), []);
  const env = fake.ptys[0]?.options.env ?? {};
  assert.equal(env.HIVE_PORT, String(RELAY));
  assert.equal(env.HIVE_SECRET_FILE, HOME.secretFile);
  assert.ok(String(env.WSLENV).split(':').includes('HIVE_PORT'));
});

test('lent values ride the env named in WSLENV, never an argv or a written file', async () => {
  const { disk, fake, pty } = setup();
  await pty.spawn(agentSpec(), HANDLERS).started;
  const spawned = fake.ptys[0];
  assert.ok(spawned);
  assert.equal(spawned.options.env.GH_TOKEN, LENT);
  assert.ok(String(spawned.options.env.WSLENV).split(':').includes('GH_TOKEN'));
  assert.ok(!spawned.args.join(' ').includes(LENT));
  assert.ok(![...disk.files.values()].some((text) => text.includes(LENT)));
});

test('a ptyId or prompt name that is not a plain name rejects with bad_name before any write', async () => {
  const { disk, fake, pty } = setup();
  await assert.rejects(pty.spawn(agentSpec({ ptyId: '../P1' }), HANDLERS).started, { code: MachineError.BAD_NAME });
  await assert.rejects(pty.spawn(agentSpec({ prompt: { text: 'x', name: 'a/b' } }), HANDLERS).started, { code: MachineError.BAD_NAME });
  assert.equal(disk.files.size, 0);
  assert.equal(fake.ptys.length, 0);
});

test('a terminal spawns the distro shell in its cwd, with no shims, prompt or env file', async () => {
  const { disk, fake, pty } = setup();
  await pty.spawn({ ptyId: 'T1', slug: 'hive-1-task', workspace: 'acme', cwd: CWD, terminal: true }, HANDLERS).started;
  const spawned = fake.ptys[0];
  assert.ok(spawned);
  assert.equal(spawned.args[4], 'PATH=/usr/bin:/bin');
  const line = spawned.args.at(-1) ?? '';
  assert.ok(line.startsWith(`cd '${CWD}' && `));
  assert.ok(line.includes(`"\${SHELL:-sh}"`));
  assert.equal(spawned.options.env.CLAUDE_ENV_FILE, undefined);
  assert.equal(disk.files.size, 0);
});

test('a cwd that does not exist rejects started and spawns nothing', async () => {
  const { fake, pty } = setup();
  await assert.rejects(pty.spawn({ ptyId: 'T1', slug: 's', workspace: 'acme', cwd: '/nowhere', terminal: true }, HANDLERS).started);
  assert.equal(fake.ptys.length, 0);
});

test('exit removes the run temp folder and env file, reports once, and a kill resolves on it', async () => {
  const { disk, fake, pty } = setup();
  let exits = 0;
  const handle = pty.spawn(agentSpec(), { onExit: () => { exits += 1; }, onError: () => {} });
  await handle.started;
  const tmp = fake.ptys[0]?.options.env.TMPDIR;
  assert.ok(tmp?.startsWith('/tmp/'));
  const killed = handle.kill();
  fake.ptys[0]?.exit(0);
  fake.ptys[0]?.exit(0);
  await killed;
  assert.equal(exits, 1);
  assert.ok(tmp !== undefined && disk.removed.includes(tmp));
  assert.ok(disk.removed.includes(ENV_FILE));
  assert.equal(pty.pid('P1'), undefined);
});

// What subscribers of a pty spawned as `file` receive, over withoutConptyTitle, for the chunks it emits
function received(file: string, chunks: string[]): string {
  const fake = fakePtys();
  const host = createPtyHost(withoutConptyTitle(fake.spawnPty));
  host.spawn('X', [file], HOST_CWD, {});
  const data: string[] = [];
  host.subscribe('X', (d) => data.push(d), () => {});
  for (const chunk of chunks) fake.ptys[0]?.emit(chunk);
  return data.join('');
}

test('the ConPTY title naming wsl.exe never reaches subscribers, even split across chunks', () => {
  assert.equal(received(WSL[0] ?? 'wsl.exe', ['\x1b]0;C:\\WINDOWS\\system32\\wsl.exe\x07hello']), 'hello');
  assert.equal(received('wsl.exe', ['\x1b]0', ';C:\\Windows\\WSL.EXE', '\x1b\\', 'hi']), 'hi');
});

test('another pty title, or a later one, passes through', () => {
  assert.equal(received('/bin/sh', ['\x1b]0;wsl.exe\x07x']), '\x1b]0;wsl.exe\x07x');
  assert.equal(received('wsl.exe', ['\x1b]0;vim\x07x']), '\x1b]0;vim\x07x');
  assert.equal(received('wsl.exe', ['a\x1b]0;wsl.exe\x07']), 'a\x1b]0;wsl.exe\x07');
});
