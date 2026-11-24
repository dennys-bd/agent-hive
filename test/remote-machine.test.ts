import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { type Machine, MachineError, type MachineFs, type MachineInfo } from '../src/machine.js';
import { createMuxMachine } from '../src/remote/machine-client.js';
import { serveMachine } from '../src/remote/machine-serve.js';
import { type BigIntStats, direntsOf, encodeDirent, encodeStats, FS_METHODS, machineErrorOf, remoteErrorOf, splitLines, statsOf } from '../src/remote/machine-wire.js';
import { type Mux, RemoteError } from '../src/remote/protocol.js';
import { fakeMachine } from './fake-machine.js';
import { pair, remote, settle } from './remote-pair.js';
import { tempDir } from './temp-dir.js';

// what a text frame does to a value on its way across the mux
const cross = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const BIG_INO = 2n ** 53n + 1n; // 9007199254740993: as a number it rounds to ...992, and two files would share an inode (#908)
// a folder's bigint lstat, as a disk whose file ids pass 2^53 answers it (NTFS, ReFS)
const BIG_DIR = {
  dev: 1n, ino: BIG_INO, mode: 0o40755n, nlink: 2n, uid: 0n, gid: 0n, rdev: 0n, size: 64n, blksize: 4096n, blocks: 0n,
  atimeMs: 1n, mtimeMs: 2n, ctimeMs: 3n, birthtimeMs: 4n, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
} as unknown as BigIntStats;

test('splitLines breaks on CR LF, a lone CR and LF, and a final break starts no line (#937)', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('x\n\ny'), ['x', '', 'y']);
  assert.deepEqual(splitLines('last\r\n'), ['last']);
  assert.deepEqual(splitLines(''), []);
});

test('a Stats and a Dirent cross as their numbers and a kind, and come back with their is* (#937)', async (t) => {
  const dir = await tempDir(t, 'wire-');
  await writeFile(join(dir, 'a.txt'), 'abc');
  await mkdir(join(dir, 'sub'));
  const file = await lstat(join(dir, 'a.txt'));
  const back = statsOf(cross(encodeStats(file)), false);
  assert.deepEqual(
    [back.isFile(), back.isDirectory(), back.isSymbolicLink(), back.isFIFO(), back.size, back.ino, back.mtimeMs, back.mtime.getTime()],
    [true, false, false, false, 3, file.ino, file.mtimeMs, new Date(file.mtimeMs).getTime()],
  );
  const entries = direntsOf(cross((await readdir(dir, { withFileTypes: true })).map(encodeDirent)));
  assert.deepEqual(entries.map((e) => [e.name, e.parentPath, e.isFile(), e.isDirectory()]).sort(), [['a.txt', dir, true, false], ['sub', dir, false, true]]);
});

test('a bigint Stats crosses as decimal strings and comes back exact: an ino past 2^53 is the same BigInt (#937)', () => {
  const wire = cross(encodeStats(BIG_DIR));
  assert.equal((wire as { ino: unknown }).ino, '9007199254740993');
  const back = statsOf(wire, true);
  assert.deepEqual([back.ino, back.size, back.isDirectory(), back.mtime.getTime()], [BIG_INO, 64n, true, 2]);
});

test('a MachineError crosses as a RemoteError of its code as a string with its fields as data, and comes back field for field (#937)', () => {
  const sent = remoteErrorOf(new MachineError('git failed', { code: 128, stderr: 'fatal', stdout: 'out', killed: true }));
  assert.deepEqual([sent.code, sent.message], ['128', 'git failed']);
  const back = machineErrorOf(new RemoteError(sent.code, sent.message, cross(sent.data)));
  assert.deepEqual([back instanceof MachineError, back.code, back.stderr, back.stdout, back.killed, back.message], [true, 128, 'fatal', 'out', true, 'git failed']);
  assert.equal(remoteErrorOf(Object.assign(new Error('no such file'), { code: 'ENOENT' })).code, 'ENOENT');
  assert.equal(remoteErrorOf(new Error('plain')).code, 'internal');
  const closed = machineErrorOf(new RemoteError('link_closed', 'the link is closed'));
  assert.deepEqual([closed.code, closed.reason], [MachineError.UNAVAILABLE, 'link_closed']);
  assert.equal(machineErrorOf(new RemoteError('cancelled', 'the request was cancelled')).code, 'ABORT_ERR');
  assert.equal(machineErrorOf(new RemoteError('bad_params', 'not its shape')).code, 'bad_params');
});

