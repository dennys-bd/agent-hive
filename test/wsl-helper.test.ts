import { before, type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { agentsOnPath } from '../src/agents.js';
import type { MachineInfo } from '../src/machine.js';
import { localFs, localWatch } from '../src/machine-local-fs.js';
import { unavailableMachine } from '../src/machines.js';
import { createMuxMachine } from '../src/remote/machine-client.js';
import { CHANNEL, createMux, type Mux, REMOTE_PROTOCOL_VERSION, RemoteError } from '../src/remote/protocol.js';
import { createStdioDecoder, encodeStdioFrame } from '../src/remote/stdio-frames.js';
import { type HelperHello, helperMachine, isExecutableFile, keepPort, keptPort, RELAY_PORT_FILE, wslVersionOf } from '../src/wsl/helper-main.js';
import { NO_POSIX_FAULTS } from './posix-only.js';
import { tempDir } from './temp-dir.js';

test('wslVersionOf reads osrelease: 2 for WSL2 (with or without the -WSL2 suffix), 1 for WSL1, null for plain Linux and for a read that fails (#941)', () => {
  assert.deepEqual([
    wslVersionOf(() => '5.15.167.4-microsoft-standard-WSL2\n'),
    wslVersionOf(() => '4.19.128-microsoft-standard\n'),
    wslVersionOf(() => '4.4.0-19041-Microsoft\n'),
    wslVersionOf(() => '6.8.0-45-generic\n'),
    wslVersionOf(() => { throw new Error('ENOENT: /proc/sys/kernel/osrelease'); }),
  ], [2, 2, 1, null, null]);
});

test('keptPort answers the port relay-port holds, and undefined for a missing file or anything that is no port (#941)', async (t) => {
  const folder = await tempDir(t, 'wsl-helper-');
  assert.equal(await keptPort(folder), undefined, 'no file');
  for (const text of ['', 'abc', '0', '65536', '12.5', '-1', '80 81']) {
    await writeFile(join(folder, RELAY_PORT_FILE), text);
    assert.equal(await keptPort(folder), undefined, JSON.stringify(text));
  }
  await writeFile(join(folder, RELAY_PORT_FILE), '47999\n');
  assert.equal(await keptPort(folder), 47999);
});

test('keepPort creates the folder, writes the port and a line break, and replaces an older one with no temp file left (#941)', async (t) => {
  const folder = join(await tempDir(t, 'wsl-helper-'), 'hive', 'nested');
  await keepPort(folder, 41000);
  await keepPort(folder, 41001);
  assert.equal(await readFile(join(folder, RELAY_PORT_FILE), 'utf8'), '41001\n');
  assert.deepEqual(await readdir(folder), [RELAY_PORT_FILE]);
});

test('helperMachine is the local disk, a run and the local watch under the id local, with the info it was given; process and pty refuse with not_supported (#941)', () => {
  const info: MachineInfo = { platform: 'linux', arch: 'x64', homedir: '/home/u', tmpdir: '/tmp', path: '/usr/bin', shell: '/bin/sh', agents: [] };
  const machine = helperMachine(info);
  assert.deepEqual(
    [machine.id, machine.fs === localFs, typeof machine.run, machine.watch === localWatch, machine.paths === path.posix, machine.info()],
    ['local', true, 'function', true, true, info],
  );
  const refused = (err: unknown): boolean => err instanceof RemoteError && err.code === 'not_supported';
  assert.throws(() => machine.process(process.execPath, [], { cwd: '/', env: {} }), refused);
  assert.throws(() => machine.pty.has('p1'), refused);
});

test('helperMachine\'s exec lays a call\'s env over the helper\'s own, so a lent GH_TOKEN keeps PATH and HOME; no env runs with the process\'s whole (#945)', async () => {
  const info: MachineInfo = { platform: 'linux', arch: 'x64', homedir: '/home/u', tmpdir: '/tmp', path: '/usr/bin', shell: '/bin/sh', agents: [] };
  const machine = helperMachine(info, { ...process.env, KEPT_945: 'own' });
  const script = 'process.stdout.write([process.env.KEPT_945, process.env.LENT_945].join("|"))';
  assert.equal((await machine.exec(process.execPath, ['-e', script], { env: { LENT_945: 'lent' } })).stdout, 'own|lent');
  assert.equal((await machine.exec(process.execPath, ['-e', script])).stdout, '|');
});

test('helperMachine\'s run lays a call\'s env over the helper\'s own too, so a run with only the lent GH_TOKEN keeps PATH and HOME (#945)', async () => {
  const info: MachineInfo = { platform: 'linux', arch: 'x64', homedir: '/home/u', tmpdir: '/tmp', path: '/usr/bin', shell: '/bin/sh', agents: [] };
  const machine = helperMachine(info, { ...process.env, KEPT_945: 'own' });
  const script = 'process.stdout.write([process.env.KEPT_945, process.env.LENT_945].join("|"))';
  const result = await machine.run({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: { LENT_945: 'lent' } });
  assert.deepEqual([result.code, result.stdout.toString('utf8')], [0, 'own|lent']);
});

test('isExecutableFile, as the helper passes it to agentsOnPath: an executable file in ~/.local/bin is an agent, a directory of that name is not (#941)', async (t) => {
  const home = await tempDir(t, 'wsl-home-');
  const bin = join(home, '.local', 'bin');
  await mkdir(join(bin, 'claude'), { recursive: true });
  await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
  await chmod(join(bin, 'codex'), 0o755);
  const found = agentsOnPath({ path: '', home, isExecutable: isExecutableFile });
  assert.deepEqual(found.filter((a) => a.available).map((a) => a.agent), ['codex']);
  // win32's access(X_OK) only checks that the file exists, so a 0644 file passes there
  await t.test('a file without its execute bit is not an agent', { skip: NO_POSIX_FAULTS }, async () => {
    await chmod(join(bin, 'codex'), 0o644);
    assert.equal(isExecutableFile(join(bin, 'codex')), false);
  });
});

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the repo is two levels up
const HELPER = join(ROOT, 'dist', 'wsl-helper.mjs');

// Built here, not only by pnpm build:tests: the CI lanes run tsc and vite build alone, and a bundle left from an older build would test old code
before(async () => {
  await promisify(execFile)(process.execPath, [join(ROOT, 'scripts', 'build-wsl-helper.mjs')], { cwd: ROOT });
});

interface Helper { host: Mux; hello: Promise<HelperHello>; exited: Promise<number | null>; write(bytes: Uint8Array): void; end(): Promise<number | null> }

// The helper on `args`, with the host's side of its mux over the child's pipes, as #945 drives it. hello rejects if the child exits first
function startHelper(t: TestContext, args: readonly string[], env: NodeJS.ProcessEnv): Helper {
  const child = spawn(process.execPath, [HELPER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  t.after(() => { child.kill(); }); // a test that failed half-way leaves no helper running; a no-op once it has exited
  child.stdin.on('error', () => undefined); // a frame written after the child died: the exit code is what the test reads
  const host = createMux((data) => { child.stdin.write(encodeStdioFrame(data)); }, { side: 'host' });
  const decoder = createStdioDecoder(host.receive, (problem) => { log += `\nthe host's decoder: ${problem}`; });
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk));
  const greeted = new Promise<HelperHello>((resolve) => host.onHello((info) => resolve(info as HelperHello)));
  const died = exited.then((code): never => { throw new Error(`the helper exited with ${code} before its hello:\n${log}`); });
  return {
    host, exited, hello: Promise.race([greeted, died]),
    write: (bytes) => { child.stdin.write(bytes); },
    end: () => { child.stdin.end(); return exited; },
  };
}

// The lane's env with HOME and USERPROFILE at `home`: homedir() reads HOME on POSIX and USERPROFILE on win32. PATH stays the lane's own:
// on win32, infoOf's posixShell finds Git's sh.exe through it
function helperEnv(home: string): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([name]) => !['HOME', 'USERPROFILE'].includes(name.toUpperCase()));
  return { ...Object.fromEntries(kept), HOME: home, USERPROFILE: home };
}

