import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { activeWorkers, configuredTheme, daemonEnv, daemonPort, daemonStatus, DaemonBootError, ensureDaemon, lastLogError, menuLabel, probe, livePtys, setSignal, stopDaemon } from '../src/daemon.js';
import { acquireLock, pidExists, readDaemonSecret, readLockPid, releaseLock, writeDaemonPort, writeDaemonSecret } from '../src/daemon-files.js';
import { hiveHome } from '../src/home.js';
import { createLogger } from '../src/log.js';
import { newSecret, SECRET_HEADER } from '../src/secret.js';
import { combConfig, getFreePort, LOCAL_STAGES } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';
import { bootTracked, killQuietly } from './daemon-boot.js';

// run.js boots hiveHome() of the environment it inherits: each home here is made by pointing this process's XDG_CONFIG_HOME at a fresh
// temp dir first, so the home a test passes is the one the daemon it starts boots, and never the real ~/.config. One file per process.
async function tempHome(t: AfterHost): Promise<string> {
  process.env.XDG_CONFIG_HOME = await tempDir(t, 'daemon-');
  const home = hiveHome();
  await mkdir(home);
  return home;
}

async function homeWithConfig(t: AfterHost, text: string): Promise<string> {
  const home = await tempHome(t);
  await writeFile(join(home, 'hive.config.json'), text);
  return home;
}

// hive.port and a fresh hive.secret (#466, #467): what a running daemon of this home leaves for its clients. Returns the secret.
function record(home: string, port: number): string {
  const secret = newSecret();
  writeDaemonPort(home, port);
  writeDaemonSecret(home, secret);
  return secret;
}

// A home whose hive.port names `port` and whose hive.secret holds a secret (#466, #467): where every client looks for this home's daemon
async function homeOnPort(t: AfterHost, port: number): Promise<string> {
  const home = await tempHome(t);
  record(home, port);
  return home;
}

// A home the real dist/src/run.js boots without gh or claude: a Comb with no source on a temp folder, zero workers; the daemon picks its own port (#466)
async function bootableHome(t: AfterHost, extra: Record<string, unknown> = {}): Promise<{ home: string; repo: string }> {
  const home = await tempHome(t);
  const repo = await tempDir(t, 'daemon-repo-');
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(combConfig({ stages: LOCAL_STAGES, path: repo, maxConcurrent: 0, ...extra })));
  return { home, repo };
}

// An HTTP listener answering `body` to everything: JSON for an object, plain text for a string. Closed after the test.
async function listener(t: TestContext, body: unknown): Promise<number> {
  const server = createHttpServer((_req, res) => {
    const isText = typeof body === 'string';
    res.writeHead(200, { 'content-type': isText ? 'text/plain' : 'application/json' });
    res.end(isText ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  t.after(() => server.close());
  return (server.address() as AddressInfo).port;
}

// Accepts and stays silent: a Hive still booting, or a hung process. Occupied is the safe reading, never free.
async function silentListener(t: TestContext): Promise<number> {
  const server = createNetServer(() => { /* never answers */ });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  t.after(() => server.close());
  return (server.address() as AddressInfo).port;
}

interface Recorded {
  method?: string;
  url?: string;
  ui?: string | string[];
  secret?: string | string[];
  type?: string;
  body: string;
}

// An HTTP listener that records every request and answers `status` with `body` as JSON. Closed after the test.
// With `home`, GET /settings answers as that home's Hive and is not recorded: the clients check who answers before they POST (#466), until
// a POST /stop arrives, which is what stopDaemon waits for.
async function recorder(t: TestContext, status: number, body: unknown, home?: string): Promise<{ port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const stopped = (): boolean => requests.some((r) => r.url === '/stop');
  const server = createHttpServer((req, res) => {
    if (home !== undefined && req.method === 'GET' && req.url === '/settings' && !stopped()) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ home, configured: true }));
      return;
    }
    let text = '';
    req.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, ui: req.headers['x-hive-ui'], secret: req.headers[SECRET_HEADER], type: req.headers['content-type'], body: text });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, requests };
}