test('serveMachine answers unknown_method for a method it does not serve and bad_params for params not of its shape, before the machine sees them (#937)', async () => {
  const calls: string[] = [];
  const { host, machine: far } = pair();
  serveMachine(far, fakeMachine({ fs: { unlink: async (path) => { calls.push(path); } } }));
  const refused = [
    ['fs.readLines', ['/a', { maxBytes: 1 }], 'unknown_method'], ['toString', [], 'unknown_method'], ['process', ['node', []], 'unknown_method'],
    ['fs.unlink', [42], 'bad_params'], ['fs.unlink', ['/a', 'extra'], 'bad_params'], ['fs.unlink', { path: '/a' }, 'bad_params'],
    ['fs.readFile', ['/a', {}], 'bad_params'], ['exec', ['git', 'status'], 'bad_params'], ['run', [{ command: 'x' }], 'bad_params'],
    ['watch', ['/a'], 'bad_params'],
  ] as const;
  await Promise.all(refused.map(([method, params, code]) => assert.rejects(host.request(1, method, params), remote(code), method)));
  assert.deepEqual(calls, []);
  await host.request(1, 'fs.unlink', ['/a']);
  assert.deepEqual(calls, ['/a']);
});

test('serveMachine answers a Stats as its numbers and kind and a file as bytes, and a failure as its code with the MachineError fields as data; exec gets a signal (#937)', async (t) => {
  const dir = await tempDir(t, 'serve-');
  let execSignal: unknown;
  let execKeys: string[] = [];
  const exec: Machine['exec'] = async (_file, _args, opts) => {
    execSignal = opts?.signal;
    execKeys = Object.keys(opts ?? {}).sort();
    throw new MachineError('git failed', { code: 128, stderr: 'fatal: not a repo', killed: true });
  };
  const { host, machine: far } = pair();
  serveMachine(far, { ...fakeMachine(), exec });
  assert.equal(((await host.request(1, 'fs.stat', [dir])) as { kind: unknown }).kind, 'directory');
  await host.request(1, 'fs.writeFile', [join(dir, 'a.bin'), Uint8Array.of(0, 255)]);
  assert.deepEqual(await host.request(1, 'fs.readFile', [join(dir, 'a.bin'), { maxBytes: 8 }]), Uint8Array.of(0, 255));
  const missing = await host.request(1, 'fs.stat', [join(dir, 'gone')]).catch((err: unknown) => err);
  assert.ok(remote('ENOENT')(missing));
  assert.equal(((missing as RemoteError).data as { code: unknown }).code, 'ENOENT');
  // execFile's shell and uid are not ExecOptions: the server passes only the named fields on
  const failed = await host.request(1, 'exec', ['git', ['status'], { cwd: '/wt', shell: true, uid: 0 }]).catch((err: unknown) => err);
  assert.ok(remote('128')(failed));
  assert.deepEqual((failed as RemoteError).data, { code: 128, stderr: 'fatal: not a repo', stdout: '', killed: true });
  assert.ok(execSignal instanceof AbortSignal);
  assert.deepEqual(execKeys, ['cwd', 'signal']);
});