const postHook = (port: number): Promise<number> => new Promise((resolve, reject) => {
  const headers = { host: `127.0.0.1:${port}`, 'x-hive-secret': 's', 'content-type': 'application/json' };
  const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/hooks/event', headers }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode ?? 0));
  });
  req.on('error', reject);
  req.end('{"hook":"Stop"}');
});

test('a helper on a folder says hello, answers fs.readFile and exec, relays a hook to channel 2, and exits with 0 when stdin ends (#941)', async (t) => {
  const home = await tempDir(t, 'wsl-home-');
  await mkdir(join(home, '.local', 'bin'), { recursive: true });
  await writeFile(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n');
  await chmod(join(home, '.local', 'bin', 'claude'), 0o755);
  await writeFile(join(home, 'note.txt'), 'from the distro\'s disk');
  const helper = startHelper(t, [join(home, '.hive')], helperEnv(home));
  const relayed: { method: string; params: unknown }[] = [];
  helper.host.onRequest(CHANNEL.relay, (method, params, ctx) => {
    relayed.push({ method, params });
    ctx.emit({ head: { status: 204, headers: {} } });
  });
  const hello = await helper.hello;
  assert.deepEqual([hello.info.platform, typeof hello.relayPort, hello.info.agents.find((a) => a.agent === 'claude')?.available], [process.platform, 'number', true]);
  const machine = createMuxMachine(helper.host, { id: 'wsl:X', pty: unavailableMachine('wsl:X', 'test').pty, info: hello.info });
  assert.equal(await machine.fs.readFile(join(home, 'note.txt'), { maxBytes: 1024, encoding: 'utf8' }), 'from the distro\'s disk');
  assert.equal((await machine.exec(process.execPath, ['-e', 'process.stdout.write("ran")'])).stdout, 'ran');
  assert.equal(await postHook(hello.relayPort), 204);
  assert.deepEqual(relayed.map(({ method, params }) => [method, (params as { method: string }).method, (params as { path: string }).path]), [['http', 'POST', '/hooks/event']]);
  assert.equal(await helper.end(), 0);
});

test('the hello speaks the mux\'s protocol version: a host of another version is closed with version_mismatch (#941)', async (t) => {
  const home = await tempDir(t, 'wsl-home-');
  const helper = startHelper(t, [join(home, '.hive')], helperEnv(home));
  const closed = new Promise<string | undefined>((resolve) => helper.host.onClose(resolve));
  await helper.hello; // the host's mux checked version === REMOTE_PROTOCOL_VERSION to deliver it
  helper.write(encodeStdioFrame(JSON.stringify({ ch: CHANNEL.control, t: 'hello', version: REMOTE_PROTOCOL_VERSION + 1, info: {} })));
  assert.equal(await closed, 'version_mismatch');
  assert.equal(await helper.exited, 0);
});

test('started again on the same folder the helper keeps its relay port; with that port held it takes another and rewrites relay-port (#941)', async (t) => {
  const home = await tempDir(t, 'wsl-home-');
  const folder = join(home, '.hive'); // missing: the first start creates it
  const first = startHelper(t, [folder], helperEnv(home));
  const { relayPort } = await first.hello;
  assert.equal(await first.end(), 0);
  const second = startHelper(t, [folder], helperEnv(home));
  assert.equal((await second.hello).relayPort, relayPort);
  assert.equal(await second.end(), 0);
  assert.equal(await readFile(join(folder, RELAY_PORT_FILE), 'utf8'), `${relayPort}\n`);
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(relayPort, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));
  const third = startHelper(t, [folder], helperEnv(home));
  const moved = (await third.hello).relayPort;
  assert.notEqual(moved, relayPort);
  assert.equal(await third.end(), 0);
  assert.equal(await readFile(join(folder, RELAY_PORT_FILE), 'utf8'), `${moved}\n`);
});