const LOCK_FREE_MS = 5000;
const LOCK_RETRY_MS = 50;

// The next boot takes this home's lock (#479). A daemon closes its port before its helper's cat reads the EOF, so the take is retried for a
// while, then released. hive.lock is left naming this process
async function nextBootTakes(home: string): Promise<void> {
  const deadline = Date.now() + LOCK_FREE_MS;
  for (;;) {
    try {
      await acquireLock(home, () => undefined);
      releaseLock(home);
      return;
    } catch (err) {
      if (!/já está em execução/.test(String(err)) || Date.now() > deadline) throw err; // only the lock still held is retried
      await sleep(LOCK_RETRY_MS);
    }
  }
}

// A hive.log line as log.ts writes it: `<ISO> <LEVEL padded to 5> <message>`
const logLine = (level: 'ERROR' | 'INFO', message: string): string => `2026-09-24T10:00:00.000Z ${level.padEnd(5)} ${message}`;
const logText = (...lines: string[]): string => `${lines.join('\n')}\n`;
const BOOT = logLine('INFO', 'boot home=/h workspaces=hive mode=hive');

test('daemonPort reads hive.port: undefined with no file, the recorded port otherwise (#466)', async (t) => {
  const home = await tempHome(t);
  assert.equal(daemonPort(home), undefined, 'no file: no daemon');
  writeDaemonPort(home, 4242);
  assert.equal(daemonPort(home), 4242);
});

test('configuredTheme: the file\'s theme; system without a file, with bad JSON or with anything that is not a theme (#296)', async (t) => {
  for (const theme of ['system', 'light', 'dark']) assert.equal(configuredTheme(await homeWithConfig(t, JSON.stringify({ theme }))), theme, theme);
  assert.equal(configuredTheme(await tempHome(t)), 'system', 'no file: a first launch follows macOS');
  assert.equal(configuredTheme(await homeWithConfig(t, '{ not json')), 'system', 'the daemon reports the file; the window only needs a color');
  for (const text of ['{}', '{ "theme": "sepia" }', '{ "theme": 1 }', '[]', 'null']) assert.equal(configuredTheme(await homeWithConfig(t, text)), 'system', text);
});

test('probe: nothing listening is free; a listener answering { home } is a hive (control characters stripped); any other answer, a repo included, or none within ~1 s, is foreign', async (t) => {
  assert.deepEqual(await probe(await getFreePort(), newSecret()), { status: 'free' });
  assert.deepEqual(await probe(await listener(t, { configured: true, home: '/some/home' }), newSecret()), { status: 'hive', home: '/some/home' });
  assert.deepEqual(await probe(await listener(t, { home: '/x\u001b[31m\u202e' }), newSecret()), { status: 'hive', home: '/x[31m' }, 'no terminal escapes or bidi overrides from a stranger on the port');
  assert.deepEqual(await probe(await listener(t, { configured: true, repo: '/some/repo' }), newSecret()), { status: 'foreign' }, 'the home is the identity now');
  assert.deepEqual(await probe(await listener(t, { configured: false }), newSecret()), { status: 'foreign' });
  assert.deepEqual(await probe(await listener(t, 'nope'), newSecret()), { status: 'foreign' });
  const startedAt = Date.now();
  assert.deepEqual(await probe(await silentListener(t), newSecret()), { status: 'foreign' });
  assert.ok(Date.now() - startedAt < 3000, 'the 1 s timeout, not a hang');
});

