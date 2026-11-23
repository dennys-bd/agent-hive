import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MachineError } from '../src/machine.js';
import { CWD_WRAPPER, listDistros, wslArgv, wslEnv, wslExec, type WslDeps } from '../src/wsl/wsl-exe.js';
import { tempDir } from './temp-dir.js';

const FAKE = fileURLToPath(new URL('./fake-wsl.js', import.meta.url));
const run = promisify(execFile) as unknown as WslDeps['run'];
const deps = (extra: Partial<WslDeps> = {}): WslDeps => ({ command: [process.execPath, FAKE], run, env: { ...process.env }, ...extra });
const withDistros = (names: string) => deps({ env: { ...process.env, FAKE_WSL_DISTROS: names } });
const utf16 = (s: string) => Buffer.from(s, 'utf16le');
const failsWith = (code: string | number) => (err: unknown) => err instanceof MachineError && err.code === code;

test('wslArgv always passes --exec after -d <distro>, never -- or --cd, and a shell line is sh -c <line> (#939)', () => {
  assert.deepEqual(wslArgv(['wsl.exe'], 'Debian', ['git', 'status']), { file: 'wsl.exe', args: ['-d', 'Debian', '--exec', 'git', 'status'] });
  assert.deepEqual(wslArgv(['node', 'fake.js'], 'D', ['sh', '-c', 'a && b']), { file: 'node', args: ['fake.js', '-d', 'D', '--exec', 'sh', '-c', 'a && b'] });
  const { args } = wslArgv(['wsl.exe'], 'Debian', ['ls'], '/home/u');
  assert.deepEqual(args, ['-d', 'Debian', '--exec', 'sh', '-c', CWD_WRAPPER, 'sh', '/home/u', 'ls']);
  for (const a of [args, wslArgv(['wsl.exe'], 'D', ['x']).args]) assert.ok(!a.includes('--') && !a.includes('--cd'));
});

test('the cwd wrapper line has no backslash: Git for Windows\' sh.exe would collapse it (#939)', () => {
  assert.ok(!CWD_WRAPPER.includes('\\'));
});

test('wslEnv adds the vars and a WSLENV naming them, drops WSL_UTF8 and a host WSLENV, and keeps values out of any argv (#939)', () => {
  const env = wslEnv({ A: 'x y', GH_TOKEN: 't' }, { WSLENV: 'HOSTONLY/p', WSL_UTF8: '1', KEEP: 'k' });
  assert.deepEqual(env, { KEEP: 'k', A: 'x y', GH_TOKEN: 't', WSLENV: 'A:GH_TOKEN' });
  assert.deepEqual(wslEnv({}, { WSLENV: 'X', WSL_UTF8: '1' }), { WSLENV: '' });
});

test('wslEnv refuses PATH and a name that is not an env name, as bad_name (#939)', () => {
  assert.throws(() => wslEnv({ PATH: '/x' }, {}), failsWith(MachineError.BAD_NAME));
  assert.throws(() => wslEnv({ 'A B': '1' }, {}), failsWith(MachineError.BAD_NAME));
  assert.throws(() => wslEnv({ 'A:B': '1' }, {}), failsWith(MachineError.BAD_NAME));
  assert.throws(() => wslEnv({ '1A': '1' }, {}), failsWith(MachineError.BAD_NAME));
});

test('listDistros decodes wsl.exe\'s UTF-16LE with CR LF and NUL into names (#939)', async () => {
  const stdout = utf16('Debian\r\n\0Ubuntu-22.04 \r\n\r\n');
  const names = await listDistros({ command: ['wsl.exe'], run: async () => ({ stdout, stderr: Buffer.alloc(0) }), env: {} });
  assert.deepEqual(names, ['Debian', 'Ubuntu-22.04']);
  assert.deepEqual(await listDistros(withDistros('Debian,Ubuntu')), ['Debian', 'Ubuntu']);
});

test('listDistros answers [] when the command is missing or no distro is installed (#939)', async () => {
  assert.deepEqual(await listDistros(deps({ command: ['/no/such/wsl.exe'] })), []);
  assert.deepEqual(await listDistros(deps()), []);
});

test('wslExec runs the argv in the distro and answers its stdout (#939)', async () => {
  const exec = wslExec(withDistros('Debian'), 'Debian');
  assert.equal((await exec('sh', ['-c', 'printf "%s" "a b"'])).stdout, 'a b');
});

test('wslExec rejects with the exit code, stdout and stderr of a failed command (#939)', async () => {
  const exec = wslExec(withDistros('Debian'), 'Debian');
  await assert.rejects(exec('sh', ['-c', 'echo out; echo err >&2; exit 7']), (err: unknown) => {
    assert.ok(err instanceof MachineError);
    assert.equal(err.code, 7);
    assert.equal(err.stdout.trim(), 'out');
    assert.equal(err.stderr.trim(), 'err');
    return true;
  });
});

