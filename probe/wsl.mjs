// Throwaway probe for #869 (never merged). Runs on Windows node, outside the distro. `node probe/wsl.mjs [all|net]`.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const mode = process.argv[2] ?? 'all';
const log = (k, v) => console.log(`## ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t) => Number((performance.now() - t).toFixed(1));
const tryLog = async (k, f) => { try { log(k, await f()); } catch (e) { log(k, { error: String(e.message ?? e).slice(0, 400), code: e.code }); } };

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 60000, ...opts });
  return { status: r.status, signal: r.signal, stdout: (r.stdout ?? '').slice(0, 1500), stderr: (r.stderr ?? '').slice(0, 600), error: r.error?.code };
}
const rawList = spawnSync('wsl.exe', ['-l', '-q']).stdout;
const D = process.env.DISTRO ?? rawList.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
const inD = (cmd, opts) => run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', cmd], opts);
const UNC = `\\\\wsl.localhost\\${D}`;

async function section1() {
  log('1.list-raw-hex', rawList.subarray(0, 24).toString('hex'));
  log('1.list-utf8-env', run('wsl.exe', ['-l', '-q'], { env: { ...process.env, WSL_UTF8: '1' } }).stdout);
  log('1.distro', D);
  log('1.version', run('wsl.exe', ['--version']).stdout.replace(/\0/g, ''));
  log('1.wslinfo', inD('wslinfo --networking-mode 2>&1; uname -r; id -un; echo $HOME'));
  inD('rm -rf /root/probe; mkdir -p /root/probe/sub && cd /root/probe && echo hi > a.txt && ln -s a.txt l && ln -s nowhere dangling && echo A > A.TXT && ln -s /etc/hostname abs');
  for (const root of [`\\\\wsl$\\${D}`, UNC]) {
    const dir = `${root}\\root\\probe`;
    await tryLog(`1.readdir ${root}`, () => fs.readdirSync(dir));
    await tryLog(`1.lstat-bigint ${root}`, () => ['a.txt', 'A.TXT', 'l', 'dangling'].map((n) => { const s = fs.lstatSync(`${dir}\\${n}`, { bigint: true }); return { n, dev: String(s.dev), ino: String(s.ino), link: s.isSymbolicLink(), mode: s.mode.toString(8) }; }));
  }
  const dir = `${UNC}\\root\\probe`;
  log('1.distro-inodes', inD('cd /root/probe && stat -c "%n %d %i" a.txt A.TXT l').stdout);
  await tryLog('1.realpath-native(l)', () => fs.realpathSync.native(`${dir}\\l`));
  await tryLog('1.realpath-js(l)', () => fs.realpathSync(`${dir}\\l`));
  await tryLog('1.promises.realpath(l)', () => fs.promises.realpath(`${dir}\\l`));
  await tryLog('1.realpath(abs link to /etc/hostname)', () => fs.promises.realpath(`${dir}\\abs`));
  await tryLog('1.readlink(l)', () => fs.readlinkSync(`${dir}\\l`));
  await tryLog('1.stat(dangling)', () => fs.statSync(`${dir}\\dangling`).size);
  await tryLog('1.write+read', () => { fs.writeFileSync(`${dir}\\w.txt`, 'ação\n'); return fs.readFileSync(`${dir}\\w.txt`, 'utf8'); });
  await tryLog('1.atomic rename over', () => { fs.writeFileSync(`${dir}\\w.tmp`, 'new'); fs.renameSync(`${dir}\\w.tmp`, `${dir}\\w.txt`); return fs.readFileSync(`${dir}\\w.txt`, 'utf8'); });
  await tryLog('1.chmod 755 seen in distro', () => { fs.chmodSync(`${dir}\\w.txt`, 0o755); return inD('stat -c "%a %U" /root/probe/w.txt').stdout; });
  await tryLog('1.new file owner/mode in distro', () => inD('stat -c "%n %a %U" /root/probe/a.txt /root/probe/w.txt').stdout);
  await tryLog('1.hardlink', () => { fs.linkSync(`${dir}\\a.txt`, `${dir}\\hl.txt`); return inD('stat -c "%h" /root/probe/a.txt').stdout; });
  await tryLog('1.symlink from windows', () => { fs.symlinkSync('a.txt', `${dir}\\wl`); return inD('ls -l /root/probe/wl').stdout; });
  await tryLog('1.cp verbatimSymlinks', async () => { await fs.promises.cp(dir, `${UNC}\\root\\probe-cp`, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }); return inD('ls -l /root/probe-cp').stdout; });
  await tryLog('1.mkdtemp', () => fs.mkdtempSync(`${UNC}\\tmp\\hive-`));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'p-'));
  fs.writeFileSync(path.join(local, 'a.txt'), 'hi');
  for (const [k, d] of [['unc', dir], ['local', local]]) {
    let t = performance.now(); for (let i = 0; i < 200; i++) fs.lstatSync(`${d}\\a.txt`); const lstat = ms(t) / 200;
    t = performance.now(); for (let i = 0; i < 100; i++) fs.readFileSync(`${d}\\a.txt`); const read = ms(t) / 100;
    t = performance.now(); for (let i = 0; i < 100; i++) fs.writeFileSync(`${d}\\x${i}.txt`, 'x'); const write = ms(t) / 100;
    log(`1.speed-ms-per-op ${k}`, { lstat, read, write });
  }
  await watchProbe(dir);
  await gitProbe();
}

async function watchProbe(dir) {
  for (const recursive of [false, true]) {
    const events = []; const t0 = performance.now(); let w;
    try { w = fs.watch(dir, { recursive }, (e, f) => events.push({ e, f, at: ms(t0) })); } catch (e) { log(`1.watch recursive=${recursive}`, { error: e.message }); continue; }
    w.on('error', (e) => events.push({ error: e.message }));
    await sleep(500);
    const marks = {};
    marks.winWrite = ms(t0); fs.appendFileSync(`${dir}\\a.txt`, 'w\n'); await sleep(1500);
    marks.distroWrite = ms(t0); inD('echo d >> /root/probe/a.txt'); await sleep(1500);
    marks.distroCreate = ms(t0); inD('echo n > /root/probe/new-$$.txt'); await sleep(1500);
    marks.distroSubdir = ms(t0); inD('echo s > /root/probe/sub/deep-$$.txt'); await sleep(1500);
    marks.distroRename = ms(t0); inD('cd /root/probe && echo r > .tmp-$$ && mv .tmp-$$ renamed-$$.txt'); await sleep(2000);
    w.close();
    log(`1.watch recursive=${recursive}`, { marks, events: events.slice(0, 30), count: events.length });
  }
}

async function gitProbe() {
  log('1.git clone in distro', inD('cd /root && rm -rf repo && git clone -q https://github.com/dennys-bd/agent-hive repo 2>&1 | tail -3; cd repo && git ls-files | wc -l && du -sh .git | cut -f1', { timeout: 300000 }));
  const repoUnc = `${UNC}\\root\\repo`;
  const times = (f, n = 5) => { const out = []; let last; for (let i = 0; i < n; i++) { const t = performance.now(); last = f(); out.push(ms(t)); } return { ms: out, last: { ...last, stdout: last.stdout.slice(0, 200) } }; };
  log('1.git status inside (wsl.exe --exec)', times(() => run('wsl.exe', ['-d', D, '--cd', '/root/repo', '--exec', 'git', 'status', '--porcelain'])));
  log('1.git status inside, self-timed', inD('cd /root/repo && for i in 1 2 3; do s=$(date +%s%N); git status --porcelain >/dev/null; e=$(date +%s%N); echo $(( (e-s)/1000000 ))ms; done'));
  log('1.wsl.exe --exec true roundtrip', times(() => run('wsl.exe', ['-d', D, '--exec', 'true']), 10).ms);
  log('1.git.exe on UNC, no safe.directory', run('git', ['-C', repoUnc, 'status', '--porcelain']));
  log('1.git.exe status on UNC', times(() => run('git', ['-c', 'safe.directory=*', '-C', repoUnc, 'status', '--porcelain'], { timeout: 300000 })));
  log('1.git.exe log -1 on UNC', times(() => run('git', ['-c', 'safe.directory=*', '-C', repoUnc, 'log', '-1', '--format=%h']), 3));
  log('1.git.exe worktree add on UNC', times(() => run('git', ['-c', 'safe.directory=*', '-C', repoUnc, 'worktree', 'add', '-q', '--detach', `${UNC}\\root\\wt-win-${Date.now()}`], { timeout: 300000 }), 1));
  log('1.git worktree add inside', inD('cd /root/repo && s=$(date +%s%N); git worktree add -q --detach /root/wt-in; e=$(date +%s%N); echo $(( (e-s)/1000000 ))ms'));
  const t = performance.now();
  await tryLog('1.readdir recursive repo from windows', () => ({ entries: fs.readdirSync(repoUnc, { recursive: true }).length, ms: ms(t) }));
  log('1.find in distro', inD('cd /root/repo && s=$(date +%s%N); find . | wc -l; e=$(date +%s%N); echo $(( (e-s)/1000000 ))ms'));
}

async function section2() {
  const tricky = ['a b', '"q"', "it's", '$HOME', '`id`', 'ação 🐝', '', 'back\\slash', 'semi;colon', '*', 'new\nline', '%PATH%'];
  log('2.argv --exec', run('wsl.exe', ['-d', D, '--exec', 'printf', '[%s]\\n', ...tricky]));
  log('2.argv -- (shell)', run('wsl.exe', ['-d', D, '--', 'printf', '[%s]\\n', ...tricky]));
  log('2.--cd linux', run('wsl.exe', ['-d', D, '--cd', '/root/probe', '--exec', 'pwd']));
  log('2.--cd windows path', run('wsl.exe', ['-d', D, '--cd', 'C:\\Windows', '--exec', 'pwd']));
  log('2.--cd UNC path', run('wsl.exe', ['-d', D, '--cd', `${UNC}\\root\\probe`, '--exec', 'pwd']));
  log('2.--cd ~', run('wsl.exe', ['-d', D, '--cd', '~', '--exec', 'pwd']));
  log('2.--cd missing', run('wsl.exe', ['-d', D, '--cd', '/nope', '--exec', 'pwd']));
  log('2.cwd only (no --cd), cwd=UNC', run('wsl.exe', ['-d', D, '--exec', 'pwd'], { cwd: `${UNC}\\root\\probe` }));
  log('2.cwd only, cwd=C:', run('wsl.exe', ['-d', D, '--exec', 'pwd'], { cwd: 'C:\\Windows' }));
  log('2.wslpath', inD("wslpath -w /root/probe; wslpath -u 'C:\\Windows'; wslpath -u '\\\\wsl.localhost\\" + D + "\\root'"));
  log('2.exit 7', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'exit 7']).status);
  log('2.exit 255', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'exit 255']).status);
  log('2.killed by SIGKILL', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'kill -9 $$']));
  log('2.command not found', run('wsl.exe', ['-d', D, '--exec', 'no-such-cmd']));
  log('2.bad distro', run('wsl.exe', ['-d', 'NoSuchDistro', '--exec', 'true']));
  const env = { ...process.env, FOO: 'bar baz', WINP: 'C:\\Windows' };
  log('2.env no WSLENV', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'echo "FOO=$FOO WINP=$WINP"'], { env: { ...env, WSLENV: '' } }));
  log('2.env WSLENV=FOO:WINP/p', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'echo "FOO=$FOO WINP=$WINP"'], { env: { ...env, WSLENV: 'FOO:WINP/p' } }));
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`HIVE_V${i}`, `v${i} ação`]));
  log('2.env 40 vars via WSLENV', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'env | grep -c ^HIVE_V; echo $HIVE_V39'], { env: { ...process.env, ...many, WSLENV: Object.keys(many).join(':') } }));
  log('2.env via env(1) argv instead', run('wsl.exe', ['-d', D, '--exec', 'env', 'A=1 2', 'B=ação', 'sh', '-c', 'echo "$A|$B"']));
  log('2.stdin input', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'wc -c'], { input: 'x'.repeat(100000) }));
  log('2.interop PATH', inD('echo $PATH | tr : "\\n" | grep -c /mnt/; for c in gh gh.exe git.exe node.exe claude; do command -v $c || echo "$c: none"; done'));
  await killProbe();
  await pipeProbe();
  await ptyProbe();
}

async function killProbe() {
  const c = spawn('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'sleep 301 & echo $$ $!; wait']);
  const pids = await new Promise((r) => c.stdout.once('data', (d) => r(String(d).trim())));
  c.kill(); await new Promise((r) => c.once('exit', r)); await sleep(1500);
  log('2.kill wsl.exe child (sh pid, grandchild pid)', { pids, after: inD(`for p in ${pids}; do kill -0 $p 2>/dev/null && echo $p alive || echo $p gone; done`).stdout });
  const c2 = spawn('wsl.exe', ['-d', D, '--exec', 'setsid', '-w', 'sh', '-c', 'sleep 302 & echo $$ $!; wait']);
  const p2 = await Promise.race([new Promise((r) => c2.stdout.once('data', (d) => r(String(d).trim()))), sleep(8000).then(() => '0 0')]);
  const [lead] = p2.split(' ');
  log('2.group kill from a second wsl.exe', { p2, kill: inD(`kill -TERM -${lead}; sleep 1; for p in ${p2}; do kill -0 $p 2>/dev/null && echo $p alive || echo $p gone; done`).stdout });
  c2.kill();
}

async function pipeProbe() {
  const c = spawn('wsl.exe', ['-d', D, '--exec', 'cat']);
  let buf = ''; c.stdout.setEncoding('utf8'); c.stdout.on('data', (d) => { buf += d; });
  const rtts = [];
  for (let i = 0; i < 20; i++) { const want = `ping${i}\n`; const t = performance.now(); buf = ''; c.stdin.write(want); while (!buf.includes(want)) await sleep(0); rtts.push(ms(t)); }
  const big = 'y'.repeat(1 << 20); let got = 0; c.stdout.removeAllListeners('data'); c.stdout.on('data', (d) => { got += d.length; });
  const t = performance.now(); for (let i = 0; i < 20; i++) c.stdin.write(big); while (got < 20 * big.length) await sleep(1);
  log('2.stdio pipe (relay carrier)', { rttMs: rtts, mbPerS: Number((20 / (ms(t) / 1000)).toFixed(1)) });
  c.stdin.end();
}

async function ptyProbe() {
  let pty;
  try { pty = createRequire(path.join(process.cwd(), 'ptydeps', 'x.js'))('node-pty'); } catch (e) { log('2.pty', { error: e.message }); return; }
  const p = pty.spawn('wsl.exe', ['-d', D, '--cd', '/root', '--exec', 'bash', '--noprofile', '--norc', '-i'], { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color', WSLENV: 'TERM' } });
  let out = ''; p.onData((d) => { out += d; });
  const exit = new Promise((r) => p.onExit(r));
  await sleep(2500);
  p.write("trap 'echo WINCH $(stty size)' WINCH; echo TERM=$TERM; stty size; echo ação 🐝 ✓; printf '\\e[31mred\\e[0m\\n'\r"); await sleep(1500);
  p.resize(132, 40); await sleep(1500);
  p.write('stty size\r'); await sleep(1000);
  p.write('sleep 1; exit 5\r');
  const e = await Promise.race([exit, sleep(8000).then(() => 'timeout')]);
  log('2.pty transcript', out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-900));
  log('2.pty raw has red SGR', out.includes('\x1b[31m'));
  log('2.pty exit', e);
  const q = pty.spawn('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'echo $$; exec sleep 303'], { cols: 80, rows: 24 });
  q.onData(() => {}); await sleep(2500);
  const ex2 = new Promise((r) => q.onExit(r)); q.kill(); const e2 = await Promise.race([ex2, sleep(5000).then(() => 'timeout')]); await sleep(1000);
  log('2.pty kill', { exit: e2, linux: inD('pgrep -af "sleep 303" || echo none').stdout });
}

// async spawns only: a spawnSync would block the loop and the servers could not answer
function runAsync(file, args) {
  return new Promise((r) => { const c = spawn(file, args); let o = '', e = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; }); c.on('exit', (status) => r({ status, stdout: o.slice(0, 300), stderr: e.slice(0, 300) })); });
}
async function section3() {
  const handler = (req, res) => res.end(`ok host=${req.headers.host} from=${req.socket.remoteAddress}`);
  const s1 = http.createServer(handler); await new Promise((r) => s1.listen(0, '127.0.0.1', r));
  const s2 = http.createServer(handler); await new Promise((r) => s2.listen(0, '0.0.0.0', r));
  const p1 = s1.address().port; const p2 = s2.address().port;
  log('3.mode', (await runAsync('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'wslinfo --networking-mode 2>&1; ip -4 route show default; grep nameserver /etc/resolv.conf'])).stdout);
  const gw = (await runAsync('wsl.exe', ['-d', D, '--exec', 'sh', '-c', "ip -4 route show default | awk '{print $3}'"])).stdout.trim();
  for (const [k, u] of [['127.0.0.1 -> 127-bound', `http://127.0.0.1:${p1}/`], ['localhost -> 127-bound', `http://localhost:${p1}/`],
    ['gateway -> 127-bound', `http://${gw}:${p1}/`], ['gateway -> 0.0.0.0-bound', `http://${gw}:${p2}/`], ['127.0.0.1 -> 0.0.0.0-bound', `http://127.0.0.1:${p2}/`]]) {
    log(`3.curl ${k}`, await runAsync('wsl.exe', ['-d', D, '--exec', 'curl', '-s', '-S', '-m', '4', '--noproxy', '*', u]));
  }
  const u = `http://127.0.0.1:${p1}/`;
  log('3.interop curl.exe -> 127-bound', await runAsync('wsl.exe', ['-d', D, '--exec', '/mnt/c/Windows/System32/curl.exe', '-s', '-S', '-m', '4', '--noproxy', '*', u]));
  log('3.interop curl.exe, stdin body', await runAsync('wsl.exe', ['-d', D, '--exec', 'sh', '-c', `echo '{"a":1}' | /mnt/c/Windows/System32/curl.exe -s -S -m 4 -X POST -d @- ${u}`]));
  const node = process.execPath.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/');
  log('3.interop node.exe fetch -> 127-bound', await runAsync('wsl.exe', ['-d', D, '--exec', node, '-e', `fetch('${u}').then(r=>r.text()).then(console.log,e=>console.log(String(e)))`]));
  const t = performance.now(); for (let i = 0; i < 5; i++) await runAsync('wsl.exe', ['-d', D, '--exec', '/mnt/c/Windows/System32/curl.exe', '-s', '-m', '4', u]);
  log('3.interop curl.exe avg ms (incl. outer wsl.exe)', ms(t) / 5);
  s1.close(); s2.close();
}