test('ensureDaemon boots dist/src/run.js detached on a free port it records in hive.port and resolves with the pid once that port answers for this home; a second call finds it without a pid; stopDaemon ends it, hive.port and hive.lock stay and the next boot takes the lock; hive.log is 0600 and carries the pid; a stop of nothing is false', async (t) => {
  const { home, repo } = await bootableHome(t);
  const started = await bootTracked(t, home);
  const { port } = started;
  assert.equal(daemonPort(home), port, 'hive.port names the port it bound');
  assert.equal(readLockPid(home), started.pid, 'the daemon holds its home');
  assert.notEqual(readDaemonSecret(home), undefined, 'the daemon wrote its secret (#467)');
  assert.equal(started.secret, readDaemonSecret(home), 'the secret it probed the port with, so the viewer pairs the two without reading hive.secret again (#467)');
  assert.equal(typeof started.pid, 'number');
  const info = await (await fetch(`http://127.0.0.1:${port}/settings`, { headers: { [SECRET_HEADER]: readDaemonSecret(home) ?? '' } })).json() as { configured: boolean; home: string };
  assert.equal(info.configured, true);
  assert.equal(info.home, home);
  assert.deepEqual(await ensureDaemon(home), { port, secret: started.secret }, 'already up: nothing spawned, no pid');
  assert.deepEqual(await daemonStatus(home), { state: 'running' }, 'the real daemon, configured');

  assert.equal(await activeWorkers(home), 0, 'zero workers: GET /ptys on the real daemon counts none');
  assert.deepEqual(await livePtys(home), [], 'zero workers: the menu shows no worker line');
  assert.equal(await stopDaemon(home), true);
  assert.deepEqual(await probe(port, newSecret()), { status: 'free' });
  assert.equal(daemonPort(home), port, 'kept after a stop: the next boot tries it first');
  assert.equal(readLockPid(home), started.pid, 'the file stays, naming the stopped daemon (#479)');
  await nextBootTakes(home);
  assert.equal(readLockPid(home), process.pid, 'a clean stop released the lock: the next boot takes it');
  assert.equal(existsSync(join(home, 'hive.secret')), false, 'and its secret (#467)');
  assert.deepEqual(await daemonStatus(home), { state: 'stopped', reason: undefined }, 'the real log: a requested stop is not a failure');
  assert.equal(await stopDaemon(home), false, 'stopping what is stopped is not an error');
  const log = join(home, 'hive.log');
  assert.equal((await stat(log)).mode & 0o777, 0o600, 'the log is only for this user');
  const text = await readFile(log, 'utf8');
  assert.ok(text.includes(`Agent Hive em http://127.0.0.1:${port} (home: ${home}, workspaces: hive, pid ${started.pid})`), text);
  assert.ok(text.includes('stop requested'), text);
  assert.equal(existsSync(join(repo, '.hive')), false, 'the repo gets nothing of the Hive\'s own files (no .git here, so no exclude either)');
});

test('daemonEnv: the parent env plus ELECTRON_RUN_AS_NODE, and HIVE_LOCALE only when the viewer gives a locale; the parent env is not touched (#242)', () => {
  const parent = { PATH: '/usr/bin', LANG: 'C' };
  assert.deepEqual(daemonEnv(parent), { PATH: '/usr/bin', LANG: 'C', ELECTRON_RUN_AS_NODE: '1' }, 'the hive CLI: the Node locale decides');
  assert.deepEqual(daemonEnv(parent, 'pt-BR'), { PATH: '/usr/bin', LANG: 'C', ELECTRON_RUN_AS_NODE: '1', HIVE_LOCALE: 'pt-BR' });
  assert.deepEqual(parent, { PATH: '/usr/bin', LANG: 'C' });
});