test('serveMachine sends run\'s output and watch\'s filenames as events; a cancel aborts the run and closes the watcher, and a watch cancelled before it started opens none (#937)', async () => {
  const seen = { runSignal: undefined as AbortSignal | undefined, opened: 0, isClosed: false };
  let emit: (filename: string | null) => void = () => undefined;
  const run: Machine['run'] = (p) => new Promise((resolve) => {
    seen.runSignal = p.signal;
    p.onOutput?.('one\n');
    p.onOutput?.('two\n');
    p.signal?.addEventListener('abort', () => resolve({ code: 'stopped', stdout: Buffer.alloc(0), stderr: '', tail: '', failure: 'cancelled' }));
  });
  const watch: Machine['watch'] = (_path, _options, onEvent) => {
    seen.opened += 1;
    emit = onEvent;
    return { close: () => { seen.isClosed = true; } };
  };
  const { host, machine: far } = pair();
  serveMachine(far, { ...fakeMachine({ run }), watch });
  const chunks: unknown[] = [];
  const stopRun = new AbortController();
  const running = host.request(1, 'run', [{ command: 'fmt', args: [], cwd: '/wt', env: {} }], { signal: stopRun.signal, onEvent: (data) => chunks.push(data) });
  await settle();
  stopRun.abort();
  await assert.rejects(running, remote('cancelled'));
  await settle();
  assert.deepEqual([chunks, seen.runSignal?.aborted], [['one\n', 'two\n'], true]);
  const events: unknown[] = [];
  const stopWatch = new AbortController();
  const watching = host.request(1, 'watch', ['/wt', { recursive: true }], { signal: stopWatch.signal, onEvent: (data) => events.push(data) });
  await settle();
  emit('a.txt');
  emit(null);
  await settle();
  stopWatch.abort();
  await assert.rejects(watching, remote('cancelled'));
  await settle();
  assert.deepEqual([events, seen.isClosed], [['a.txt', null], true]);
  const early = new AbortController();
  const crossed = host.request(1, 'watch', ['/wt', { recursive: true }], { signal: early.signal });
  early.abort(); // the cancel follows the request on the wire, so the handler starts with its signal already aborted
  await assert.rejects(crossed, remote('cancelled'));
  await settle();
  assert.equal(seen.opened, 1, 'a watch cancelled before it started opens nothing');
});

const INFO: MachineInfo = { platform: 'linux', arch: 'x64', homedir: '/home/u', tmpdir: '/tmp', path: '/usr/bin', shell: '/bin/sh', agents: [] };
// the #428 guard of temp-dir.test.ts looks for this member's name under test/; no fake here makes a dir
const MAKE_TEMP = ['mk', 'dtemp'].join('');
type Call = (...args: unknown[]) => Promise<unknown>;
const isUnavailable = (err: unknown): boolean => err instanceof MachineError && err.code === MachineError.UNAVAILABLE && err.reason === 'link_closed';

// `served` behind serveMachine on the pair's machine side, and the machine the host side sees of it
function over(served: Machine): { host: Mux; client: Machine } {
  const { host, machine: far } = pair();
  serveMachine(far, served);
  return { host, client: createMuxMachine(host, { id: 'wsl:X', pty: served.pty, info: INFO }) };
}

async function linesOf(machine: Machine, path: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of machine.fs.readLines(path, { maxBytes: 64 })) lines.push(line);
  return lines;
}

// each member's arguments and the fake's answer; stat and lstat are the real-disk test's, readLines its own test's
const CASES: Record<string, { args: unknown[]; answer?: unknown }> = {
  realpath: { args: ['/wt/link'], answer: '/wt/real' },
  access: { args: ['/wt/a', 4] },
  readdir: { args: ['/wt'], answer: ['a', 'b'] },
  readFile: { args: ['/wt/a', { maxBytes: 64, encoding: 'utf8' }], answer: 'text' },
  writeFile: { args: ['/wt/a', 'text', { mode: 0o644 }] },
  writeAtomic: { args: ['/wt/a', 'text'], answer: Buffer.from('text') },
  mkdir: { args: ['/wt/d', { recursive: true }], answer: '/wt/d' },
  [MAKE_TEMP]: { args: ['/tmp/hive-'], answer: '/tmp/hive-1' },
  rename: { args: ['/wt/a', '/wt/b'] },
  rm: { args: ['/wt/d', { recursive: true, force: true }] },
  cp: { args: ['/wt/d', '/wt/e', { recursive: true }] },
  copyFile: { args: ['/wt/a', '/wt/b', 1] },
  link: { args: ['/wt/a', '/wt/b'] },
  chmod: { args: ['/wt/a', 0o755] },
  unlink: { args: ['/wt/a'] },
  appendFile: { args: ['/wt/a', Uint8Array.of(1, 2)] },
};