async function section1b() {
  inD('rm -rf /root/w2; mkdir -p /root/w2/sub && echo a > /root/w2/f.txt && echo B > /root/w2/F.TXT');
  const dir = `${UNC}\\root\\w2`;
  for (const n of ['f.txt', 'F.TXT', 'sub']) await tryLog(`1b.lstat-bigint ${n}`, () => { const s = fs.lstatSync(`${dir}\\${n}`, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino), mode: s.mode.toString(8), mtimeMs: String(s.mtimeMs) }; });
  log('1b.distro stat', inD('cd /root/w2 && stat -c "%n %d %i" f.txt F.TXT sub').stdout);
  await tryLog('1b.realpath plain file', () => fs.promises.realpath(`${dir}\\f.txt`));
  await tryLog('1b.realpath dir', () => fs.promises.realpath(`${dir}\\sub`));
  await tryLog('1b.realpath.native dir', () => fs.realpathSync.native(`${dir}\\sub`));
  await tryLog('1b.realpath distro root', () => fs.promises.realpath(`${UNC}\\`));
  await tryLog('1b.readdir withFileTypes probe/', () => fs.readdirSync(`${UNC}\\root\\probe`, { withFileTypes: true }).map((d) => `${d.name}:${d.isSymbolicLink() ? 'link' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'}`));
  await tryLog('1b.stat (follow) symlink l', () => fs.statSync(`${UNC}\\root\\probe\\l`).size);
  await tryLog('1b.readFile through symlink l', () => fs.readFileSync(`${UNC}\\root\\probe\\l`, 'utf8'));
  await tryLog('1b.chmod then lstat mode', () => { fs.chmodSync(`${dir}\\f.txt`, 0o755); return fs.lstatSync(`${dir}\\f.txt`).mode.toString(8); });
  await tryLog('1b.writeFile wx on existing', () => { fs.writeFileSync(`${dir}\\f.txt`, 'x', { flag: 'wx' }); return 'no error'; });
  await tryLog('1b.open F.TXT vs f.txt content', () => [fs.readFileSync(`${dir}\\f.txt`, 'utf8'), fs.readFileSync(`${dir}\\F.TXT`, 'utf8')]);
  for (const [k, target] of [['dir no links', dir], ['subdir', `${dir}\\sub`], ['repo root', `${UNC}\\root\\repo`]]) {
    for (const recursive of [false, true]) {
      const events = []; const t0 = performance.now(); let w;
      try { w = fs.watch(target, { recursive }, (e, f) => events.push({ e, f, at: ms(t0) })); w.on('error', (e) => events.push({ error: e.message })); } catch (e) { log(`1b.watch ${k} recursive=${recursive}`, { error: e.message }); continue; }
      await sleep(400); const marks = {};
      marks.win = ms(t0); fs.writeFileSync(`${target}\\win-${recursive}.txt`, 'w'); await sleep(1500);
      const linux = inD(`wslpath -u '${target}'`).stdout.trim();
      marks.distro = ms(t0); inD(`echo d > '${linux}/distro-${recursive}.txt'`); await sleep(1500);
      marks.distroDeep = ms(t0); inD(`mkdir -p '${linux}/deep' && echo d > '${linux}/deep/x-${recursive}.txt'`); await sleep(1500);
      w.close();
      log(`1b.watch ${k} recursive=${recursive}`, { marks, events: events.slice(0, 20), count: events.length });
    }
  }
  const polled = []; const t0 = performance.now();
  fs.watchFile(`${dir}\\f.txt`, { interval: 250 }, (cur) => polled.push({ at: ms(t0), size: cur.size }));
  await sleep(600); const mark = ms(t0); inD('echo more >> /root/w2/f.txt'); await sleep(2000); fs.unwatchFile(`${dir}\\f.txt`);
  log('1b.watchFile polling 250ms', { mark, polled });
}