test('ensureDaemon with a locale boots a daemon whose system language is that locale\'s, whatever LC_ALL says; without one LC_ALL decides (#242)', async (t) => {
  const saved = process.env.LC_ALL;
  process.env.LC_ALL = 'en_US.UTF-8'; // the Node locale the daemon inherits: English, so only HIVE_LOCALE can make it Portuguese
  t.after(() => {
    if (saved === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = saved;
  });
  const { home } = await bootableHome(t); // no language in the config: the system's decides
  const language = async (port: number): Promise<unknown> => ((await (await fetch(`http://127.0.0.1:${port}/settings`, { headers: { [SECRET_HEADER]: readDaemonSecret(home) ?? '' } })).json()) as { language?: unknown }).language;
  const viewer = await bootTracked(t, home, 'pt-BR');
  assert.equal(await language(viewer.port), 'pt', 'a Hive opened from Finder has no LANG: the viewer\'s locale, not the Node one');
  assert.equal(await stopDaemon(home), true);
  const cli = await bootTracked(t, home);
  assert.equal(await language(cli.port), 'en', 'no HIVE_LOCALE: run.js boots with the Node locale');
  assert.equal(await stopDaemon(home), true);
});

test('a foreign program on the recorded port reads as no daemon: stopDaemon stops nothing, and ensureDaemon starts one on another port and records it; another home\'s Hive or a silent listener is not ours to stop either (#466)', async (t) => {
  const { home } = await bootableHome(t);
  const foreign = await listener(t, 'nope');
  writeDaemonPort(home, foreign);
  assert.equal(await stopDaemon(home), false, 'nothing of ours to stop');
  const started = await bootTracked(t, home);
  assert.notEqual(started.port, foreign);
  assert.equal(daemonPort(home), started.port, 'the new port replaces the taken one');
  assert.equal(await stopDaemon(home), true);

  const other = await listener(t, { configured: true, home: '/other' });
  assert.equal(await stopDaemon(await homeOnPort(t, other)), false);
  assert.equal(await stopDaemon(await homeOnPort(t, await silentListener(t))), false, 'a listener that never answers is not a Hive');
});

test('with no hive.port, or one whose port refuses, nothing is running: stopDaemon false, activeWorkers 0, livePtys [], daemonStatus stopped; setSignal with no port is refused (#466)', async (t) => {
  const none = await tempHome(t);
  const refused = await homeOnPort(t, await getFreePort()); // a daemon that died without a clean stop: the file stays behind
  for (const home of [none, refused]) {
    assert.equal(await stopDaemon(home), false);
    assert.equal(await activeWorkers(home), 0);
    assert.deepEqual(await livePtys(home), []);
    assert.deepEqual(await daemonStatus(home), { state: 'stopped', reason: undefined });
  }
  await assert.rejects(setSignal(none, 'red'), { message: 'Agent Hive não está em execução' });
});

test('activeWorkers: 0 when nothing of ours answers, another home\'s Hive included; our Hive\'s count from GET /ptys; a throw when ours gives no count (#193, #466)', async (t) => {
  const idle = await homeOnPort(t, await getFreePort());
  assert.equal(await activeWorkers(idle), 0, 'nothing running: nothing to stop, no dialog');

  // listener() answers every path alike: /settings names this home (the probe), /ptys carries the count
  const home = await tempHome(t);
  const ours = await listener(t, { configured: true, home, active: 2 });
  record(home, ours);
  assert.equal(await activeWorkers(home), 2);

  const other = await listener(t, { configured: true, home: '/other' });
  assert.equal(await activeWorkers(await homeOnPort(t, other)), 0, 'another home\'s Hive is not ours to count');

  const silentHome = await tempHome(t);
  const mute = await listener(t, { configured: true, home: silentHome }); // ours, but an answer without a count (an older build)
  record(silentHome, mute);
  await assert.rejects(activeWorkers(silentHome), { message: 'o Hive não informou as execuções e os terminais: HTTP 200' });
});

test('livePtys: [] when nothing listens; our Hive\'s list from GET /ptys; a throw when ours gives no list (#192)', async (t) => {
  const idle = await homeOnPort(t, await getFreePort());
  assert.deepEqual(await livePtys(idle), [], 'nothing running: the menu opens with no worker line');

  // listener() answers every path alike: /settings names this home (the probe), /ptys carries the list
  const ptys = [{ id: 'W1', taskId: 'I1', status: 'working', label: '#1 Task 1' }];
  const home = await tempHome(t);
  const ours = await listener(t, { configured: true, home, active: 1, ptys });
  record(home, ours);
  assert.deepEqual(await livePtys(home), ptys);

  const olderHome = await tempHome(t);
  const older = await listener(t, { configured: true, home: olderHome, active: 1 }); // ours, but a #193 build: a count and no list
  record(olderHome, older);
  await assert.rejects(livePtys(olderHome), { message: 'o Hive não informou as execuções e os terminais: HTTP 200' });

  const oddHome = await tempHome(t); // a line without a label or with an unknown status: the whole list is refused, not half-drawn
  const odd = await listener(t, { configured: true, home: oddHome, active: 1, ptys: [{ id: 'W1', taskId: 'I1', status: 'empty' }] });
  record(oddHome, odd);
  await assert.rejects(livePtys(oddHome), { message: 'o Hive não informou as execuções e os terminais: HTTP 200' });

  const bidiHome = await tempHome(t); // an issue title with bidi overrides cannot disguise a line of the OS menu
  const bidi = await listener(t, { configured: true, home: bidiHome, active: 1, ptys: [{ ...ptys[0], label: '#1 ‮yawA​ Task' }] });
  record(bidiHome, bidi);
  assert.deepEqual(await livePtys(bidiHome), [{ ...ptys[0], label: '#1 yawA Task' }]);
});

test('livePtys accepts a line with no taskId, a workspace\'s terminal (#292), and still refuses a taskId that is not a string', async (t) => {
  const ptys = [{ id: 'W1', taskId: 'I1', status: 'working', label: '#1 Task 1' }, { id: 'W2', status: 'terminal', label: 'hive' }];
  const home = await tempHome(t);
  const ours = await listener(t, { configured: true, home, active: 2, ptys });
  record(home, ours);
  assert.deepEqual(await livePtys(home), ptys);

  const oddHome = await tempHome(t);
  const odd = await listener(t, { configured: true, home: oddHome, active: 1, ptys: [{ id: 'W2', taskId: 7, status: 'terminal', label: 'hive' }] });
  record(oddHome, odd);
  await assert.rejects(livePtys(oddHome), { message: 'o Hive não informou as execuções e os terminais: HTTP 200' });
});

test('ensureDaemon rejects with the log tail when the daemon exits before answering, and records no port', async (t) => {
  const { home } = await bootableHome(t, { stages: 'nope' }); // comb.stages is not an array: a Comb file that fails to parse is fatal, run.js exits 1
  // bootTracked kills the child either way: had the boot wrongly succeeded, the daemon must still not outlive the test (#786)
  const err = await bootTracked(t, home).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof DaemonBootError, 'a typed error: the caller reads the pid it must not leave behind (#786)');
  assert.match(err.message, /^Agent Hive não subiu \(veja .*hive\.log\)\n/);
  assert.match(err.message, /"comb\.stages" must be a non-empty array/, 'the log tail is the diagnosis');
  assert.equal(typeof err.pid, 'number', 'the child it spawned');
  assert.ok(err.pid !== undefined && !pidExists(err.pid), 'that child exited: the pid is the child\'s, not this process\'s');
  assert.equal(daemonPort(home), undefined, 'it never bound');
  await nextBootTakes(home); // the failed boot released its lock (#479)
  assert.equal(existsSync(join(home, 'hive.secret')), false, 'the failed boot removed its secret (#467)');
});

