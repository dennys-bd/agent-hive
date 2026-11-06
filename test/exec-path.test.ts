import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDirs } from '../src/agents/command.js';
import { createExec, type ExecRunOptions, findExec, resolveExec } from '../src/exec-path.js';
import { tempDir } from './temp-dir.js';

const WIN32_ONLY = { skip: process.platform !== 'win32' && 'win32 only: runs a real .cmd through cmd.exe (#632)' };

// A Windows file system of the given files, case-insensitive as NTFS is
const fakeFs = (...files: string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (path: string): boolean => set.has(path.toLowerCase());
};
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const env = { Path: 'C:\\Windows\\System32;C:\\Go\\bin;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: COMSPEC };

test('on darwin and linux the name and its arguments come back unchanged, with no file system lookup (#632)', () => {
  const isFile = () => assert.fail('no lookup on POSIX');
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(resolveExec('claude', ['-p', 'a b'], { platform, env: {}, isFile }), { file: 'claude', args: ['-p', 'a b'], windowsVerbatimArguments: false });
  }
});

test('on win32 a folder the caller adds is searched before PATH; an .exe on PATH resolves to it (#632)', () => {
  const isFile = fakeFs('C:\\tools\\agent\\claude.exe', 'C:\\npm\\claude.cmd', 'C:\\Go\\bin\\go.exe');
  const lookup = { platform: 'win32' as const, env, isFile };
  assert.deepEqual(resolveExec('claude', ['-v'], { ...lookup, dirs: ['C:\\tools\\agent'] }), { file: 'C:\\tools\\agent\\claude.exe', args: ['-v'], windowsVerbatimArguments: false });
  assert.deepEqual(resolveExec('go', ['version'], lookup), { file: 'C:\\Go\\bin\\go.exe', args: ['version'], windowsVerbatimArguments: false });
  assert.equal(findExec('go.exe', lookup), 'C:\\Go\\bin\\go.exe', 'a name with its extension is tried as it is');
  assert.equal(findExec('C:\\Go\\bin\\go', lookup), 'C:\\Go\\bin\\go.exe', 'an absolute name gets PATHEXT too');
  assert.equal(findExec('go', { ...lookup, env: { PATH: '"C:\\Go\\bin"' } }), 'C:\\Go\\bin\\go.exe', 'a quoted PATH folder');
  assert.equal(findExec('go', { ...lookup, env: { PATH: 'bin' }, isFile: fakeFs('bin\\go.exe') }), undefined, 'a relative PATH folder is skipped');
  assert.equal(findExec('python3.12', { ...lookup, isFile: fakeFs('C:\\npm\\python3.12', 'C:\\npm\\tool.js') }), undefined, 'an extension that is not runnable');
  assert.equal(findExec('tool', { ...lookup, env: { ...env, PATHEXT: '.JS;.EXE' }, isFile: fakeFs('C:\\npm\\tool.js') }), undefined, 'a PATHEXT entry execFile cannot run');
});

test('on win32 a name present only as .cmd runs through cmd.exe, each argument quoted (#632)', () => {
  const isFile = fakeFs('C:\\npm\\prettier.cmd', 'C:\\npm\\prettier');
  assert.deepEqual(resolveExec('prettier', ['--write', 'a b', 'say "q"', 'dir\\'], { platform: 'win32', env, isFile }), {
    file: COMSPEC,
    args: ['/d', '/s', '/v:off', '/c', '""C:\\npm\\prettier.cmd" "--write" "a b" "say ""q""" "dir\\\\""'],
    windowsVerbatimArguments: true,
  });
});

test('on win32 a missing name is an error that names the tool; a file with no PATHEXT extension is missed (#632)', () => {
  const isFile = fakeFs('C:\\npm\\prettier');
  assert.throws(() => resolveExec('prettier', [], { platform: 'win32', env, isFile }), /prettier/);
  assert.equal(findExec('prettier', { platform: 'win32', env, isFile }), undefined);
  assert.equal(findExec('go', { platform: 'win32', env: { PATH: 'C:\\Go\\bin' }, isFile: fakeFs('C:\\Go\\bin\\go.exe') }), 'C:\\Go\\bin\\go.exe', 'PATHEXT unset falls back to the default');
});

test('on win32 an argument cmd.exe cannot carry safely (%, a line break, NUL) is refused (#632)', () => {
  const lookup = { platform: 'win32' as const, env, isFile: fakeFs('C:\\npm\\prettier.cmd') };
  for (const arg of ['100%', '%PATH%', 'a\nb', 'a\rb', 'a\0b']) {
    assert.throws(() => resolveExec('prettier', [arg], lookup), /cmd\.exe/);
  }
  assert.throws(() => resolveExec('x', [], { ...lookup, dirs: ['C:\\100%'], isFile: fakeFs('C:\\100%\\x.cmd') }), /cmd\.exe/, 'the .cmd\'s own path too');
  assert.throws(() => resolveExec('prettier', ['--token=s3cret%'], lookup), (e: Error) => !e.message.includes('s3cret'), 'the value is never echoed');
  const shell = resolveExec('prettier', [], { ...lookup, env: { ...env, ComSpec: 'C:\\evil\\sh.exe', SystemRoot: 'C:\\Windows' } });
  assert.equal(shell.file, COMSPEC, 'a ComSpec that is not cmd.exe is ignored');
  assert.doesNotThrow(() => resolveExec('go', ['100%'], { ...lookup, isFile: fakeFs('C:\\npm\\go.exe') }), 'an .exe takes any argument');
});

