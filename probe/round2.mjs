// Throwaway probe for #601, round 2: claude by full path, .cmd via execFile, pty with a longer window.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const out = (n, v) => console.log(`### ${n}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
const run = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...opts }).trim(); } catch (e) { return `ERROR code=${e.code ?? ''} status=${e.status ?? ''} ${String(e.stdout ?? '').trim().slice(0, 800)} ${String(e.stderr ?? e.message).trim().slice(0, 800)}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const prefix = run('cmd.exe', ['/d', '/c', 'npm', 'prefix', '-g']);
const cmdShim = path.join(prefix, 'claude.cmd');
out('npm prefix -g', prefix);
out('execFile claude.exe by full path', run(exe, ['--version']));
out('execFile claude.cmd by full path, no shell', run(cmdShim, ['--version']));
out('claude.cmd through cmd /d /s /c', run('cmd.exe', ['/d', '/s', '/c', `"${cmdShim}" --version`]));
const noGit = { ...process.env, PATH: process.env.PATH.split(';').filter((p) => !/\\Git\\/i.test(p)).join(';'), ANTHROPIC_API_KEY: 'sk-ant-invalid' };
out('claude.exe -p without Git on PATH (invalid key)', run(exe, ['-p', 'say hi'], { env: noGit }));
out('claude.exe -p with Git on PATH (invalid key)', run(exe, ['-p', 'say hi'], { env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-invalid' } }));
out('git --exec-path', run('git', ['--exec-path']));
try {
  const pty = createRequire(path.join(process.cwd(), 'package.json'))('node-pty');
  for (const file of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']) {
    const isSh = file.endsWith('sh.exe');
    const p = pty.spawn(file, isSh ? ['-i'] : ['-NoLogo', '-NoProfile'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    let buf = ''; p.onData((d) => { buf += d; });
    await sleep(8000); p.resize(132, 40); await sleep(1000);
    p.write(isSh ? 'echo "cols=$(tput cols 2>/dev/null || stty size)" "é✓"\r' : 'Write-Output "cols=$($Host.UI.RawUI.WindowSize.Width) é✓"\r');
    await sleep(5000);
    const exit = new Promise((r) => p.onExit(r)); p.kill();
    out(`pty ${path.basename(file)}`, { sawResize: /cols=1?32|40 132/.test(buf), sawUnicode: buf.includes('é✓'), exit: await Promise.race([exit, sleep(5000).then(() => 'timeout')]), tail: buf.slice(-500) });
  }
} catch (e) { out('pty', `ERROR ${e.message}`); }
process.exit(0);