test('lastLogError: the last ERROR after the last boot line; none without one, after a requested stop, or before that boot; the whole file without a boot line; control and format characters stripped (#194)', () => {
  assert.equal(lastLogError(logText(logLine('ERROR', 'old run'), BOOT, logLine('ERROR', 'first'), logLine('INFO', 'poll'), logLine('ERROR', 'last'))), 'last');
  assert.equal(lastLogError(logText(BOOT, logLine('INFO', 'poll'))), undefined, 'a run without an ERROR');
  assert.equal(lastLogError(logText(BOOT, logLine('ERROR', 'gh failed'), logLine('INFO', 'stop requested'))), undefined, 'a requested stop is not a failure');
  assert.equal(lastLogError(logText(logLine('ERROR', 'before the boot'), BOOT, logLine('INFO', 'poll'))), undefined, 'an earlier run\'s error is not this one\'s');
  assert.equal(lastLogError(logText(logLine('ERROR', 'no boot line'), logLine('INFO', 'poll'))), 'no boot line', 'a rotated log without its boot line: the whole file');
  assert.equal(lastLogError(logText(BOOT, logLine('INFO', 'task ERROR title'))), undefined, 'only the level tag counts, not the word in a message');
  assert.equal(lastLogError(logText(BOOT, logLine('ERROR', 'gh: \u001b[31mboom‮!'))), 'gh: [31mboom!', 'no escapes or bidi overrides in an OS menu line');
  assert.equal(lastLogError(''), undefined);
});