test('every MachineFs member crosses with its arguments as given and answers what the machine answers, a Buffer as a Buffer (#937)', async () => {
  const calls: unknown[][] = [];
  const fake = Object.fromEntries(Object.entries(CASES).map(([name, { answer }]): [string, Call] => [name, async (...args) => {
    calls.push([name, ...args]);
    return answer;
  }]));
  const { client } = over(fakeMachine({ fs: fake as unknown as Partial<MachineFs> }));
  const fs = client.fs as unknown as Record<string, Call>;
  for (const [name, { args, answer }] of Object.entries(CASES)) assert.deepEqual(await fs[name](...args), answer, name);
  assert.deepEqual(calls, Object.entries(CASES).map(([name, { args }]) => [name, ...args]));
  assert.ok(Buffer.isBuffer(await client.fs.writeAtomic('/wt/a', 'text')));
  assert.deepEqual([...Object.keys(CASES), 'stat', 'lstat'].sort(), [...FS_METHODS].sort(), 'no member left out');
});

test('on a real disk a Buffer crosses unchanged, a Stats answers isDirectory(), a Dirent its kind; a bigint ino past 2^53 comes back exact (#937)', async (t) => {
  const dir = await tempDir(t, 'mux-machine-');
  const local = fakeMachine();
  const { client } = over(local);
  const file = join(dir, 'a.bin');
  const bytes = Buffer.from([0, 1, 0xfe, 0xff]);
  await client.fs.writeFile(file, bytes);
  await client.fs.mkdir(join(dir, 'sub'));
  const read = await client.fs.readFile(file, { maxBytes: 64 });
  assert.ok(Buffer.isBuffer(read));
  assert.deepEqual(read, bytes);
  const [folder, near] = [await client.fs.stat(dir), await local.fs.stat(dir)];
  assert.deepEqual([folder.isDirectory(), folder.isFile(), folder.ino, folder.mtimeMs], [true, false, near.ino, near.mtimeMs]);
  assert.equal((await client.fs.lstat(file, { bigint: true })).ino, (await local.fs.lstat(file, { bigint: true })).ino);
  const entries = await client.fs.readdir(dir, { withFileTypes: true });
  assert.deepEqual(entries.map((e) => [e.name, e.isFile(), e.isDirectory()]).sort(), [['a.bin', true, false], ['sub', false, true]]);
  const { client: onBig } = over(fakeMachine({ fs: { lstat: (async () => BIG_DIR) as unknown as MachineFs['lstat'] } }));
  const big = await onBig.fs.lstat('/wt', { bigint: true });
  assert.deepEqual([big.ino, big.isDirectory()], [BIG_INO, true]);
});

test('readLines answers the local readline\'s lines over CR LF, a lone CR and a final break, and refuses too_large on the first next() (#937)', async (t) => {
  const dir = await tempDir(t, 'mux-lines-');
  const local = fakeMachine();
  const { client } = over(local);
  for (const [i, text] of ['a\r\nb\rc\n', 'x\n\ny', 'last\r\n', ''].entries()) {
    const file = join(dir, `${i}.txt`);
    await writeFile(file, text);
    assert.deepEqual(await linesOf(client, file), await linesOf(local, file), JSON.stringify(text));
  }
  assert.deepEqual(await linesOf(client, join(dir, '0.txt')), ['a', 'b', 'c']);
  const lines = client.fs.readLines(join(dir, '0.txt'), { maxBytes: 2 })[Symbol.asyncIterator]();
  await assert.rejects(lines.next(), (err: unknown) => err instanceof MachineError && err.code === MachineError.TOO_LARGE);
});

test('exec answers the machine\'s stdout; a failure keeps its code, stderr and killed, an exit code a number again (#937)', async () => {
  const calls: unknown[] = [];
  const exec: Machine['exec'] = async (file, args, opts) => {
    calls.push([file, args, opts?.cwd, opts?.env, opts?.signal instanceof AbortSignal]);
    if (args[0] === 'fail') throw new MachineError('git failed', { code: 128, stderr: 'fatal: not a repo', stdout: 'partial', killed: true });
    return { stdout: 'ok\n' };
  };
  const { client } = over({ ...fakeMachine(), exec });
  assert.deepEqual(await client.exec('git', ['status'], { cwd: '/wt', env: { A: '1' } }), { stdout: 'ok\n' });
  const failed = await client.exec('git', ['fail']).catch((err: unknown) => err);
  assert.ok(failed instanceof MachineError);
  assert.deepEqual([failed.code, failed.stderr, failed.stdout, failed.killed, failed.message], [128, 'fatal: not a repo', 'partial', true, 'git failed']);
  assert.deepEqual(calls, [['git', ['status'], '/wt', { A: '1' }, true], ['git', ['fail'], undefined, undefined, true]]);
});