test('a frame the decoder refuses ends the helper with code 1 (#941)', async (t) => {
  const home = await tempDir(t, 'wsl-home-');
  const helper = startHelper(t, [join(home, '.hive')], helperEnv(home));
  await helper.hello;
  helper.write(Uint8Array.of(0, 0, 0, 1, 9)); // a one-byte frame of kind 9, which no frame has
  assert.equal(await helper.exited, 1);
});

test('with no folder, or a relative one, the helper writes one line to stderr and exits with code 2 (#941)', async () => {
  for (const args of [[], ['relative/folder']]) {
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.deepEqual([code, stderr.trim().split('\n').length], [2, 1], JSON.stringify({ args, stderr }));
  }
});

test('the bundle is one file whose every import, re-export, dynamic import and require names a node: module (#941)', async () => {
  const text = await readFile(HELPER, 'utf8');
  const fromSpecifiers = [...text.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g)].map(([, name]) => name);
  // not after a quote: AGENTS lists "import" as a claude subcommand, and `"import", "install"` is no import
  const bareImports = [...text.matchAll(/(?<!["'`])\bimport\s*["']([^"']+)["']/g)].map(([, name]) => name);
  const calls = [...text.matchAll(/\b(?:import|require)\(\s*([^)]*)\)/g)].map(([, arg]) => arg.trim());
  assert.ok(fromSpecifiers.length > 0, 'the bundle imports node: modules');
  assert.deepEqual([...fromSpecifiers, ...bareImports].filter((name) => !name.startsWith('node:')), []);
  assert.deepEqual(calls.filter((arg) => !/^["']node:/.test(arg)), []);
});