test('daemonStatus: stopped when nothing of ours answers, a foreign listener or another home\'s Hive included; running for our Hive; setup with the fallback error, or with none (#194, #466)', async (t) => {
  assert.deepEqual(await daemonStatus(await homeOnPort(t, await getFreePort())), { state: 'stopped', reason: undefined }, 'no hive.log: no reason');

  // listener() answers every path alike: /settings names this home (the probe) and carries configured / error (the status)
  const home = await tempHome(t);
  const ours = await listener(t, { configured: true, home });
  record(home, ours);
  assert.deepEqual(await daemonStatus(home), { state: 'running' });

  const setupHome = await tempHome(t);
  const setup = await listener(t, { configured: false, home: setupHome, error: 'hive.config.json: "comb" is required\u001b[2J' });
  record(setupHome, setup);
  assert.deepEqual(await daemonStatus(setupHome), { state: 'setup', reason: 'hive.config.json: "comb" is required[2J' });

  const bareHome = await tempHome(t);
  const bare = await listener(t, { configured: false, home: bareHome }); // setup mode without a file: nothing went wrong
  record(bareHome, bare);
  assert.deepEqual(await daemonStatus(bareHome), { state: 'setup', reason: undefined });

  const foreign = await listener(t, 'nope');
  assert.deepEqual(await daemonStatus(await homeOnPort(t, foreign)), { state: 'stopped', reason: undefined });
  const other = await listener(t, { configured: true, home: '/other' });
  assert.deepEqual(await daemonStatus(await homeOnPort(t, other)), { state: 'stopped', reason: undefined });
});

test('daemonStatus on a free port: stopped, with the last ERROR hive.log has after its last boot as the reason (#194)', async (t) => {
  const home = await homeOnPort(t, await getFreePort());
  const log = createLogger(home, 'info', { stderr: () => {} }); // the real line format, not a hand-written copy
  log.info(`boot home=${home} workspaces=hive mode=hive`);
  log.error('poll failed: gh: HTTP 502');
  assert.deepEqual(await daemonStatus(home), { state: 'stopped', reason: 'poll failed: gh: HTTP 502' });
});

test('menuLabel: a long task label is cut at the last space within 35 characters, with an ellipsis (#243)', () => {
  assert.equal(menuLabel('#194 Menu bar shows whether the daemon is running, with a restart'), '#194 Menu bar shows whether the…');
  assert.equal(menuLabel('#12 Fix the login'), '#12 Fix the login');
  assert.equal(menuLabel(`#1 ${'x'.repeat(40)}`), `#1 ${'x'.repeat(31)}…`);
  assert.equal(menuLabel(`#1 ${'a'.repeat(31)}, b`), `#1 ${'a'.repeat(31)}…`);
  assert.equal(menuLabel(`#1 ${'a'.repeat(30)}😀 tail past the limit`), `#1 ${'a'.repeat(30)}…`);
  assert.ok(menuLabel('#194 Menu bar shows whether the daemon is running').length <= 35);
});