// A fake run that records what execFile would have got
function recorder() {
  const runs: { file: string; args: string[]; opts: ExecRunOptions }[] = [];
  const run = async (file: string, args: string[], opts: ExecRunOptions): Promise<{ stdout: string }> => {
    runs.push({ file, args, opts });
    return { stdout: 'ok' };
  };
  return { runs, run };
}

test('createExec on win32 runs claude from <USERPROFILE>\\.local\\bin, codex.cmd through the .cmd runner verbatim, and gh by its full path (#633)', async () => {
  const { runs, run } = recorder();
  const daemonEnv = { ...env, USERPROFILE: 'C:\\Users\\u' };
  const isFile = fakeFs('C:\\Users\\u\\.local\\bin\\claude.exe', 'C:\\npm\\codex.cmd', 'C:\\npm\\codex', 'C:\\npm\\gh.exe');
  const exec = createExec({ platform: 'win32', env: daemonEnv, dirsFor: (name) => agentDirs(name, 'win32', daemonEnv), run, isFile });
  assert.deepEqual(await exec('claude', ['--version']), { stdout: 'ok' });
  await exec('codex', ['--version']);
  await exec('gh', ['auth', 'token'], { timeout: 10 });
  assert.deepEqual(runs, [
    { file: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: ['--version'], opts: {} },
    { file: COMSPEC, args: ['/d', '/s', '/v:off', '/c', '""C:\\npm\\codex.cmd" "--version""'], opts: { windowsVerbatimArguments: true } },
    { file: 'C:\\npm\\gh.exe', args: ['auth', 'token'], opts: { timeout: 10 } },
  ]);
});

test('createExec looks a name up in the call\'s env when it has one, else the daemon\'s, on every call; a name found nowhere rejects naming it (#633)', async () => {
  const { runs, run } = recorder();
  const files = new Set<string>();
  const exec = createExec({ platform: 'win32', env: { Path: 'C:\\daemon' }, dirsFor: () => [], run, isFile: (file) => files.has(file.toLowerCase()) });
  await assert.rejects(exec('tool', []), { message: 'tool was not found' });
  assert.equal(runs.length, 0, 'nothing ran');
  files.add('c:\\daemon\\tool.exe'); // installed while the Hive runs: never cached
  await exec('tool', []);
  files.add('c:\\child\\tool.exe');
  await exec('tool', ['x'], { env: { Path: 'C:\\child' } });
  assert.deepEqual(runs.map((r) => r.file), ['C:\\daemon\\tool.exe', 'C:\\child\\tool.exe']);
  assert.deepEqual(runs[1]?.opts, { env: { Path: 'C:\\child' } }, 'the caller\'s options pass on unchanged');
  const refused = createExec({ platform: 'win32', env, dirsFor: () => [], run, isFile: fakeFs('C:\\npm\\prettier.cmd') });
  await assert.rejects(refused('prettier', ['100%']), /cmd\.exe/, 'the runner\'s refusal is a rejection too, never a synchronous throw');
});

test('createExec on darwin and linux hands run the name, the args and the options unchanged, with no file lookup (#633)', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { runs, run } = recorder();
    const exec = createExec({ platform, env: {}, dirsFor: (name) => agentDirs(name, platform, {}), run, isFile: () => assert.fail('no lookup off win32') });
    await exec('claude', ['-p', 'a b'], { maxBuffer: 1 });
    assert.deepEqual(runs, [{ file: 'claude', args: ['-p', 'a b'], opts: { maxBuffer: 1 } }], platform);
  }
});

test('on the Windows lane a .cmd gets each argument unchanged, and git answers through the module (#632)', WIN32_ONLY, async (t) => {
  const dir = await tempDir(t, 'exec-path-');
  await writeFile(join(dir, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  await writeFile(join(dir, 'echo-args.cmd'), '@node "%~dp0echo.js" %*\r\n');
  const args = ['a b', '"q"', 'a&b', '^', 'dir\\', '!x!', 'a" & echo pwned'];
  const run = resolveExec('echo-args', args, { platform: 'win32', env: process.env, dirs: [dir] });
  assert.deepEqual(JSON.parse(spawnSync(run.file, run.args, { windowsVerbatimArguments: run.windowsVerbatimArguments, encoding: 'utf8' }).stdout), args);
  const git = resolveExec('git', ['--version'], { platform: 'win32', env: process.env });
  assert.match(spawnSync(git.file, git.args, { windowsVerbatimArguments: git.windowsVerbatimArguments, encoding: 'utf8' }).stdout, /git version/);
});