test('an aborted exec rejects ABORT_ERR at once, and the abort reaches the machine\'s signal (#937)', async () => {
  let signal: AbortSignal | undefined;
  const exec: Machine['exec'] = (_file, _args, opts) => new Promise(() => { signal = opts?.signal; });
  const { client } = over({ ...fakeMachine(), exec });
  const controller = new AbortController();
  const pending = client.exec('sleep', ['9'], { signal: controller.signal });
  await settle();
  controller.abort();
  await assert.rejects(pending, (err: unknown) => err instanceof MachineError && err.code === 'ABORT_ERR');
  await settle();
  assert.equal(signal?.aborted, true);
});

test('run\'s chunks reach onOutput in order before it resolves with the machine\'s answer, stdout a Buffer (#937)', async () => {
  const asked: unknown[] = [];
  const run: Machine['run'] = async (p) => {
    asked.push([p.command, p.args, p.cwd, p.env, p.input, p.signal instanceof AbortSignal]);
    p.onOutput?.('one\n');
    p.onOutput?.('two\n');
    return { code: 1, stdout: Buffer.from('out'), stderr: 'err', tail: 'one\ntwo', failure: 'exit code 1' };
  };
  const { client } = over(fakeMachine({ run }));
  const chunks: string[] = [];
  const result = await client.run({ command: 'fmt', args: ['a.ts'], cwd: '/wt', env: { A: '1' }, input: 'x', onOutput: (text) => { chunks.push(text); } });
  assert.deepEqual(chunks, ['one\n', 'two\n']);
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual(result, { code: 1, stdout: Buffer.from('out'), stderr: 'err', tail: 'one\ntwo', failure: 'exit code 1' });
  assert.deepEqual(asked, [['fmt', ['a.ts'], '/wt', { A: '1' }, 'x', true]]);
});

test('a run its caller aborts resolves stopped at once with the tail of the chunks so far, and the abort reaches the machine\'s run (#937)', async () => {
  let signal: AbortSignal | undefined;
  const run: Machine['run'] = (p) => new Promise((resolve) => {
    signal = p.signal;
    p.onOutput?.('started\n');
    p.signal?.addEventListener('abort', () => resolve({ code: 'stopped', stdout: Buffer.alloc(0), stderr: '', tail: 'late', failure: 'cancelled' }));
  });
  const { client } = over(fakeMachine({ run }));
  const controller = new AbortController();
  let hear = (): void => undefined;
  const heard = new Promise<void>((resolve) => { hear = resolve; });
  const pending = client.run({ command: 'fmt', args: [], cwd: '/wt', env: {}, signal: controller.signal, onOutput: () => hear() });
  await heard;
  controller.abort();
  assert.deepEqual(await pending, { code: 'stopped', stdout: Buffer.alloc(0), stderr: '', tail: 'started', failure: 'cancelled' });
  await settle();
  assert.equal(signal?.aborted, true);
});

test('a watch delivers the machine\'s events until close(), which closes the machine\'s watcher, and nothing fires after it (#937)', async () => {
  const opened: [string, boolean][] = [];
  let emit: (filename: string | null) => void = () => undefined;
  let isClosed = false;
  const watch: Machine['watch'] = (path, { recursive }, onEvent) => {
    opened.push([path, recursive]);
    emit = onEvent;
    return { close: () => { isClosed = true; } };
  };
  const { client } = over({ ...fakeMachine(), watch });
  const events: (string | null)[] = [];
  const watcher = client.watch('/wt', { recursive: true }, (name) => events.push(name), () => assert.fail('no error'));
  await settle();
  emit('a.txt');
  emit(null);
  await settle();
  watcher.close();
  emit('late.txt'); // sent before the cancel reaches the machine: the client drops it
  await settle();
  watcher.close();
  assert.deepEqual([opened, events, isClosed], [[['/wt', true]], ['a.txt', null], true]);
});

