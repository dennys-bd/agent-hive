// Throwaway probe for #601: prints what native Windows gives the Hive. Not merged.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const out = (name, value) => console.log(`### ${name}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    return `ERROR ${e.code ?? ''} status=${e.status ?? ''} ${String(e.stderr ?? e.message).trim().slice(0, 600)}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

out('env', {
  platform: process.platform, arch: process.arch, node: process.version, release: os.release(),
  homedir: os.homedir(), HOME: process.env.HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null,
  SHELL: process.env.SHELL ?? null, ComSpec: process.env.ComSpec ?? null, tmpdir: os.tmpdir(),
});

for (const tool of ['git', 'gh', 'bash', 'sh', 'claude', 'pwsh', 'powershell', 'wsl']) out(`where ${tool}`, run('where.exe', [tool]));
out('/bin/sh exists', String(fs.existsSync('/bin/sh')));
out('git --version', run('git', ['--version']));
out('gh --version', run('gh', ['--version']));
out('claude --version (via cmd shim)', run('cmd.exe', ['/d', '/c', 'claude', '--version']));
out('execFile claude without shell', run('claude', ['--version']));

// Paths: what git hands back and what node builds
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-repo-'));
run('git', ['init', '-q', repo]);
run('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' } });
run('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt', path.join(repo, '.hive', 'worktrees', 'wt')]);
out('git worktree list --porcelain', run('git', ['-C', repo, 'worktree', 'list', '--porcelain']));
out('git rev-parse --show-toplevel', run('git', ['-C', repo, 'rev-parse', '--show-toplevel']));
out('path samples', {
  join: path.join(repo, 'a', 'b'), posixJoin: path.posix.join('a', 'b'), sep: path.sep,
  relativeAcrossDrive: path.relative('C:\\a', 'D:\\b'), isAbsSlash: path.isAbsolute('/tmp/x'), resolveSlash: path.resolve('/tmp/x'),
});

// File modes
const secret = path.join(os.tmpdir(), 'probe-secret.json');
fs.writeFileSync(secret, '{}', { mode: 0o600 });
fs.chmodSync(secret, 0o600);
out('stat mode after 0o600', (fs.statSync(secret).mode & 0o777).toString(8));
out('icacls default', run('icacls', [secret]));
out('icacls restrict', run('icacls', [secret, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]));
out('icacls after restrict', run('icacls', [secret]));
fs.mkdirSync(path.join(os.tmpdir(), 'probe-dir'), { mode: 0o700, recursive: true });
out('rename over an existing file', (() => {
  const a = path.join(os.tmpdir(), 'probe-a'); const b = path.join(os.tmpdir(), 'probe-b');
  fs.writeFileSync(a, '1'); fs.writeFileSync(b, '2'); fs.renameSync(a, b); return fs.readFileSync(b, 'utf8');
})());
out('rename over a file held open', (() => {
  const a = path.join(os.tmpdir(), 'probe-c'); const b = path.join(os.tmpdir(), 'probe-d');
  fs.writeFileSync(a, '1'); fs.writeFileSync(b, '2'); const fd = fs.openSync(b, 'r');
  try { fs.renameSync(a, b); return 'ok'; } catch (e) { return `ERROR ${e.code}`; } finally { fs.closeSync(fd); }
})());

// Home lock: a named pipe dies with its process, like flock
const pipe = '\\\\.\\pipe\\agent-hive-probe-lock';
const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(pipe)}, () => console.log('held')); setInterval(() => {}, 1e3)`], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => holder.stdout.once('data', r));
const tryListen = () => new Promise((r) => { const s = net.createServer(); s.once('error', (e) => r(`ERROR ${e.code}`)); s.listen(pipe, () => s.close(() => r('acquired'))); });
out('pipe lock while held', await tryListen());
holder.kill();
await sleep(500);
out('pipe lock after holder killed', await tryListen());
out('fs.open wx twice', (() => {
  const f = path.join(os.tmpdir(), 'probe-lock'); try { fs.unlinkSync(f); } catch {}
  fs.closeSync(fs.openSync(f, 'wx')); try { fs.openSync(f, 'wx'); return 'second open succeeded'; } catch (e) { return `second open: ${e.code}`; }
})());

// Signals
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(0) }); setInterval(() => {}, 1e3)"], { stdio: ['ignore', 'pipe', 'inherit'] });
let childOut = ''; child.stdout.on('data', (d) => { childOut += d; });
await sleep(300); child.kill('SIGTERM');
const [code, signal] = await new Promise((r) => child.once('exit', (c, s) => r([c, s])));
out('SIGTERM to a node child', { handlerRan: childOut.includes('got SIGTERM'), code, signal });
out('process group kill (negative pid)', (() => { try { process.kill(-process.pid, 0); return 'ok'; } catch (e) { return `ERROR ${e.code}`; } })());
out('taskkill exists', run('where.exe', ['taskkill']));

// Pty
try {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const pty = require('node-pty');
  const p = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  let buf = ''; p.onData((d) => { buf += d; });
  await sleep(1500); p.resize(120, 40); p.write('Write-Output "cols=$($Host.UI.RawUI.WindowSize.Width)"; Write-Output ("é" + "✓")\r');
  await sleep(2000);
  out('node-pty powershell', { pid: p.pid, sawCols120: buf.includes('cols=120'), sawUnicode: buf.includes('é✓'), tail: buf.slice(-400) });
  const exit = new Promise((r) => p.onExit(r)); p.kill(); out('node-pty kill', await Promise.race([exit, sleep(5000).then(() => 'timeout')]));
  const b = pty.spawn('bash.exe', ['-l'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  let bb = ''; b.onData((d) => { bb += d; }); await sleep(1500); b.write('echo "sh=$0 $(uname -s)"\r'); await sleep(1500);
  out('node-pty bash.exe', bb.slice(-400)); b.kill();
} catch (e) { out('node-pty', `ERROR ${e.message}`); }

process.exit(0);