async function section4() {
  log('4.claude install in distro', inD('curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -4', { timeout: 300000 }));
  log('4.claude by name, non-login sh', inD('command -v claude || echo not-on-PATH; echo $PATH'));
  log('4.claude by name, bash -lc', run('wsl.exe', ['-d', D, '--exec', 'bash', '-lc', 'command -v claude || echo not-on-PATH']));
  log('4.claude by name, bash -ic', run('wsl.exe', ['-d', D, '--exec', 'bash', '-ic', 'command -v claude || echo not-on-PATH']));
  log('4.claude --version', inD('$HOME/.local/bin/claude --version'));
  log('4.claude auth status', inD('$HOME/.local/bin/claude auth status; echo exit=$?'));
  log('4.claude --help auth lines', inD('$HOME/.local/bin/claude --help | grep -i -E "auth|login|token"'));
  log('4.claude files', inD('ls -la $HOME/.claude $HOME/.claude.json 2>&1 | head -20'));
  log('4.gh in distro before install', inD('command -v gh || echo none; command -v gh.exe || echo no-gh.exe'));
  log('4.gh install', inD('apt-get install -y -qq gh >/dev/null 2>&1; gh --version | head -1', { timeout: 300000 }));
  log('4.gh auth status (none)', inD('gh auth status; echo exit=$?'));
  log('4.gh auth status, GH_TOKEN via WSLENV', run('wsl.exe', ['-d', D, '--exec', 'sh', '-c', 'gh auth status 2>&1 | grep -v -i token; echo exit=$?'], { env: { ...process.env, GH_TOKEN: process.env.PROBE_TOKEN ?? '', WSLENV: 'GH_TOKEN' } }));
}

if (mode === 'net') await section3();
else if (mode === 'round2') { await section1b(); await section2(); await section3(); await section4(); }
else { await section1(); await section2(); await section3(); await section4(); }
setTimeout(() => process.exit(0), 1000).unref();