test('wslExec reads wsl.exe\'s own failure as UTF-16LE (#939)', async () => {
  const run1: WslDeps['run'] = async () => {
    throw Object.assign(new Error('x'), { code: 4294967295, stdout: utf16('Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'), stderr: Buffer.alloc(0) });
  };
  await assert.rejects(wslExec(deps({ run: run1 }), 'D')('ls', []), (err: unknown) => err instanceof MachineError && err.code === 4294967295 && err.stdout.includes('DISTRO_NOT_FOUND'));
});

test('wslExec rejects a missing command with ENOENT, and an unknown distro with a non-zero code (#939)', async () => {
  await assert.rejects(wslExec(deps({ command: ['/no/such/wsl.exe'] }), 'D')('ls', []), failsWith('ENOENT'));
  await assert.rejects(wslExec(withDistros('Debian'), 'Other')('ls', []), (err: unknown) => err instanceof MachineError && err.code !== 0);
});

test('wslExec runs in the cwd, and a missing folder exits non-zero and runs nothing (#939)', async (t) => {
  const dir = await tempDir(t, 'wsl-');
  const exec = wslExec(withDistros('Debian'), 'Debian');
  assert.equal((await exec('sh', ['-c', 'pwd -P > here.txt'], { cwd: dir })).stdout, '');
  assert.ok((await readFile(join(dir, 'here.txt'), 'utf8')).trim().length > 0);
  const gone = join(dir, 'gone');
  const marker = join(dir, 'marker');
  await assert.rejects(exec('sh', ['-c', 'echo x > "$0"', marker], { cwd: gone }), (err: unknown) => err instanceof MachineError && err.code !== 0);
  await assert.rejects(access(marker));
});

test('wslExec hands an env var to the child only through WSLENV, and a bad name rejects before any run (#939)', async () => {
  const exec = wslExec(withDistros('Debian'), 'Debian');
  const printf = ['-c', 'printf "%s|%s|%s" "$A" "$GH_TOKEN" "$LEAK"'];
  const out = await exec('sh', printf, { env: { A: 'x y', GH_TOKEN: 't' } });
  assert.equal(out.stdout, 'x y|t|');
  const leaky = wslExec({ ...withDistros('Debian'), env: { ...process.env, FAKE_WSL_DISTROS: 'Debian', LEAK: 'host' } }, 'Debian');
  assert.equal((await leaky('sh', printf)).stdout, '||');
  await assert.rejects(exec('sh', printf, { env: { PATH: '/x' } }), failsWith(MachineError.BAD_NAME));
});

test('wslExec refuses input, which an execFile-shaped runner cannot carry (#939)', async () => {
  await assert.rejects(wslExec(withDistros('Debian'), 'Debian')('cat', [], { input: 'x' }), failsWith('not_supported'));
});

test('wslArgv refuses a distro that would read as a flag and an empty cwd (#939)', () => {
  assert.throws(() => wslArgv(['wsl.exe'], '-u', ['ls']), failsWith(MachineError.BAD_NAME));
  assert.throws(() => wslArgv(['wsl.exe'], 'a\\b', ['ls']), failsWith(MachineError.BAD_NAME));
  assert.throws(() => wslArgv(['wsl.exe'], 'D', ['ls'], ''), failsWith(MachineError.BAD_PATH));
});

test('wslEnv refuses WSLENV and WSL_UTF8 as vars, and drops a host Wslenv whatever its case (#939)', () => {
  assert.throws(() => wslEnv({ WSLENV: 'X' }, {}), failsWith(MachineError.BAD_NAME));
  assert.throws(() => wslEnv({ WSL_UTF8: '1' }, {}), failsWith(MachineError.BAD_NAME));
  assert.deepEqual(wslEnv({}, { Wslenv: 'X', wsl_utf8: '1' }), { WSLENV: '' });
});

test('wslExec passes only the limits it was given, so execFile keeps its own maxBuffer (#939)', async () => {
  const seen: object[] = [];
  const run1: WslDeps['run'] = async (_f, _a, opts) => {
    seen.push(opts);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  await wslExec(deps({ run: run1 }), 'D')('ls', []);
  await wslExec(deps({ run: run1 }), 'D')('ls', [], { timeout: 5 });
  assert.ok(!('maxBuffer' in seen[0]!) && !('timeout' in seen[0]!));
  assert.equal((seen[1] as { timeout?: number }).timeout, 5);
});