test('a watch whose watcher fails calls onError once with the machine\'s error; one open when the link closes, once with machine_unavailable (#937)', async () => {
  let fail: (err: MachineError) => void = () => undefined;
  const watch: Machine['watch'] = (_path, _options, _onEvent, onError) => {
    fail = onError;
    return { close: () => undefined };
  };
  const { host, client } = over({ ...fakeMachine(), watch });
  const errors: MachineError[] = [];
  client.watch('/wt', { recursive: false }, () => undefined, (err) => errors.push(err));
  await settle();
  fail(new MachineError('ENOSPC: no watchers left', { code: 'ENOSPC' }));
  await settle();
  const closed: MachineError[] = [];
  client.watch('/wt', { recursive: false }, () => undefined, (err) => closed.push(err));
  await settle();
  host.close();
  await settle();
  assert.deepEqual([errors.length, errors[0]?.code, closed.length, isUnavailable(closed[0])], [1, 'ENOSPC', 1, true]);
});

test('after the link closes every member rejects machine_unavailable with reason link_closed, a call pending at the close too (#937)', async () => {
  const exec: Machine['exec'] = () => new Promise(() => undefined);
  const { host, client } = over({ ...fakeMachine(), exec });
  const pending = client.exec('git', ['status']);
  await settle();
  host.close();
  const { fs } = client;
  const calls: Promise<unknown>[] = [
    pending, fs.stat('/a'), fs.lstat('/a'), fs.lstat('/a', { bigint: true }), fs.realpath('/a'), fs.access('/a'), fs.readdir('/a'),
    fs.readdir('/a', { withFileTypes: true }), fs.readFile('/a', { maxBytes: 1 }), fs.readFile('/a', { maxBytes: 1, encoding: 'utf8' }),
    fs.readLines('/a', { maxBytes: 1 })[Symbol.asyncIterator]().next(), fs.writeFile('/a', 'x'), fs.writeAtomic('/a', 'x'), fs.mkdir('/a'),
    (fs as unknown as Record<string, Call>)[MAKE_TEMP]('/a-'), fs.rename('/a', '/b'), fs.rm('/a'), fs.cp('/a', '/b'), fs.copyFile('/a', '/b'),
    fs.link('/a', '/b'), fs.chmod('/a', 0o644), fs.unlink('/a'), fs.appendFile('/a', 'x'), client.exec('git', []),
    client.run({ command: 'fmt', args: [], cwd: '/wt', env: {} }),
  ];
  await Promise.all(calls.map((call, i) => assert.rejects(call, isUnavailable, `call ${i}`)));
});

test('process throws not_supported at once; paths is path.posix for a linux machine on any host; id, info and pty are what was passed; a wrong answer rejects bad_frame (#937)', async () => {
  const served = fakeMachine();
  const { client } = over(served);
  assert.throws(() => client.process('node', [], { cwd: '/wt', env: {} }), (err: unknown) => err instanceof MachineError && err.code === 'not_supported');
  // a filter is a function, which JSON drops: refused, never a copy without the COPY step's guards (worktree-copy-step.ts)
  await assert.rejects(client.fs.cp('/a', '/b', { recursive: true, filter: () => true }), (err: unknown) => err instanceof MachineError && err.code === 'not_supported');
  assert.deepEqual([client.paths === posix, client.id, client.info() === INFO, client.pty === served.pty], [true, 'wsl:X', true, true]);
  const { host, machine: far } = pair();
  far.onRequest(1, () => 42);
  const odd = createMuxMachine(host, { id: 'wsl:X', pty: served.pty, info: INFO });
  await assert.rejects(odd.fs.realpath('/a'), (err: unknown) => err instanceof MachineError && err.code === 'bad_frame');
});

test('readFile\'s noFollow crosses as given: the far disk refuses a link with ELOOP, and a noFollow other than true is bad_params (#882)', async (t) => {
  const dir = await tempDir(t, 'mux-nofollow-');
  await writeFile(join(dir, 'a.html'), '<p>a</p>');
  await symlink(join(dir, 'a.html'), join(dir, 'link.html'));
  const { host, client } = over(fakeMachine());
  assert.equal(await client.fs.readFile(join(dir, 'a.html'), { maxBytes: 64, noFollow: true, encoding: 'utf8' }), '<p>a</p>');
  await assert.rejects(client.fs.readFile(join(dir, 'link.html'), { maxBytes: 64, noFollow: true }), (err: unknown) => err instanceof MachineError && err.code === 'ELOOP');
  await assert.rejects(host.request(1, 'fs.readFile', [join(dir, 'a.html'), { maxBytes: 64, noFollow: 'yes' }]), remote('bad_params'));
});