test('setSignal: POSTs { signal } with the x-hive-ui header and the secret hive.secret holds to the port hive.port names once our Hive answers there; a refusal rejects with the daemon\'s error text, or with the status when it has none (#196, #466, #467)', async (t) => {
  const signalTo = async (status: number, body: unknown): Promise<{ home: string; requests: Recorded[]; secret: string }> => {
    const home = await tempHome(t);
    const { port, requests } = await recorder(t, status, body, home);
    const secret = record(home, port);
    return { home, requests, secret };
  };
  const ok = await signalTo(200, { ok: true });
  await setSignal(ok.home, 'red');
  assert.deepEqual(ok.requests, [{ method: 'POST', url: '/signal', ui: '1', secret: ok.secret, type: 'application/json', body: '{"signal":"red"}' }]);

  const setup = await signalTo(409, { error: 'Hive não configurado: salve as configurações primeiro' }); // requireLive in setup mode
  await assert.rejects(setSignal(setup.home, 'green'), { message: 'Hive não configurado: salve as configurações primeiro' });

  const bare = await signalTo(500, 'nope'); // no error field to show
  await assert.rejects(setSignal(bare.home, 'green'), { message: 'Agent Hive recusou o sinal: HTTP 500' });
});

test('setSignal: a stale hive.port now held by something else is refused as not running, and nothing is POSTed there (#466)', async (t) => {
  const foreign = await recorder(t, 200, { ok: true }); // answers /settings with no home: not ours
  await assert.rejects(setSignal(await homeOnPort(t, foreign.port), 'green'), { message: 'Agent Hive não está em execução' });
  assert.ok(foreign.requests.every((r) => r.method !== 'POST'), 'no signal reached the foreign listener');
});

test('two ensureDaemon calls at once bring up one daemon: the child that loses the lock exits, and its call waits for the winner (#466)', async (t) => {
  const { home } = await bootableHome(t);
  t.after(() => killQuietly(readLockPid(home))); // the winner, even when its call returned no pid
  // allSettled, not all: a call that rejects first must not drop the other call's pid; bootTracked registered both kills already (#786)
  const settled = await Promise.allSettled([bootTracked(t, home), bootTracked(t, home)]);
  const [a, b] = settled.map((s) => {
    if (s.status === 'rejected') throw s.reason; // the boot's own error, log tail included
    return s.value;
  });
  assert.equal(a.port, b.port, 'one daemon: both calls answer its port');
  assert.equal(daemonPort(home), a.port);
  const winner = readLockPid(home);
  assert.ok(winner !== undefined && (winner === a.pid || winner === b.pid), 'the lock names the daemon one of the calls started');
  assert.equal(await stopDaemon(home), true);
});

test('probe sends the secret it is given and reads a 403 as foreign, whatever the body says: a Hive whose secret is not the one recorded here (#467)', async (t) => {
  const secret = newSecret();
  const open = await recorder(t, 200, { configured: true, home: '/some/home' });
  assert.deepEqual(await probe(open.port, secret), { status: 'hive', home: '/some/home' });
  assert.equal(open.requests[0].secret, secret);
  const refusing = await recorder(t, 403, { error: 'segredo inválido', home: '/some/home' });
  assert.deepEqual(await probe(refusing.port, secret), { status: 'foreign' }, 'a boot that is not the one on the port');
});

test('stopDaemon POSTs /stop with the ui header and the secret of hive.secret; a home with hive.port but no hive.secret has no daemon, and nothing is sent (#467)', async (t) => {
  const home = await tempHome(t);
  const ours = await recorder(t, 200, { ok: true }, home);
  const secret = record(home, ours.port);
  assert.equal(await stopDaemon(home), true);
  assert.deepEqual(ours.requests.filter((r) => r.method === 'POST').map((r) => [r.url, r.ui, r.secret]), [['/stop', '1', secret]]);

  const bare = await tempHome(t);
  const other = await recorder(t, 200, { ok: true }, bare);
  writeDaemonPort(bare, other.port); // no hive.secret: a daemon that removed it on its stop, or a boot that never got that far
  assert.equal(await stopDaemon(bare), false);
  await assert.rejects(setSignal(bare, 'red'), { message: 'Agent Hive não está em execução' });
  assert.equal(await activeWorkers(bare), 0);
  assert.deepEqual(other.requests, [], 'not even the probe: without the secret there is nobody to ask');
});
